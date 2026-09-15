/**
 * Delegation-first runtime. Composes the retry/escalation ladder, the
 * metadata-only watchdog, and the root grunt-work guard over one governance
 * audit journal. Every audit event is metadata only (ids, counters, tiers,
 * decisions); prompts, worker output, and transcripts never reach the journal.
 *
 * Live-runtime surface: `beginDelegation` starts the ladder (workers +
 * prompt), `attachWorkerSession` binds the real child session (once known) to
 * the watchdog, `markRequestStarted` records the provider-request milestone,
 * `recordWorkerResult` folds a worker result into the ladder, `onToolActivity`
 * accumulates root tool activity for grunt detection, `checkAllWatchdogs`
 * sweeps registered children with metadata-only checks, and `reclaimStalled`
 * drives the automatic recovery path (detect -> record -> cancel -> retry).
 */

import {
  createDelegationLadder,
  type AttemptResult,
  type DelegationLadderConfig,
  type DelegationLadder,
  type Finding,
  type NextAction,
  type WorkerCandidate,
} from "../delegation-ladder"
import {
  DEFAULT_GRUNT_GUARD_OPTIONS,
  createPreGruntGate,
  detectGruntWorkCycle,
  type GruntGuardOptions,
  type GruntToolHint,
  type GruntVerdict,
  type PreGruntDecision,
  type PreGruntGate,
  type ToolActivityEvent,
} from "../grunt-guard"
import {
  createWatchdog,
  createRecoveryCoordinator,
  type RecoveryCoordinator,
  type StallTimeoutPolicy,
  type Watchdog,
  type WatchdogCheckResult,
  type WatchdogPolicy,
} from "../worker-supervisor"
import { discoverFreeModels, type PricingCatalog } from "../../hooks/resource-governor/pricing"
import type { GovernanceAuditWriter } from "../../shared/governance-audit"

export type DelegationFirstConfig = {
  ladder?: Partial<DelegationLadderConfig>
  watchdog?: Partial<WatchdogPolicy>
  timeouts?: Partial<StallTimeoutPolicy>
  grunt?: Partial<GruntGuardOptions>
  // Live pricing catalog used to derive a free-worker hint for the early gate.
  pricing?: PricingCatalog
}

/** Sink that reclaims a stalled child. Injected after construction because the
 * runtime is built before the BackgroundManager exists. */
export type RecoverySink = {
  cancel: (sessionID: string, reason: string) => Promise<void> | void
}

export type DelegationFirstRuntime = {
  beginDelegation(jobID: string, parentSessionID: string, prompt: string, workers: WorkerCandidate[]): void
  attachChildSession(parentSessionID: string, childSessionID: string): void
  detachChildSession(childSessionID: string): void
  recordWorkerResult(jobID: string, result: AttemptResult): NextAction
  findings(jobID: string): Finding[]
  /** Record that the provider request for `sessionID` was dispatched. */
  markRequestStarted(sessionID: string): void
  setRecoverySink(sink: RecoverySink): void
  /** Evaluate a timed-out stall and reclaim it (cancel + retry) automatically. */
  reclaimStalled(sessionID: string, providerModel: string | null, nowMs?: number): void
  watchdogActivity(sessionID: string): void
  watchdogProcessStart(sessionID: string): void
  watchdogProcessEnd(sessionID: string): void
  watchdogTerminal(sessionID: string): void
  checkWatchdog(sessionID: string, nowMs?: number): WatchdogCheckResult
  checkAllWatchdogs(nowMs?: number): Array<{ sessionID: string; result: WatchdogCheckResult }>
  sessions(): string[]
  unregisterWorker(sessionID: string): void
  onToolActivity(sessionID: string, tool: string, nowMs?: number): GruntVerdict
  preGruntCheck(
    sessionID: string,
    tool: string,
    hint?: GruntToolHint,
    contextPressure?: number,
  ): PreGruntDecision
  dispose(): void
}

