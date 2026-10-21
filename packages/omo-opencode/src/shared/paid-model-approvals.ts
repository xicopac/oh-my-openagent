import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * PAID-MODEL APPROVAL FILE.
 *
 * The governance invariant is "never launch a paid model without explicit
 * human approval". This module makes that structural for model-resolution
 * paths that cannot reach an interactive operator (the authoritative master
 * model is applied at config-load time, before any session exists):
 *
 *   ~/.omo/paid-model-approvals.json
 *   {
 *     "version": 1,
 *     "approved": [
 *       { "model": "provider/model", "approvedBy": "who",
 *         "approvedAt": "ISO-8601", "reason": "why" }
 *     ]
 *   }
 *
 * Only models that are PROVABLY free are allowed without an entry. "Provably"
 * means an explicit known-free id or the conventional `-free` / `:free`
 * suffix. Unknown cost is treated as paid (fail closed), never assumed cheap.
 *
 * The decision function is pure apart from the injected/default file path so
 * tests can use temp-HOME fixtures and never dispatch a real model.
 */

export const PAID_MODEL_APPROVALS_VERSION = 1
export const PAID_MODEL_APPROVALS_FILENAME = "paid-model-approvals.json"

/** Free equivalent used when a paid master is denied. */
export const DEFAULT_FREE_FALLBACK_MODEL = "opencode/deepseek-v4.1-flash-free"

const KNOWN_FREE_MODELS = new Set([
  "opencode/nemotron-3.5-lightning-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/deepseek-v4.1-flash-free",
])

export type PaidModelApproval = {
  model: string
  approvedBy: string
  approvedAt: string
  reason: string
}

export type PaidModelApprovalsFile = {
  version: typeof PAID_MODEL_APPROVALS_VERSION
  approved: PaidModelApproval[]
}

export type PaidModelApprovalsSnapshot =
  | { status: "ok"; path: string; approvals: PaidModelApproval[] }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; error: string }

export function resolvePaidModelApprovalsPath(homeDirectory?: string): string {
  // Read HOME at call time (not import time) so a process-level temp HOME
  // fixture is honored. `os.homedir()` can be cached by the runtime.
  const home = homeDirectory ?? process.env.HOME?.trim() ?? homedir()
  return join(home.length > 0 ? home : homedir(), ".omo", PAID_MODEL_APPROVALS_FILENAME)
}

/**
 * A model is allowed without approval only when its zero cost is provable from
 * its id. Anything else (including an unknown model) is treated as paid.
 */
export function isProvablyFreeModel(model: string | null | undefined): boolean {
  if (typeof model !== "string") return false
  const trimmed = model.trim()
  if (trimmed.length === 0) return false
  if (KNOWN_FREE_MODELS.has(trimmed)) return true
  const slash = trimmed.indexOf("/")
  const modelId = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  return modelId.endsWith("-free") || modelId.endsWith(":free")
}

function normalizeApproval(value: unknown): PaidModelApproval | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const model = typeof record.model === "string" ? record.model.trim() : ""
  const approvedBy = typeof record.approvedBy === "string" ? record.approvedBy.trim() : ""
  const approvedAt = typeof record.approvedAt === "string" ? record.approvedAt.trim() : ""
  const reason = typeof record.reason === "string" ? record.reason.trim() : ""
  if (model.length === 0 || approvedBy.length === 0 || approvedAt.length === 0) return undefined
  if (Number.isNaN(Date.parse(approvedAt))) return undefined
  return { model, approvedBy, approvedAt, reason }
}

export function readPaidModelApprovals(
  path: string = resolvePaidModelApprovalsPath(),
): PaidModelApprovalsSnapshot {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === "ENOENT") return { status: "missing", path }
    return {
      status: "invalid",
      path,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      status: "invalid",
      path,
      error: error instanceof Error ? error.message : "invalid JSON",
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { status: "invalid", path, error: "approval file must be a JSON object" }
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== PAID_MODEL_APPROVALS_VERSION) {
    return {
      status: "invalid",
      path,
      error: `unsupported approval file version: ${String(record.version)}`,
    }
  }
  if (!Array.isArray(record.approved)) {
    return { status: "invalid", path, error: "approval file must contain an approved[] array" }
  }

  const approvals = record.approved
    .map(normalizeApproval)
    .filter((entry): entry is PaidModelApproval => entry !== undefined)

  return { status: "ok", path, approvals }
}

