/**
 * Delegation-first runtime. Composes the retry/escalation ladder, the
 * metadata-only watchdog, and the root grunt-work guard over one governance
 * audit journal. Every audit event is metadata only (ids, counters, tiers,
 * decisions); prompts, worker output, and transcripts never reach the journal.
 *
 * Live-runtime surface: `beginDelegation` starts the ladder (workers +
 * prompt), `retainAssignment` retains a bounded replayable assignment for
 * automatic failover, `attachWorkerSession` binds the real child session (once
 * known) to the watchdog, `markRequestStarted` records the provider-request
 * milestone, `recordWorkerResult` folds a worker result into the ladder,
 * `onToolActivity` accumulates root tool activity for grunt detection,
 * `checkAllWatchdogs` sweeps registered children with metadata-only checks, and
 * `reclaimStalled` drives automatic recovery (detect -> record -> cancel ->
 * stage-aware failover -> governed re-dispatch).
 */

import {
  createDelegationLadder,
  DEFAULT_DELEGATION_LADDER_CONFIG,
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
  type GruntToolHint,
  type GruntVerdict,
  type PreGruntDecision,
  type ToolActivityEvent,
} from "../grunt-guard"
import {
  createRootWorkerState,
  REASON_ADDITIONAL,
  REASON_WAIT,
  type RootWorkerPhase,
  type RootWorkerState,
} from "./root-worker-state"
import {
  createWatchdog,
  createRecoveryCoordinator,
  type ChildStage,
  type RecoveryCoordinator,
  type StallTimeoutPolicy,
  type Watchdog,
  type WatchdogCheckResult,
  type WatchdogPolicy,
} from "../worker-supervisor"
import { recommendFailoverAction, type RedispatchAction } from "./failover"
import { selectNextEligibleWorker } from "./availability-failover"
import { createModelAvailabilityCache, type ModelAvailabilityCache } from "./model-availability-cache"
import { createPaidWorkerGate } from "../../tools/delegate-task/paid-worker-gate"
import { resolveModelAvailabilityFilePath } from "./persistent-model-availability"
import {
  buildReplacementPrompt,
  initialLineage,
  type ReplayableAssignment,
  type RetryLineage,
} from "./replay"
import { discoverFreeModels, type PricingCatalog } from "../../hooks/resource-governor/pricing"
import type { GovernanceAuditWriter } from "../../shared/governance-audit"

export type DelegationFirstConfig = {
  ladder?: Partial<DelegationLadderConfig>
  watchdog?: Partial<WatchdogPolicy>
  timeouts?: Partial<StallTimeoutPolicy>
  grunt?: Partial<GruntGuardOptions>
  // Live pricing catalog used to derive a free-worker hint for the early gate.
  pricing?: PricingCatalog
  // Persistent negative-availability store path; defaults to env
  // `OMO_MODEL_AVAILABILITY_FILE` or `~/.omo/model-availability.json`.
  modelAvailabilityFilePath?: string
  /** COST-SAFETY: maximum concurrent paid child requests (default 1). */
  maxConcurrentPaidWorkers?: number
}

/** Result of a governed replacement-child re-dispatch. */
export type RelaunchOutcome =
  | { kind: "launched"; taskID: string; sessionID?: string }
  | { kind: "blocked"; reason: string }

/**
 * Sink that reclaims a stalled child and, when a retry is worthwhile,
 * re-dispatches a governed replacement child through the real launch path.
 * Injected after construction because the runtime is built before the
 * BackgroundManager exists.
 */
export type RecoverySink = {
  cancel: (sessionID: string, reason: string) => Promise<void> | void
  /** Re-dispatch a replacement child from a retained assignment + failover action. */
  relaunch?: (
    assignment: ReplayableAssignment,
    action: RedispatchAction,
    replacementPrompt: string,
  ) => Promise<RelaunchOutcome> | RelaunchOutcome
}

