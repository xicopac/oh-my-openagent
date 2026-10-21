import type { ModelRoutingConfig } from "../config/schema"
import {
  createGovernanceAuditWriter,
  type GovernanceAuditWriter,
  type PaidModelGateAuditEvent,
} from "../shared/governance-audit"
import {
  decidePaidModelUse,
  type PaidModelGateDecision,
} from "../shared/paid-model-approvals"
import { log } from "../shared/logger"

/**
 * AUTHORITATIVE MASTER MODEL + PAID-MODEL DISPATCH GATE.
 *
 * The root/master session model is OpenCode's top-level `config.model`. OMO
 * carries an explicit master tier in `~/.omo/omo.jsonc`
 * (`model_routing.tiers.master`). Before this module that tier only shaped
 * delegated children (`model_tier: "master"`) and never the root session. That
 * mismatch is why "fixing" the master model in omo.jsonc appeared to revert:
 * the real default kept coming from `opencode.json`, so any regeneration or
 * stale copy of that file silently restored an old model.
 *
 * The single source of truth for the master default is:
 *
 *   [opencode].model_routing.tiers.master = { model, inherit_parent: false }
 *
 * `resolveConfiguredMasterModel` is pure so it can be regression-tested without
 * a plugin runtime. `applyConfiguredMasterModel` mutates the OpenCode config in
 * place at config-load time, on every server start, so restart, new shell, new
 * tmux session, compaction, watchdog recovery, and config regeneration all
 * converge on the same model. It is a no-op when no explicit master pin exists.
 *
 * PAID GATE: because this path can dispatch a paid model before any session or
 * interactive operator exists, the configured model is passed through
 * `decidePaidModelUse`. A paid (or unknown-cost) master requires an exact
 * entry in `~/.omo/paid-model-approvals.json`; absent that, the gate applies
 * the free equivalent instead of the paid model, or fails closed. Every paid
 * decision emits one audit event.
 */

const MASTER_MODEL_AUTHORITY_AUDIT_SESSION = "master-model-authority"

export type MasterModelAuthorityOptions = {
  /** Override approval-file location (tests). Defaults to `~/.omo/...`. */
  approvalsPath?: string
  /** Free equivalent; `null` disables fallback and fails closed. */
  freeFallbackModel?: string | null
  /** Injectable audit sink (tests); defaults to the governance journal. */
  audit?: Pick<GovernanceAuditWriter, "write">
  /** Journal session segment for config-load audit events. */
  auditSessionID?: string
}

export function resolveConfiguredMasterModel(
  modelRouting: ModelRoutingConfig | undefined,
): string | undefined {
  const master = modelRouting?.tiers?.master
  if (!master) return undefined
  if (master.inherit_parent !== false) return undefined
  const model = master.model
  if (typeof model !== "string") return undefined
  const trimmed = model.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function applyModel(config: Record<string, unknown>, model: string): string {
  const previous = typeof config.model === "string" ? config.model : undefined
  if (previous === model) return model
  config.model = model
  log("[master-model-authority] applied master model", {
    model,
    previous: previous ?? null,
  })
  return model
}

function emitDecision(
  options: MasterModelAuthorityOptions,
  event: PaidModelGateAuditEvent,
  fields: Record<string, unknown>,
): void {
  const session = options.auditSessionID ?? MASTER_MODEL_AUTHORITY_AUDIT_SESSION
  const payload = { subsystem: "paid_model_gate", event, ...fields }
  if (options.audit) {
    options.audit.write(session, payload)
    return
  }
  try {
    createGovernanceAuditWriter({}).write(session, payload)
  } catch {
    // Audit is defense-in-depth; never block config load on a journal failure.
  }
}

function auditDecision(
  decision: PaidModelGateDecision,
  options: MasterModelAuthorityOptions,
): void {
  if (decision.action === "allow_free") return
  if (decision.action === "allow_approved_paid") {
    emitDecision(options, "paid_model_approved_use", {
      requested_model: decision.model,
      applied_model: decision.model,
      approved_by: decision.approval.approvedBy,
      approved_at: decision.approval.approvedAt,
    })
    return
  }
  if (decision.action === "deny_fallback") {
    emitDecision(options, "paid_model_denied_fallback", {
      requested_model: decision.requestedModel,
      applied_model: decision.fallbackModel,
      reason: decision.reason,
      detail: decision.detail,
    })
    return
  }
  emitDecision(options, "paid_model_denied_error", {
    requested_model: decision.requestedModel,
    applied_model: null,
    reason: decision.reason,
    detail: decision.message,
  })
}

export function applyConfiguredMasterModel(
  config: Record<string, unknown>,
  pluginConfig: { model_routing?: ModelRoutingConfig } | undefined,
  options: MasterModelAuthorityOptions = {},
): string | undefined {
  const configured = resolveConfiguredMasterModel(pluginConfig?.model_routing)
  if (!configured) return undefined

  const decision = decidePaidModelUse({
    requestedModel: configured,
    approvalsPath: options.approvalsPath,
    freeFallbackModel: options.freeFallbackModel,
  })
  auditDecision(decision, options)

  if (decision.action === "allow_free" || decision.action === "allow_approved_paid") {
    return applyModel(config, configured)
  }

  if (decision.action === "deny_fallback") {
    log("[master-model-authority] paid master denied; using free fallback", {
      requested: decision.requestedModel,
      fallback: decision.fallbackModel,
      reason: decision.reason,
    })
    return applyModel(config, decision.fallbackModel)
  }

  log("[master-model-authority] paid master denied; failing closed", {
    requested: decision.requestedModel,
    reason: decision.reason,
    detail: decision.message,
  })
  return undefined
}