export type PaidModelApprovalDenyReason =
  | "approval_file_missing"
  | "approval_file_invalid"
  | "approval_not_found"

export type PaidModelGateDecision =
  | { action: "allow_free"; model: string }
  | { action: "allow_approved_paid"; model: string; approval: PaidModelApproval }
  | {
      action: "deny_fallback"
      requestedModel: string
      fallbackModel: string
      reason: PaidModelApprovalDenyReason
      detail: string
    }
  | {
      action: "deny_error"
      requestedModel: string
      reason: "no_free_fallback" | "fallback_not_free"
      approvalReason: PaidModelApprovalDenyReason
      message: string
    }

export type DecidePaidModelUseInput = {
  requestedModel: string
  /** Test/consumer override; when omitted the file is read from disk. */
  approvals?: PaidModelApprovalsSnapshot
  approvalsPath?: string
  /**
   * Free equivalent to use when the paid model is denied. Omit for the
   * default free DeepSeek equivalent; pass `null` to fail closed instead.
   */
  freeFallbackModel?: string | null
}

function denyReasonFor(snapshot: PaidModelApprovalsSnapshot): PaidModelApprovalDenyReason {
  if (snapshot.status === "missing") return "approval_file_missing"
  if (snapshot.status === "invalid") return "approval_file_invalid"
  return "approval_not_found"
}

function denyDetailFor(snapshot: PaidModelApprovalsSnapshot): string {
  if (snapshot.status === "missing") return `no approval file at ${snapshot.path}`
  if (snapshot.status === "invalid") return `approval file is invalid: ${snapshot.error}`
  return `no approved entry for this model in ${snapshot.path}`
}

/**
 * Decide whether `requestedModel` may be dispatched. Paid/unknown models need
 * an exact, well-formed approval entry; otherwise the decision is either a
 * free fallback or a hard error (never a paid allow).
 */
export function decidePaidModelUse(input: DecidePaidModelUseInput): PaidModelGateDecision {
  const requestedModel = input.requestedModel.trim()
  if (isProvablyFreeModel(requestedModel)) {
    return { action: "allow_free", model: requestedModel }
  }

  const snapshot =
    input.approvals ?? readPaidModelApprovals(input.approvalsPath ?? resolvePaidModelApprovalsPath())

  if (snapshot.status === "ok") {
    const approval = snapshot.approvals.find((entry) => entry.model === requestedModel)
    if (approval) return { action: "allow_approved_paid", model: requestedModel, approval }
  }

  const reason = denyReasonFor(snapshot)
  const detail = denyDetailFor(snapshot)
  const fallbackInput =
    input.freeFallbackModel === undefined ? DEFAULT_FREE_FALLBACK_MODEL : input.freeFallbackModel
  const fallbackModel = typeof fallbackInput === "string" ? fallbackInput.trim() : ""

  if (fallbackModel.length === 0) {
    return {
      action: "deny_error",
      requestedModel,
      reason: "no_free_fallback",
      approvalReason: reason,
      message: `PAID_MODEL_APPROVAL_REQUIRED: refusing paid model "${requestedModel}" (${detail}) and no free fallback is configured.`,
    }
  }

  if (!isProvablyFreeModel(fallbackModel)) {
    return {
      action: "deny_error",
      requestedModel,
      reason: "fallback_not_free",
      approvalReason: reason,
      message: `PAID_MODEL_APPROVAL_REQUIRED: refusing paid model "${requestedModel}" (${detail}); configured fallback "${fallbackModel}" is not provably free.`,
    }
  }

  return { action: "deny_fallback", requestedModel, fallbackModel, reason, detail }
}