export type DelegationFirstRuntime = {
  beginDelegation(jobID: string, parentSessionID: string, prompt: string, workers: WorkerCandidate[]): void
  /** Retain a bounded replayable assignment so a stalled child can be re-dispatched. */
  retainAssignment(assignment: ReplayableAssignment, childSessionID?: string): void
  /** Record compact partial findings for a retained assignment (preserved across retries). */
  recordPartialFindings(assignmentOrSessionID: string, findings: Finding[]): void
  lineage(assignmentOrSessionID: string): RetryLineage | undefined
  /** Link a replacement child session to its assignment (fires when the session resolves). */
  noteReplacementSession(assignmentID: string, sessionID: string): void
  attachChildSession(parentSessionID: string, childSessionID: string): void
  detachChildSession(childSessionID: string): void
  recordWorkerResult(jobID: string, result: AttemptResult): NextAction
  findings(jobID: string): Finding[]
  /** Record that the provider request for `sessionID` was dispatched. */
  markRequestStarted(sessionID: string): void
  /**
   * Record a disabled-model (availability) failure: mark the model unavailable
   * so concurrent/new workers skip it, then auto-dispatch the next eligible
   * worker. Hard-fails the child when no eligible worker remains.
   */
  recordModelUnavailable(sessionID: string, modelKey: string, reason: string): void
  /** Live set of models currently marked unavailable (for candidate filtering). */
  unavailableModels(): string[]
  /** Absolute path of the persistent negative-availability store. */
  getAvailabilityFilePath(): string
  setRecoverySink(sink: RecoverySink): void
  /** COST-SAFETY: reserve one paid-child slot (false when at the cap). */
  tryAcquirePaidChild(): boolean
  /** COST-SAFETY: mark a launched child session as paid so detach releases its slot. */
  markPaidChildSession(sessionID: string): void
  /** COST-SAFETY: release a paid-child slot directly (sync/terminal paths). */
  releasePaidChild(): void
  /** Evaluate a timed-out stall and reclaim it (cancel + governed re-dispatch) automatically. */
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
  /** Current hard worker-first phase for a root session (observability + tests). */
  rootPhase(sessionID: string): RootWorkerPhase
  dispose(): void
}

function isThenable(value: unknown): value is Promise<RelaunchOutcome> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function"
}

