/**
 * Delegation-first runtime. Composes the retry/escalation ladder, the
 * metadata-only watchdog, and the root grunt-work guard over one governance
 * audit journal. Every audit event is metadata only (ids, counters, tiers,
 * decisions); prompts, worker output, and transcripts never reach the journal.
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
  detectGruntWorkCycle,
  type GruntGuardOptions,
  type GruntVerdict,
  type ToolActivityEvent,
} from "../grunt-guard"
import {
  createWatchdog,
  type Level1Result,
  type Watchdog,
  type WatchdogPolicy,
} from "../worker-supervisor"
import type { GovernanceAuditWriter } from "../../shared/governance-audit"

export type DelegationFirstConfig = {
  ladder?: Partial<DelegationLadderConfig>
  watchdog?: Partial<WatchdogPolicy>
  grunt?: Partial<GruntGuardOptions>
}

export type DelegationFirstRuntime = {
  beginDelegation(jobID: string, parentSessionID: string, workerSessionID: string, prompt: string, workers: WorkerCandidate[]): void
  recordWorkerResult(jobID: string, result: AttemptResult): NextAction
  findings(jobID: string): Finding[]
  watchdogActivity(sessionID: string): void
  watchdogProcessStart(sessionID: string): void
  watchdogProcessEnd(sessionID: string): void
  watchdogTerminal(sessionID: string): void
  checkWatchdog(sessionID: string, nowMs?: number): Level1Result
  flagGrunt(sessionID: string, events: ToolActivityEvent[]): GruntVerdict
  dispose(): void
}

export function createDelegationFirstRuntime(
  audit: GovernanceAuditWriter | undefined,
  cfg: DelegationFirstConfig = {},
): DelegationFirstRuntime {
  const jobSession = new Map<string, string>()

  const ladder: DelegationLadder = createDelegationLadder(cfg.ladder, {
    onEvent: (jobID, event, detail) => {
      const sessionID = jobSession.get(jobID)
      if (!sessionID) return
      audit?.write(sessionID, { subsystem: "delegation", event, job_id: jobID, ...detail })
    },
  })

  const watchdog: Watchdog = createWatchdog(cfg.watchdog, {
    onEvent: (sessionID, event, detail) => {
      audit?.write(sessionID, { subsystem: "watchdog", event, ...detail })
    },
  })

  return {
    beginDelegation(jobID, parentSessionID, workerSessionID, prompt, workers) {
      jobSession.set(jobID, parentSessionID)
      ladder.start(jobID, prompt, workers)
      watchdog.register(workerSessionID, jobID)
    },
    recordWorkerResult(jobID, result) {
      return ladder.record(jobID, result)
    },
    findings(jobID) {
      return ladder.findings(jobID)
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
    flagGrunt(sessionID, events) {
      const verdict = detectGruntWorkCycle(events, { ...DEFAULT_GRUNT_GUARD_OPTIONS, ...cfg.grunt })
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
    dispose() {
      watchdog.dispose()
    },
  }
}
