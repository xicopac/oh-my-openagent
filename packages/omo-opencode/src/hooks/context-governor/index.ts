import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ContextLimitModelCacheState } from "@oh-my-opencode/model-core"
import { resolveActualContextLimit } from "@oh-my-opencode/model-core"

import type { OhMyOpenCodeConfig } from "../../config"
import {
  DEFAULT_CONTEXT_GOVERNOR_CONFIG,
  type ContextGovernorConfig,
} from "../../config/schema/context-governor"
import { writeAtomicText } from "../../shared/atomic-fs"
import { getContextWindowUsage, invalidateContextWindowUsageCache } from "../../shared/context-window-usage"
import { resolveMessageEventSessionID, resolveSessionEventID } from "../../shared/event-session-id"
import type { GovernanceAuditWriter } from "../../shared/governance-audit"
import { log } from "../../shared/logger"

import { encodeSessionId, readCapsule } from "./capsule-store"
import {
  evaluateGovernorDecision,
  leaseExpired,
  type EvaluateGovernorDecisionInput,
  type GovernorDecision,
  type GovernorPhase,
} from "./governor"
import {
  createLeaseStore,
  type LeaseRecord,
  type RetainedRange,
} from "./lease-store"
import { resolveEffectiveThresholds, type EffectiveThresholds } from "./threshold-policy"
import type { VerifierVerdict } from "./verdict"

export { encodeSessionId } from "./capsule-store"
export { evaluateGovernorDecision, leaseExpired } from "./governor"
export type {
  EvaluateGovernorDecisionInput,
  GovernorDecision,
  GovernorPhase,
} from "./governor"

const COMPACTION_TIMEOUT_MS = 60_000
const CAPSULE_STALENESS_GRACE = 5
const MIN_PASS_REDUCTION_TOKENS = 1_000

declare function setTimeout(handler: () => void, timeout?: number): unknown
declare function clearTimeout(timeoutID: unknown): void

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let timeoutID: unknown
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutID = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
  })
  return await Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutID)
  })
}

export type GovernorSignalBus = {
  wake: (sessionID: string, kind: "maintain" | "validate") => void
}

const NOOP_SIGNAL_BUS: GovernorSignalBus = { wake: () => {} }

export type ContextGovernorEventName =
  | "assessment"
  | "enter_expansion"
  | "continue_expansion"
  | "compact"

export type ContextGovernorDecisionClass =
  | "none"
  | "distill"
  | "audit"
  | "compact"
  | "expansion"
  | "defer"

export function classifyDecision(decision: GovernorDecision): ContextGovernorDecisionClass {
  switch (decision.kind) {
    case "prepare":
      return "distill"
    case "audit":
      return "audit"
    case "compact":
    case "compact_degraded":
    case "force_compact":
      return "compact"
    case "defer_lease":
    case "renew_lease":
      return "expansion"
    case "defer_no_capsule":
      return "defer"
    case "none":
      return "none"
  }
}

function eventNameFor(classification: ContextGovernorDecisionClass): ContextGovernorEventName {
  switch (classification) {
    case "compact":
      return "compact"
    case "expansion":
      return "continue_expansion"
    default:
      return "assessment"
  }
}

type LeaseMeta = {
  turns_since_grant: number
  tokens_since_grant: number
  grant_usage: number
}

type GovernorSessionState = {
  phase: GovernorPhase
  providerID: string | null
  modelID: string | null
  lastUsedTokens: number
  verdict: VerifierVerdict | null
  lease_meta: LeaseMeta
  last_audit_error: string | null
  lastEffective: EffectiveThresholds | null
  entered_at_tokens: number | null
  next_reassessment_tokens: number | null
  turns_since_assessment: number
  last_assessment: {
    decision: GovernorDecision["kind"]
    classification: ContextGovernorDecisionClass
    reason: string
    context_tokens: number
    ts: string
  } | null
}

function initialState(): GovernorSessionState {
  return {
    phase: "idle",
    providerID: null,
    modelID: null,
    lastUsedTokens: 0,
    verdict: null,
    lease_meta: { turns_since_grant: 0, tokens_since_grant: 0, grant_usage: 0 },
    last_audit_error: null,
    lastEffective: null,
    entered_at_tokens: null,
    next_reassessment_tokens: null,
    turns_since_assessment: 0,
    last_assessment: null,
  }
}