export function createDelegationFirstRuntime(
  audit: GovernanceAuditWriter | undefined,
  cfg: DelegationFirstConfig = {},
): DelegationFirstRuntime {
  // Maps a ladder jobID -> parent session id for audit attribution.
  const jobSession = new Map<string, string>()
  // Maps a worker session id -> jobID (watchdog worker identity).
  const sessionJob = new Map<string, string>()
  // Root-session tool activity windows for post-hoc grunt detection.
  const gruntWindows = new Map<string, ToolActivityEvent[]>()
  // Sessions whose provider request was dispatched before the watchdog attached.
  const pendingRequestStarted = new Set<string>()

  const ladder: DelegationLadder = createDelegationLadder(cfg.ladder, {
    onEvent: (jobID, event, detail) => {
      const sessionID = jobSession.get(jobID)
      if (!sessionID) return
      audit?.write(sessionID, { subsystem: "delegation", event, job_id: jobID, ...detail })
    },
  })

  const watchdog: Watchdog = createWatchdog(cfg.watchdog, {
    onEvent: (sessionID, event, detail) => {
      audit?.write(sessionID, {
        subsystem: "watchdog",
        event,
        ...detail,
        parent_session_id: sessionJob.get(sessionID) ?? detail?.worker_id,
      })
    },
    timeouts: cfg.timeouts,
  })

  const recovery: RecoveryCoordinator = createRecoveryCoordinator()
  let sink: RecoverySink | undefined

  const gruntOptions: GruntGuardOptions = { ...DEFAULT_GRUNT_GUARD_OPTIONS, ...cfg.grunt }

  const freeWorkerHint = cfg.pricing ? discoverFreeModels(cfg.pricing)[0] ?? null : null
  const gate: PreGruntGate = createPreGruntGate({ freeWorkerHint })

  return {
    beginDelegation(jobID, parentSessionID, prompt, workers) {
      jobSession.set(jobID, parentSessionID)
      audit?.write(parentSessionID, {
        subsystem: "watchdog",
        event: "child_dispatch_authorized",
        job_id: jobID,
        parent_session_id: parentSessionID,
      })
      ladder.start(jobID, prompt, workers)
    },
    attachChildSession(parentSessionID, childSessionID) {
      sessionJob.set(childSessionID, parentSessionID)
      watchdog.register(childSessionID, parentSessionID)
      if (pendingRequestStarted.delete(childSessionID)) {
        watchdog.markRequestStarted(childSessionID)
      }
    },
    detachChildSession(childSessionID) {
      watchdog.unregister(childSessionID)
      sessionJob.delete(childSessionID)
      pendingRequestStarted.delete(childSessionID)
      recovery.reset(childSessionID)
    },
    recordWorkerResult(jobID, result) {
      return ladder.record(jobID, result)
    },
    findings(jobID) {
      return ladder.findings(jobID)
    },
    markRequestStarted(sessionID) {
      if (watchdog.sessions().includes(sessionID)) {
        watchdog.markRequestStarted(sessionID)
      } else {
        pendingRequestStarted.add(sessionID)
      }
    },
    setRecoverySink(next) {
      sink = next
    },
    reclaimStalled(sessionID, providerModel, nowMs) {
      const result = watchdog.check(sessionID, nowMs)
      if (!result.timedOut || result.stallMode === null || result.stallMode === "QUIET_BUT_ACTIVE") return
      const decision = recovery.evaluate(sessionID, providerModel, result.stallMode, true, nowMs)
      if (decision.kind !== "reclaim") return

      recovery.recordReclaim(sessionID, providerModel, nowMs)
      watchdog.markStalled(sessionID)
      audit?.write(sessionID, {
        subsystem: "watchdog",
        event: "watchdog_reclaimed",
        stall_mode: result.stallMode,
        stage: result.stage,
        correlated: decision.correlated,
        provider_model: providerModel ?? null,
        parent_session_id: sessionJob.get(sessionID) ?? null,
      })
      if (decision.retry) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "worker_retry_started",
          stall_mode: result.stallMode,
          correlated: decision.correlated,
          alternate_worker: decision.correlated ? true : false,
        })
      }
      // Truthful terminal: a reclaimed child is cancelled, never left running.
      watchdog.onTerminal(sessionID, "cancelled")
      void sink?.cancel(sessionID, decision.reason)
    },
    watchdogActivity(sessionID) {
      watchdog.onActivity(sessionID)
    },
    watchdogProcessStart(sessionID) {
      watchdog.onProcessStart(sessionID)
    },
    watchdogProcessEnd(sessionID) {
      watchdog.onProcessEnd(sessionID)
    },
    watchdogTerminal(sessionID) {
      watchdog.onTerminal(sessionID)
    },
    checkWatchdog(sessionID, nowMs) {
      return watchdog.check(sessionID, nowMs)
    },
    checkAllWatchdogs(nowMs) {
      return watchdog.checkAll(nowMs)
    },
    sessions() {
      return watchdog.sessions()
    },
    unregisterWorker(sessionID) {
      watchdog.unregister(sessionID)
      sessionJob.delete(sessionID)
      pendingRequestStarted.delete(sessionID)
    },
    onToolActivity(sessionID, tool, nowMs) {
      const event: ToolActivityEvent = { tool, atMs: nowMs ?? Date.now() }
      const window = gruntWindows.get(sessionID)
      if (!window) {
        gruntWindows.set(sessionID, [event])
        return { grunt: false, reason: null, gruntCount: 0 }
      }
      window.push(event)
      // Bound the retained window to the detector's window span so the map
      // never grows unboundedly for a long-lived main session.
      const latest = event.atMs
      const keep = window.filter((e) => e.atMs >= latest - gruntOptions.windowMs)
      gruntWindows.set(sessionID, keep)

      const verdict = detectGruntWorkCycle(keep, gruntOptions)
      if (verdict.grunt) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "root_direct_exception",
          reason: verdict.reason,
          grunt_count: verdict.gruntCount,
        })
      }
      return verdict
    },
    preGruntCheck(sessionID, tool, hint, contextPressure) {
      const wasSteered = gate.isSteered(sessionID)
      const decision = gate.inspect(sessionID, tool, hint, contextPressure)

      if (decision.delegated && wasSteered) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "early_delegation_dispatched",
          session_id: sessionID,
        })
      }

      if (decision.delegated) {
        return decision
      }

      if (decision.selectiveVerification) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "selective_root_verification",
          tool,
        })
        return decision
      }

      if (decision.block) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "root_grunt_pattern_detected",
          reason: decision.reason,
          grunt_count: decision.signal.gruntCount,
          distinct_modules: decision.signal.distinctModules,
          search_read_search: decision.signal.searchReadSearch,
          cross_module: decision.signal.crossModule,
        })
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "early_delegation_required",
          reason: decision.reason,
          free_worker_hint: decision.freeWorkerHint,
          context_pressure: contextPressure ?? null,
        })
      }

      return decision
    },
    dispose() {
      watchdog.dispose()
      gate.clear()
      jobSession.clear()
      sessionJob.clear()
      gruntWindows.clear()
      pendingRequestStarted.clear()
    },
  }
}