export function createDelegationFirstRuntime(
  audit: GovernanceAuditWriter | undefined,
  cfg: DelegationFirstConfig = {},
): DelegationFirstRuntime {
  // Maps a ladder jobID -> parent session id for audit attribution.
  const jobSession = new Map<string, string>()
  // Maps a worker session id -> jobID (watchdog worker identity).
  const sessionJob = new Map<string, string>()
  // Retained replayable assignment by assignment id and by child session id.
  const assignmentsById = new Map<string, ReplayableAssignment>()
  const sessionToAssignment = new Map<string, string>()
  const lineageByAssignment = new Map<string, RetryLineage>()
  // Child sessions that were launched as failover replacements.
  const replacementSessions = new Set<string>()
  // Root-session tool activity windows for post-hoc grunt detection.
  const gruntWindows = new Map<string, ToolActivityEvent[]>()
  // Sessions whose provider request was dispatched before the watchdog attached.
  const pendingRequestStarted = new Set<string>()
  // Root sessions that already audited their first permitted bootstrap operation.
  const bootstrapAudited = new Set<string>()

  const ladderConfig: DelegationLadderConfig = { ...DEFAULT_DELEGATION_LADDER_CONFIG, ...cfg.ladder }

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
  const availabilityFilePath = resolveModelAvailabilityFilePath(cfg.modelAvailabilityFilePath)
  const availability: ModelAvailabilityCache = createModelAvailabilityCache({
    persistentFilePath: availabilityFilePath,
  })
  let sink: RecoverySink | undefined
  const paidGate = createPaidWorkerGate(cfg.maxConcurrentPaidWorkers ?? 1)
  const paidSessions = new Set<string>()

  const gruntOptions: GruntGuardOptions = { ...DEFAULT_GRUNT_GUARD_OPTIONS, ...cfg.grunt }

  const freeWorkerHint = cfg.pricing ? discoverFreeModels(cfg.pricing)[0] ?? null : null
  const rootState: RootWorkerState = createRootWorkerState()

  function satisfyWorkerRequirement(sessionID: string): void {
    const before = rootState.phase(sessionID)
    rootState.noteWorkerRunning(sessionID)
    if (rootState.phase(sessionID) === "worker_active" && before !== "worker_active") {
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "worker_requirement_satisfied",
        session_id: sessionID,
      })
    }
  }

  function assignmentIDFor(sessionID: string): string | undefined {
    return sessionToAssignment.get(sessionID)
  }

  function applyRelaunchOutcome(
    oldSessionID: string,
    assignmentID: string,
    attempt: number,
    workerID: string,
    outcome: RelaunchOutcome,
  ): void {
    const detail = {
      assignment_id: assignmentID,
      attempt,
      next_worker: workerID,
    }
    if (outcome.kind === "launched") {
      audit?.write(oldSessionID, {
        subsystem: "delegation",
        event: "worker_retry_dispatched",
        ...detail,
        task_id: outcome.taskID,
        new_session_id: outcome.sessionID ?? null,
      })
      audit?.write(oldSessionID, {
        subsystem: "delegation",
        event: "replacement_child_created",
        ...detail,
        old_session_id: oldSessionID,
        new_session_id: outcome.sessionID ?? null,
      })
      if (outcome.sessionID) {
        replacementSessions.add(outcome.sessionID)
        sessionToAssignment.set(outcome.sessionID, assignmentID)
      }
    } else {
      audit?.write(oldSessionID, {
        subsystem: "delegation",
        event: "replacement_child_blocked",
        ...detail,
        reason: outcome.reason,
      })
      audit?.write(oldSessionID, {
        subsystem: "delegation",
        event: "retry_chain_exhausted",
        reason: outcome.reason,
        ...detail,
      })
    }
  }

  function tryRedispatch(
    sessionID: string,
    assignment: ReplayableAssignment,
    stallMode: NonNullable<WatchdogCheckResult["stallMode"]>,
    correlated: boolean,
    stage: ChildStage,
  ): void {
    const lineage = lineageByAssignment.get(assignment.assignment_id) ?? initialLineage(assignment)
    const action = recommendFailoverAction({
      workers: assignment.workers,
      attempt_number: lineage.attempt_number,
      worker_index: lineage.worker_index,
      previous_workers: lineage.previous_workers,
      config: ladderConfig,
      stallMode,
      correlated,
      findings: lineage.findings,
    })

    audit?.write(sessionID, {
      subsystem: "delegation",
      event: "worker_retry_planned",
      assignment_id: assignment.assignment_id,
      attempt: lineage.attempt_number,
      stall_mode: stallMode,
      correlated,
      action: action.kind,
      next_worker: action.kind === "give_up" ? null : action.worker.model_id,
    })

    if (action.kind === "give_up") {
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "retry_chain_exhausted",
        reason: action.reason,
        assignment_id: assignment.assignment_id,
        attempt: lineage.attempt_number,
      })
      return
    }

    if (action.kind === "alternate_worker") {
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "alternate_worker_selected",
        assignment_id: assignment.assignment_id,
        attempt: lineage.attempt_number,
        from: lineage.current_worker,
        to: action.worker.model_id,
      })
    }
    if (action.kind === "escalate_worker") {
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "worker_model_escalated",
        assignment_id: assignment.assignment_id,
        attempt: lineage.attempt_number,
        from: lineage.current_worker,
        to: action.worker.model_id,
        reason: action.reason,
      })
    }

    const priorWorker = lineage.current_worker ?? assignment.workers[lineage.worker_index]?.model_id ?? "unknown"
    const nextLineage: RetryLineage = {
      attempt_number: lineage.attempt_number + 1,
      worker_index: action.worker_index,
      previous_workers: [...lineage.previous_workers, priorWorker],
      current_worker: action.worker.model_id,
      failure_stage: stage,
      failure_stall_mode: stallMode,
      failure_reason: action.reason,
      findings: lineage.findings,
    }
    lineageByAssignment.set(assignment.assignment_id, nextLineage)

    const replacementPrompt = buildReplacementPrompt(assignment, nextLineage)

    const relaunch = sink?.relaunch
    if (!relaunch) {
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "retry_chain_exhausted",
        reason: "no_relaunch_sink",
        assignment_id: assignment.assignment_id,
        attempt: nextLineage.attempt_number,
      })
      return
    }

    const outcome = relaunch(assignment, action, replacementPrompt)
    if (isThenable(outcome)) {
      void outcome.then((resolved) =>
        applyRelaunchOutcome(sessionID, assignment.assignment_id, nextLineage.attempt_number, action.worker.model_id, resolved),
      )
    } else {
      applyRelaunchOutcome(sessionID, assignment.assignment_id, nextLineage.attempt_number, action.worker.model_id, outcome)
    }
  }

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
    retainAssignment(assignment, childSessionID) {
      assignmentsById.set(assignment.assignment_id, assignment)
      if (!lineageByAssignment.has(assignment.assignment_id)) {
        lineageByAssignment.set(assignment.assignment_id, initialLineage(assignment))
      }
      if (childSessionID) {
        sessionToAssignment.set(childSessionID, assignment.assignment_id)
      }
      if (!jobSession.has(assignment.assignment_id)) {
        jobSession.set(assignment.assignment_id, assignment.parent_session_id)
      }
    },
    recordPartialFindings(assignmentOrSessionID, findings) {
      const assignmentID =
        assignmentsById.has(assignmentOrSessionID) ? assignmentOrSessionID : assignmentIDFor(assignmentOrSessionID)
      if (!assignmentID) return
      const lineage = lineageByAssignment.get(assignmentID)
      if (!lineage) return
      lineage.findings = [...lineage.findings, ...findings]
      lineageByAssignment.set(assignmentID, lineage)
    },
    lineage(assignmentOrSessionID) {
      const assignmentID =
        assignmentsById.has(assignmentOrSessionID) ? assignmentOrSessionID : assignmentIDFor(assignmentOrSessionID)
      if (!assignmentID) return undefined
      return lineageByAssignment.get(assignmentID)
    },
    noteReplacementSession(assignmentID, sessionID) {
      sessionToAssignment.set(sessionID, assignmentID)
      replacementSessions.add(sessionID)
    },
    attachChildSession(parentSessionID, childSessionID) {
      sessionJob.set(childSessionID, parentSessionID)
      watchdog.register(childSessionID, parentSessionID)
      if (pendingRequestStarted.delete(childSessionID)) {
        watchdog.markRequestStarted(childSessionID)
        satisfyWorkerRequirement(parentSessionID)
      }
    },
    detachChildSession(childSessionID) {
      if (paidSessions.has(childSessionID)) {
        paidSessions.delete(childSessionID)
        paidGate.release()
      }
      if (replacementSessions.has(childSessionID)) {
        const snapshot = watchdog.snapshot(childSessionID)
        const assignmentID = sessionToAssignment.get(childSessionID)
        audit?.write(childSessionID, {
          subsystem: "delegation",
          event: "replacement_child_completed",
          assignment_id: assignmentID ?? null,
          stage: snapshot?.stage ?? "completed",
          status: snapshot?.status ?? "completed",
        })
        replacementSessions.delete(childSessionID)
      }
      watchdog.unregister(childSessionID)
      sessionJob.delete(childSessionID)
      sessionToAssignment.delete(childSessionID)
      pendingRequestStarted.delete(childSessionID)
      recovery.reset(childSessionID)
    },
    recordWorkerResult(jobID, result) {
      const action = ladder.record(jobID, result)
      const parent = jobSession.get(jobID)
      if (parent) {
        const anchors = result.findings.flatMap((f) => f.anchors ?? [])
        const locations = result.findings
          .filter((f) => f.type === "file" || f.type === "symbol")
          .map((f) => f.summary)
        if (result.adequate || anchors.length > 0 || locations.length > 0) {
          rootState.noteWorkerEvidence(parent, [...anchors, ...locations])
          audit?.write(parent, {
            subsystem: "delegation",
            event: "worker_evidence_available",
            job_id: jobID,
            anchor_count: anchors.length + locations.length,
          })
        }
        if (action.kind === "give_up") {
          rootState.noteEscalationExhausted(parent)
          audit?.write(parent, {
            subsystem: "delegation",
            event: "exceptional_root_takeover",
            job_id: jobID,
            reason: action.reason,
          })
        }
      }
      return action
    },
    findings(jobID) {
      return ladder.findings(jobID)
    },
    markRequestStarted(sessionID) {
      if (watchdog.sessions().includes(sessionID)) {
        watchdog.markRequestStarted(sessionID)
        const parent = sessionJob.get(sessionID)
        if (parent) satisfyWorkerRequirement(parent)
      } else {
        pendingRequestStarted.add(sessionID)
      }
    },
    recordModelUnavailable(sessionID, modelKey, reason) {
      availability.markUnavailable(modelKey, reason)
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "worker_model_unavailable",
        model: modelKey,
        reason,
      })

      const assignmentID = assignmentIDFor(sessionID)
      const assignment = assignmentID ? assignmentsById.get(assignmentID) : undefined

      if (!assignment || !sink?.relaunch) {
        watchdog.onTerminal(sessionID, "failed")
        void sink?.cancel?.(sessionID, reason)
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "retry_chain_exhausted",
          reason: "no_relaunch_sink_for_disabled_model",
          assignment_id: assignmentID ?? null,
        })
        return
      }

      const id = assignment.assignment_id
      const lineage = lineageByAssignment.get(id) ?? initialLineage(assignment)
      const selection = selectNextEligibleWorker(
        assignment.workers,
        lineage.worker_index,
        new Set(availability.unavailableKeys()),
      )
      if (selection.kind === "no_eligible_worker") {
        watchdog.onTerminal(sessionID, "failed")
        void sink.cancel(sessionID, reason)
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "retry_chain_exhausted",
          reason: "no_eligible_worker",
          assignment_id: id,
        })
        return
      }

      const nextLineage: RetryLineage = {
        attempt_number: lineage.attempt_number + 1,
        worker_index: selection.index,
        previous_workers: [...lineage.previous_workers, lineage.current_worker ?? modelKey],
        current_worker: selection.worker.model_id,
        failure_stage: "failed",
        failure_stall_mode: null,
        failure_reason: reason,
        findings: lineage.findings,
      }
      lineageByAssignment.set(id, nextLineage)

      const action: RedispatchAction = {
        kind: "alternate_worker",
        worker: selection.worker,
        worker_index: selection.index,
        preserveFindings: lineage.findings,
        reason: `model unavailable (disabled): ${modelKey}`,
      }
      const replacementPrompt = buildReplacementPrompt(assignment, nextLineage)
      const outcome = sink.relaunch(assignment, action, replacementPrompt)
      if (isThenable(outcome)) {
        void outcome.then((resolved) =>
          applyRelaunchOutcome(sessionID, id, nextLineage.attempt_number, selection.worker.model_id, resolved),
        )
      } else {
        applyRelaunchOutcome(sessionID, id, nextLineage.attempt_number, selection.worker.model_id, outcome)
      }
    },
    unavailableModels() {
      return availability.unavailableKeys()
    },
    getAvailabilityFilePath() {
      return availabilityFilePath
    },
    tryAcquirePaidChild() {
      return paidGate.tryAcquire()
    },
    markPaidChildSession(sessionID) {
      paidSessions.add(sessionID)
    },
    releasePaidChild() {
      paidGate.release()
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
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "worker_reclaimed",
        stall_mode: result.stallMode,
        stage: result.stage,
        assignment_id: assignmentIDFor(sessionID) ?? null,
      })

      const assignmentID = assignmentIDFor(sessionID)
      const assignment = assignmentID ? assignmentsById.get(assignmentID) : undefined

      if (decision.retry) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "worker_retry_started",
          stall_mode: result.stallMode,
          correlated: decision.correlated,
          alternate_worker: decision.correlated ? true : false,
        })
        if (assignment) {
          tryRedispatch(sessionID, assignment, result.stallMode, decision.correlated, result.stage)
        } else {
          audit?.write(sessionID, {
            subsystem: "delegation",
            event: "retry_chain_exhausted",
            reason: "no_retained_assignment",
            stall_mode: result.stallMode,
          })
        }
      } else {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "retry_chain_exhausted",
          reason: "same_worker_reclaim_budget_exhausted",
          stall_mode: result.stallMode,
          assignment_id: assignmentID ?? null,
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
      sessionToAssignment.delete(sessionID)
      replacementSessions.delete(sessionID)
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
      const beforePhase = rootState.phase(sessionID)
      const decision = rootState.decide(sessionID, tool, hint)

      if (decision.delegated) {
        if (beforePhase === "worker_required" || beforePhase === "worker_active") {
          audit?.write(sessionID, {
            subsystem: "delegation",
            event: "early_delegation_dispatched",
            session_id: sessionID,
          })
        }
        return {
          block: false,
          reason: null,
          steering: null,
          freeWorkerHint: null,
          signal: decision.signal,
          delegated: true,
          selectiveVerification: false,
        }
      }

      if (decision.selectiveVerification) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "selective_root_verification",
          tool,
        })
      }

      if (decision.block) {
        const newlyRequired =
          decision.phase === "worker_required" && beforePhase !== "worker_required"
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "root_grunt_blocked",
          reason: decision.reason,
          grunt_count: decision.signal.gruntCount,
          distinct_modules: decision.signal.distinctModules,
          phase: decision.phase,
        })
        if (newlyRequired) {
          audit?.write(sessionID, {
            subsystem: "delegation",
            event: "root_worker_required",
            reason: decision.reason,
            free_worker_hint: freeWorkerHint,
            context_pressure: contextPressure ?? null,
          })
        }
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
          free_worker_hint: freeWorkerHint,
          context_pressure: contextPressure ?? null,
        })
        if (decision.reason === REASON_ADDITIONAL) {
          audit?.write(sessionID, {
            subsystem: "delegation",
            event: "root_additional_delegation_required",
            reason: decision.reason,
            scope: decision.scope ?? null,
          })
        }

        return {
          block: true,
          reason: decision.reason,
          steering: buildWorkerFirstSteering(decision.reason, decision.scope),
          freeWorkerHint,
          signal: decision.signal,
          delegated: false,
          selectiveVerification: false,
        }
      }

      if (beforePhase === "bootstrap" && !bootstrapAudited.has(sessionID)) {
        bootstrapAudited.add(sessionID)
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "root_bootstrap_allowed",
          op_class: decision.opClass,
          phase: "bootstrap",
        })
      }

      return {
        block: false,
        reason: null,
        steering: null,
        freeWorkerHint: null,
        signal: decision.signal,
        delegated: false,
        selectiveVerification: decision.selectiveVerification,
      }
    },
    rootPhase(sessionID) {
      return rootState.phase(sessionID)
    },
    dispose() {
      watchdog.dispose()
      rootState.clear()
      jobSession.clear()
      sessionJob.clear()
      assignmentsById.clear()
      sessionToAssignment.clear()
      lineageByAssignment.clear()
      replacementSessions.clear()
      gruntWindows.clear()
      pendingRequestStarted.clear()
      bootstrapAudited.clear()
    },
  }
}

function buildWorkerFirstSteering(reason: string | null, scope: string | null): string {
  const bounded = scope && scope.length > 0 ? scope : "this task"
  if (reason === REASON_ADDITIONAL) {
    return [
      "ROOT_ADDITIONAL_DELEGATION_REQUIRED",
      `renewed broad investigation of ${bounded} requires another worker assignment;`,
      'delegate to a free worker (e.g. task with subagent_type "explore") and consume the returned anchors instead of re-crawling.',
    ].join(" ")
  }
  if (reason === REASON_WAIT) {
    return [
      "WORKER_ACTIVE",
      `a worker is already running for ${bounded}; wait for its result before broad root exploration.`,
      "Delegate additional independent investigations in parallel via task/call_omo_agent.",
    ].join(" ")
  }
  return [
    "ROOT_DELEGATION_REQUIRED",
    `reason: broad delegable work was attempted before a worker was dispatched (${reason ?? "unknown"}).`,
    "required_action: delegate",
    `suggested_scope: ${bounded}`,
    'Delegate the investigation to a free worker (e.g. task with subagent_type "explore" or "librarian") and consume the returned file/symbol/anchors instead of exploring the repository yourself. You may still read one specific file/line that a worker already identified.',
  ].join(" ")
}