const blockedByGovernor = new Set<string>()

export function isCompactionBlockedByGovernor(sessionID: string): boolean {
  return blockedByGovernor.has(sessionID)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mapAnchorRanges(verdict: VerifierVerdict): RetainedRange[] {
  if (verdict.verdict !== "CONTEXT_LEASE_REQUIRED") return []
  const anchors = verdict.anchors ?? []
  const ranges: RetainedRange[] = []
  for (const anchor of anchors) {
    const range = anchor.range
    if (!range) continue
    if (typeof range.from !== "number" || typeof range.to !== "number") continue
    ranges.push({
      from: range.from,
      to: range.to,
      label: range.label ?? "",
    })
  }
  return ranges
}

function appendAuditLine(
  directory: string,
  sessionID: string,
  entry: Record<string, unknown>,
): void {
  const wakesPath = join(
    directory,
    ".omo/context-twin",
    encodeSessionId(sessionID),
    "wakes.ndjson",
  )
  let existing = ""
  try {
    existing = readFileSync(wakesPath, "utf-8")
  } catch {
    existing = ""
  }
  const suffix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n"
  writeAtomicText(wakesPath, `${existing}${suffix}${JSON.stringify(entry)}\n`)
}

export type ContextGovernorHookDeps = {
  pluginConfig: OhMyOpenCodeConfig
  modelCacheState?: ContextLimitModelCacheState
  directory?: () => string
  signalBus?: GovernorSignalBus
  now?: () => Date
  onEvent?: (
    sessionID: string,
    event: ContextGovernorEventName,
    detail: Record<string, unknown>,
  ) => void
  audit?: GovernanceAuditWriter
}

export type ContextGovernorDiagnostic = {
  enabled: boolean
  phase: GovernorPhase
  measured_context_tokens: number | null
  preferred_tokens: number | null
  prepare_threshold: number | null
  compaction_target: number | null
  non_compressible_baseline: number | null
  latest_assessment: GovernorSessionState["last_assessment"]
  latest_decision: string | null
  next_reassessment_tokens: number | null
  turns_since_assessment: number
  audit_journal_path: string | null
}

export type ContextGovernorHook = {
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>
  ingestVerdict: (
    sessionID: string,
    verdictOrError: VerifierVerdict | { error: string },
  ) => void
  "tool.execute.after": (
    input: { tool: string; sessionID: string; callID: string },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>
  diagnose: (sessionID: string) => ContextGovernorDiagnostic
}

export function createContextGovernorHook(
  ctx: PluginInput,
  deps: ContextGovernorHookDeps,
): ContextGovernorHook {
  const state = new Map<string, GovernorSessionState>()
  const compactionInProgress = new Set<string>()
  const signalBus = deps.signalBus ?? NOOP_SIGNAL_BUS
  const nowFn = deps.now ?? (() => new Date())
  const onEvent = deps.onEvent ?? (() => {})
  const audit = deps.audit

  function auditEvent(sessionID: string, event: string, fields: Record<string, unknown> = {}): void {
    audit?.write(sessionID, { subsystem: "context_governor", event, ...fields })
  }

  function resolveConfig(): ContextGovernorConfig {
    return deps.pluginConfig.context_governor ?? DEFAULT_CONTEXT_GOVERNOR_CONFIG
  }
  const resolveDirectory = deps.directory ?? (() => (ctx as unknown as { directory: string }).directory)
  const leaseStoreCache = new Map<string, ReturnType<typeof createLeaseStore>>()

  function getLeaseStore(): ReturnType<typeof createLeaseStore> {
    const dir = resolveDirectory()
    const cached = leaseStoreCache.get(dir)
    if (cached) return cached
    const created = createLeaseStore(dir)
    leaseStoreCache.set(dir, created)
    return created
  }

  function getOrInitState(sessionID: string): GovernorSessionState {
    let s = state.get(sessionID)
    if (!s) {
      s = initialState()
      state.set(sessionID, s)
      auditEvent(sessionID, "session_init", { enabled: resolveConfig().enabled === true })
    }
    return s
  }

  function isCapsuleFresh(sessionID: string, currentSeq: number): boolean {
    try {
      const capsule = readCapsule(resolveDirectory(), sessionID)
      if (!capsule) return false
      const cursorSeq = capsule.transcript_cursor.last_entry_seq
      return currentSeq - cursorSeq <= CAPSULE_STALENESS_GRACE
    } catch {
      return false
    }
  }

  async function summarizeOnce(
    sessionID: string,
    sessionState: GovernorSessionState,
  ): Promise<void> {
    const summarizePromise = ctx.client.session.summarize({
      path: { id: sessionID },
      body: {
        providerID: sessionState.providerID as string,
        modelID: sessionState.modelID as string,
      },
      query: { directory: resolveDirectory() },
    })
    await withTimeout(
      summarizePromise,
      COMPACTION_TIMEOUT_MS,
      `Governor compaction summarize timed out after ${COMPACTION_TIMEOUT_MS}ms`,
    )
  }

  async function performSummarize(
    sessionID: string,
    sessionState: GovernorSessionState,
    effective: EffectiveThresholds,
  ): Promise<void> {
    if (compactionInProgress.has(sessionID)) return
    if (!sessionState.providerID || !sessionState.modelID) return

    const cfg = resolveConfig()
    const maxPasses = cfg.max_compaction_passes ?? 3

    compactionInProgress.add(sessionID)
    const beforeTokens = sessionState.lastUsedTokens
    auditEvent(sessionID, "compaction_started", {
      before_tokens: beforeTokens,
      target_tokens: effective.targetAfter,
      max_passes: maxPasses,
      provider: sessionState.providerID,
      model: sessionState.modelID,
    })
    try {
      let previousUsed = sessionState.lastUsedTokens
      let completedPasses = 0
      let finalTokens = previousUsed
      let stopReason = "max_passes_reached"
      for (let pass = 0; pass < maxPasses; pass++) {
        const passBefore = previousUsed
        await summarizeOnce(sessionID, sessionState)
        invalidateContextWindowUsageCache(ctx, sessionID)
        const usage = await getContextWindowUsage(ctx, sessionID, deps.modelCacheState)
        const after = usage?.usedTokens
        if (typeof after !== "number") {
          stopReason = "measurement_unavailable"
          auditEvent(sessionID, "compaction_pass", {
            pass: pass + 1,
            before_tokens: passBefore,
            after_tokens: null,
          })
          break
        }
        sessionState.lastUsedTokens = after
        finalTokens = after
        completedPasses += 1
        auditEvent(sessionID, "compaction_pass", {
          pass: pass + 1,
          before_tokens: passBefore,
          after_tokens: after,
        })
        if (after <= effective.targetAfter) {
          stopReason = "target_reached"
          break
        }
        const reduction = previousUsed - after
        if (pass > 0 && reduction < MIN_PASS_REDUCTION_TOKENS) {
          stopReason = "poor_pass_value"
          break
        }
        previousUsed = after
      }
      sessionState.phase = "idle"
      auditEvent(sessionID, "compaction_complete", {
        stop_reason: stopReason,
        reason_code: stopReason,
        pass_count: completedPasses,
        after_tokens: finalTokens,
      })
    } catch (error) {
      const errorMessage = String(error)
      sessionState.last_audit_error = errorMessage
      auditEvent(sessionID, "compaction_failed", { reason_code: "compaction_error" })
      log("[context-governor] Compaction failed", {
        sessionID,
        providerID: sessionState.providerID,
        modelID: sessionState.modelID,
        error: errorMessage,
      })
    } finally {
      compactionInProgress.delete(sessionID)
    }
  }

  function updateBlockedFlag(sessionID: string, decision: GovernorDecision): void {
    if (
      decision.kind === "defer_lease" ||
      decision.kind === "defer_no_capsule"
    ) {
      blockedByGovernor.add(sessionID)
      return
    }
    blockedByGovernor.delete(sessionID)
  }

  function computeLeaseExpired(
    lease: LeaseRecord,
    sessionState: GovernorSessionState,
    extraTokens: number,
    maxTurns: number,
  ): boolean {
    return leaseExpired(lease, {
      turns_since_grant: sessionState.lease_meta.turns_since_grant,
      tokens_since_grant: sessionState.lease_meta.tokens_since_grant,
      extra_tokens: extraTokens,
      max_turns: maxTurns,
    })
  }

  const ingestVerdict = (
    sessionID: string,
    verdictOrError: VerifierVerdict | { error: string },
  ): void => {
    const sessionState = getOrInitState(sessionID)
    const dir = resolveDirectory()

    if ("error" in verdictOrError) {
      auditEvent(sessionID, "twin_failure", { reason_code: "invalid_verdict" })
      appendAuditLine(dir, sessionID, {
        ts: nowFn().toISOString(),
        session_id: sessionID,
        kind: "verdict",
        verdict: "INVALID",
      })
      return
    }

    const verdict = verdictOrError
    if (verdict.verdict === "CONTEXT_LEASE_REQUIRED") {
      const cfg = resolveConfig()
      const store = getLeaseStore()
      const grant = store.grantLease(sessionID, {
        context_size_at_grant: sessionState.lastUsedTokens,
        reason: verdict.reason,
        retained_ranges: mapAnchorRanges(verdict),
        extra_tokens: cfg.lease.extra_tokens,
        turns: cfg.lease.max_turns,
        granted_by: "twin",
        audit_hash: "",
      })
      if (grant.granted) {
        sessionState.phase = "lease_active"
        sessionState.verdict = verdict
        sessionState.lease_meta = {
          turns_since_grant: 0,
          tokens_since_grant: 0,
          grant_usage: sessionState.lastUsedTokens,
        }
        sessionState.entered_at_tokens = sessionState.lastUsedTokens
        sessionState.next_reassessment_tokens =
          sessionState.lastUsedTokens + cfg.lease.extra_tokens
        auditEvent(sessionID, "enter_expansion", {
          context_tokens: sessionState.lastUsedTokens,
          next_reassessment_tokens: sessionState.next_reassessment_tokens,
          reason_code: verdict.reason,
          lease_extra_tokens: cfg.lease.extra_tokens,
        })
        onEvent(sessionID, "enter_expansion", {
          context: sessionState.lastUsedTokens,
          reason: verdict.reason,
          reassess: sessionState.next_reassessment_tokens,
        })
      }
    } else {
      sessionState.verdict = verdict
      auditEvent(sessionID, "classification", { verdict: verdict.verdict })
    }

    appendAuditLine(dir, sessionID, {
      ts: nowFn().toISOString(),
      session_id: sessionID,
      kind: "verdict",
      verdict: verdict.verdict,
    })
  }

  const eventHandler = async ({
    event,
  }: {
    event: { type: string; properties?: unknown }
  }): Promise<void> => {
    const props = isRecord(event.properties) ? event.properties : undefined

    if (event.type === "session.deleted") {
      const sessionID = resolveSessionEventID(props)
      if (sessionID) {
        const existing = state.get(sessionID)
        auditEvent(sessionID, "session_shutdown", {
          phase: existing?.phase ?? null,
          context_tokens: existing && existing.lastUsedTokens > 0 ? existing.lastUsedTokens : null,
        })
        state.delete(sessionID)
        blockedByGovernor.delete(sessionID)
        compactionInProgress.delete(sessionID)
      }
      return
    }

    if (event.type === "session.compacted") {
      const sessionID = resolveSessionEventID(props)
      if (sessionID) {
        const sessionState = getOrInitState(sessionID)
        const wasExpanded = sessionState.phase === "lease_active"
        sessionState.verdict = null
        sessionState.phase = "idle"
        sessionState.lease_meta = { turns_since_grant: 0, tokens_since_grant: 0, grant_usage: 0 }
        blockedByGovernor.delete(sessionID)
        if (wasExpanded) {
          auditEvent(sessionID, "exit_expansion", { reason_code: "external_compaction" })
        }
      }
      return
    }

    if (event.type !== "message.updated") return

    const info = isRecord(props?.info) ? props?.info : undefined
    const sessionID = resolveMessageEventSessionID(props)
    if (!info || info.role !== "assistant" || !info.finish || !sessionID) return

    const sessionState = getOrInitState(sessionID)
    if (typeof info.providerID === "string") sessionState.providerID = info.providerID
    if (typeof info.modelID === "string") sessionState.modelID = info.modelID

    const tokens = isRecord(info.tokens) ? info.tokens : undefined
    if (tokens) {
      const cache = isRecord(tokens.cache) ? tokens.cache : undefined
      const inputTokens = typeof tokens.input === "number" ? tokens.input : 0
      const cacheRead = typeof cache?.read === "number" ? cache.read : 0
      const outputTokens = typeof tokens.output === "number" ? tokens.output : 0
      const used = inputTokens + cacheRead + outputTokens

      if (sessionState.phase === "lease_active") {
        sessionState.lease_meta = {
          ...sessionState.lease_meta,
          turns_since_grant: sessionState.lease_meta.turns_since_grant + 1,
          tokens_since_grant: Math.max(
            0,
            used - sessionState.lease_meta.grant_usage,
          ),
        }
      }

      sessionState.lastUsedTokens = used
    }
  }

  const toolExecuteAfter = async (
    input: { tool: string; sessionID: string; callID: string },
    _output: { title: string; output: string; metadata: unknown },
  ): Promise<void> => {
    const cfg = resolveConfig()
    if (cfg.enabled !== true) return

    const sessionID = input.sessionID
    const sessionState = getOrInitState(sessionID)

    let usage: Awaited<ReturnType<typeof getContextWindowUsage>>
    try {
      usage = await getContextWindowUsage(ctx, sessionID, deps.modelCacheState)
    } catch (error) {
      sessionState.last_audit_error = String(error)
      auditEvent(sessionID, "measurement_failure", { reason_code: "context_window_usage_error" })
      return
    }

    if (usage) {
      sessionState.lastUsedTokens = usage.usedTokens
    }
    const usedTokens =
      usage?.usedTokens ?? sessionState.lastUsedTokens

    if (!sessionState.providerID || !sessionState.modelID) return

    const actualLimit = resolveActualContextLimit(
      sessionState.providerID,
      sessionState.modelID,
      deps.modelCacheState,
    )
    const effective = resolveEffectiveThresholds({
      configured: cfg,
      actualLimit,
    })
    if (!effective) return

    const store = getLeaseStore()
    const activeLease = store.getActiveLease(sessionID)
    const capsuleFresh = isCapsuleFresh(sessionID, 0)
    let leaseExpiredNow = false
    let renewalPossible = false
    if (activeLease) {
      leaseExpiredNow = computeLeaseExpired(
        activeLease,
        sessionState,
        cfg.lease.extra_tokens,
        cfg.lease.max_turns,
      )
      renewalPossible = activeLease.renewal_count < cfg.lease.max_renewals
    }

    const decisionInput: EvaluateGovernorDecisionInput = {
      used_tokens: usedTokens,
      effective,
      phase: sessionState.phase,
      verdict: sessionState.verdict,
      active_lease: activeLease,
      lease_expired: leaseExpiredNow,
      renewal_possible: renewalPossible,
      capsule_fresh: capsuleFresh,
      max_renewals: cfg.lease.max_renewals,
    }
    const decision = evaluateGovernorDecision(decisionInput)

    sessionState.lastEffective = effective

    appendAuditLine(resolveDirectory(), sessionID, {
      ts: nowFn().toISOString(),
      session_id: sessionID,
      kind: decision.kind,
      reason: decision.reason,
      used_tokens: usedTokens,
      compact_at: effective.compactAt,
    })

    updateBlockedFlag(sessionID, decision)

    sessionState.turns_since_assessment += 1
    if (decision.kind !== "none") {
      const classification = classifyDecision(decision)
      sessionState.last_assessment = {
        decision: decision.kind,
        classification,
        reason: decision.reason,
        context_tokens: usedTokens,
        ts: nowFn().toISOString(),
      }
      const detail: Record<string, unknown> = {
        context: usedTokens,
        preferred: effective.compactAt,
        decision: classification,
        reason: decision.reason,
        target: effective.targetAfter,
      }
      if (classification === "compact") {
        detail.compressible = Math.max(0, usedTokens - effective.targetAfter)
      }
      if (sessionState.next_reassessment_tokens !== null) {
        detail.reassess = sessionState.next_reassessment_tokens
      }
      const auditFields: Record<string, unknown> = {
        context_tokens: usedTokens,
        preferred_tokens: effective.compactAt,
        prepare_at_tokens: effective.prepareAt,
        audit_at_tokens: effective.auditAt,
        effective_prepare_tokens: effective.prepareAt,
        effective_target_tokens: effective.targetAfter,
        phase: sessionState.phase,
        decision: classification,
        reason_code: decision.kind,
        reason: decision.reason,
        provider: sessionState.providerID,
        model: sessionState.modelID,
        turn_count: sessionState.turns_since_assessment,
      }
      if (classification === "compact") {
        auditFields.compressible_tokens = Math.max(0, usedTokens - effective.targetAfter)
      }
      if (sessionState.next_reassessment_tokens !== null) {
        auditFields.next_reassessment_tokens = sessionState.next_reassessment_tokens
      }
      auditEvent(sessionID, "assessment", auditFields)
      onEvent(sessionID, eventNameFor(classification), detail)
    }

    switch (decision.kind) {
      case "none":
        return
      case "prepare":
        sessionState.phase = "preparing"
        signalBus.wake(sessionID, "maintain")
        return
      case "audit":
        sessionState.phase = "auditing"
        signalBus.wake(sessionID, "validate")
        return
      case "compact":
      case "compact_degraded":
        await performSummarize(sessionID, sessionState, effective)
        sessionState.entered_at_tokens = null
        sessionState.next_reassessment_tokens = null
        sessionState.turns_since_assessment = 0
        return
      case "force_compact":
        sessionState.phase = "forcing"
        await performSummarize(sessionID, sessionState, effective)
        if (activeLease) {
          store.expireLease(sessionID)
          auditEvent(sessionID, "exit_expansion", { reason_code: "lease_expired_forced" })
        }
        sessionState.lease_meta = { turns_since_grant: 0, tokens_since_grant: 0, grant_usage: 0 }
        sessionState.entered_at_tokens = null
        sessionState.next_reassessment_tokens = null
        sessionState.turns_since_assessment = 0
        return
      case "renew_lease": {
        const outcome = store.renewLease(sessionID, {
          maxRenewals: cfg.lease.max_renewals,
          currentContextSize: usedTokens,
        })
        if (outcome === "renewed") {
          sessionState.lease_meta = {
            turns_since_grant: 0,
            tokens_since_grant: 0,
            grant_usage: usedTokens,
          }
          sessionState.entered_at_tokens = usedTokens
          sessionState.next_reassessment_tokens = usedTokens + cfg.lease.extra_tokens
          sessionState.turns_since_assessment = 0
        }
        auditEvent(sessionID, "continue_expansion", {
          context_tokens: usedTokens,
          next_reassessment_tokens: sessionState.next_reassessment_tokens,
          reason_code: outcome,
        })
        return
      }
      case "defer_lease":
        auditEvent(sessionID, "continue_expansion", {
          context_tokens: usedTokens,
          next_reassessment_tokens: sessionState.next_reassessment_tokens,
          reason_code: "lease_active",
        })
        return
      case "defer_no_capsule":
        return
    }
  }

  const diagnose = (sessionID: string): ContextGovernorDiagnostic => {
    const cfg = resolveConfig()
    const sessionState = state.get(sessionID)
    if (!sessionState) {
      return {
        enabled: cfg.enabled === true,
        phase: "idle",
        measured_context_tokens: null,
        preferred_tokens: null,
        prepare_threshold: null,
        compaction_target: null,
        non_compressible_baseline: null,
        latest_assessment: null,
        latest_decision: null,
        next_reassessment_tokens: null,
        turns_since_assessment: 0,
        audit_journal_path: audit?.path(sessionID) ?? null,
      }
    }

    const effective =
      sessionState.lastEffective ??
      (sessionState.providerID && sessionState.modelID
        ? resolveEffectiveThresholds({
            configured: cfg,
            actualLimit: resolveActualContextLimit(
              sessionState.providerID,
              sessionState.modelID,
              deps.modelCacheState,
            ),
          })
        : null)

    return {
      enabled: cfg.enabled === true,
      phase: sessionState.phase,
      measured_context_tokens:
        sessionState.lastUsedTokens > 0 ? sessionState.lastUsedTokens : null,
      preferred_tokens: effective?.compactAt ?? null,
      prepare_threshold: effective?.prepareAt ?? null,
      compaction_target: effective?.targetAfter ?? null,
      non_compressible_baseline: null,
      latest_assessment: sessionState.last_assessment,
      latest_decision: sessionState.last_assessment?.classification ?? null,
      next_reassessment_tokens: sessionState.next_reassessment_tokens,
      turns_since_assessment: sessionState.turns_since_assessment,
      audit_journal_path: audit?.path(sessionID) ?? null,
    }
  }

  return {
    event: eventHandler,
    ingestVerdict,
    "tool.execute.after": toolExecuteAfter,
    diagnose,
  }
}
