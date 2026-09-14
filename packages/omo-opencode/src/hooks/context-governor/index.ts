import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ContextLimitModelCacheState } from "@oh-my-opencode/model-core"
import { resolveActualContextLimit } from "@oh-my-opencode/model-core"

import type { OhMyOpenCodeConfig } from "../../config"
import { writeAtomicText } from "../../shared/atomic-fs"
import { getContextWindowUsage } from "../../shared/context-window-usage"
import { resolveMessageEventSessionID, resolveSessionEventID } from "../../shared/event-session-id"
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
import { resolveEffectiveThresholds } from "./threshold-policy"
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
}

export function createContextGovernorHook(
  ctx: PluginInput,
  deps: ContextGovernorHookDeps,
): ContextGovernorHook {
  const state = new Map<string, GovernorSessionState>()
  const compactionInProgress = new Set<string>()
  const signalBus = deps.signalBus ?? NOOP_SIGNAL_BUS
  const nowFn = deps.now ?? (() => new Date())
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
    }
    return s
  }

  function isEnabled(): boolean {
    const cfg = deps.pluginConfig.context_governor
    return cfg?.enabled === true
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

  async function performSummarize(
    sessionID: string,
    sessionState: GovernorSessionState,
  ): Promise<void> {
    if (compactionInProgress.has(sessionID)) return
    if (!sessionState.providerID || !sessionState.modelID) return

    compactionInProgress.add(sessionID)
    try {
      const summarizePromise = ctx.client.session.summarize({
        path: { id: sessionID },
        body: {
          providerID: sessionState.providerID,
          modelID: sessionState.modelID,
          auto: true,
        },
        query: { directory: resolveDirectory() },
      })
      void summarizePromise.then(
        () => compactionInProgress.delete(sessionID),
        () => compactionInProgress.delete(sessionID),
      )
      await withTimeout(
        summarizePromise,
        COMPACTION_TIMEOUT_MS,
        `Governor compaction summarize timed out after ${COMPACTION_TIMEOUT_MS}ms`,
      )
      sessionState.phase = "idle"
    } catch (error) {
      const errorMessage = String(error)
      sessionState.last_audit_error = errorMessage
      log("[context-governor] Compaction failed", {
        sessionID,
        providerID: sessionState.providerID,
        modelID: sessionState.modelID,
        error: errorMessage,
      })
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
      const cfg = deps.pluginConfig.context_governor
      if (!cfg) return
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
      }
    } else {
      sessionState.verdict = verdict
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
        sessionState.verdict = null
        sessionState.phase = "idle"
        sessionState.lease_meta = { turns_since_grant: 0, tokens_since_grant: 0, grant_usage: 0 }
        blockedByGovernor.delete(sessionID)
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
    const cfg = deps.pluginConfig.context_governor
    if (!cfg || cfg.enabled !== true) return

    const sessionID = input.sessionID
    const sessionState = getOrInitState(sessionID)

    let usage: Awaited<ReturnType<typeof getContextWindowUsage>>
    try {
      usage = await getContextWindowUsage(ctx, sessionID, deps.modelCacheState)
    } catch (error) {
      sessionState.last_audit_error = String(error)
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

    appendAuditLine(resolveDirectory(), sessionID, {
      ts: nowFn().toISOString(),
      session_id: sessionID,
      kind: decision.kind,
      reason: decision.reason,
      used_tokens: usedTokens,
      compact_at: effective.compactAt,
    })

    updateBlockedFlag(sessionID, decision)

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
        await performSummarize(sessionID, sessionState)
        return
      case "force_compact":
        sessionState.phase = "forcing"
        await performSummarize(sessionID, sessionState)
        if (activeLease) store.expireLease(sessionID)
        sessionState.lease_meta = { turns_since_grant: 0, tokens_since_grant: 0, grant_usage: 0 }
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
        }
        return
      }
      case "defer_lease":
      case "defer_no_capsule":
        return
    }
  }

  return {
    event: eventHandler,
    ingestVerdict,
    "tool.execute.after": toolExecuteAfter,
  }
}
