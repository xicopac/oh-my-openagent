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
  REASON_RECOVERY_SCOPE,
  REASON_RECOVERY_TERMINAL,
  type DelegationFailureEvidence,
  type DelegationFailureTransition,
  type DelegationRecoverySnapshot,
  type RootWorkerPhase,
  type RootWorkerState,
} from "./root-worker-state"
import type { HumanExplicitAuthorization } from "./human-explicit-authorization"
import {
  createWatchdog,
  createRecoveryCoordinator,
  DEFAULT_RECOVERY_POLICY,
  type ChildStage,
  type RecoveryCoordinator,
  type RecoveryPolicy,
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
import { extractEvidenceAnchors } from "./worker-evidence"
import {
  buildReplacementPrompt,
  initialLineage,
  type ReplayableAssignment,
  type RetryLineage,
} from "./replay"
import * as crypto from "node:crypto"
import { discoverFreeModels, type PricingCatalog } from "../../hooks/resource-governor/pricing"
import type { GovernanceAuditWriter } from "../../shared/governance-audit"

export type DelegationFirstConfig = {
  ladder?: Partial<DelegationLadderConfig>
  watchdog?: Partial<WatchdogPolicy>
  timeouts?: Partial<StallTimeoutPolicy>
  grunt?: Partial<GruntGuardOptions>
  recovery?: Partial<RecoveryPolicy>
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
   * Register worker evidence for a completed background child. Unlike the
   * sync ladder path (`recordWorkerResult`), background children return plain
   * text; the anchors are extracted deterministically from that text so the
   * root may perform anchored verification reads after the child completes.
   */
  noteChildEvidence(parentSessionID: string, resultText: string): void
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
  /** Registered worker-evidence anchors for a root session (observability + tests). */
  evidenceAnchors(sessionID: string): string[]
  /** Record a machine-observed delegation failure (deduplicated by evidence id). */
  recordDelegationFailure(sessionID: string, evidence: DelegationFailureEvidence): DelegationFailureTransition
  /** A retry/replacement child reaching request-started proves delegation healthy again. */
  noteDelegationHealthy(sessionID: string): void
  /** Begin the single end-to-end recovery probe (real child through production delegation). */
  beginRecoveryProbe(sessionID: string, probeID: string, nonce: string): boolean
  /** Mark recovery verified after the probe returns the expected result. */
  markRecoveryVerified(sessionID: string, probeID: string): boolean
  /** Record a failed recovery probe (bounded attempts; halt on exhaustion). */
  recordRecoveryProbeFailure(sessionID: string, probeID: string, reason: string): RootWorkerPhase
  /** Record the handoff file path; transitions recovery_verified -> handoff. */
  markRecoveryHandoff(sessionID: string, path: string): boolean
  /** Halt the session after handoff. */
  markRecoveryHalted(sessionID: string): void
  /** Snapshot of the recovery state machine for observability/handoff. */
  recoverySnapshot(sessionID: string): DelegationRecoverySnapshot
  /** Signal a child failed to launch (startup/0ms/EACCES) - records delegation-failure evidence. */
  noteChildStartupFailure(parentSessionID: string, childSessionID: string | null, reason: string): void
  /** Signal the evidence pipeline broke (worker completed but root never saw evidence). */
  noteEvidencePipelineBroken(parentSessionID: string, childSessionID: string | null, reason: string): void
  /** Current failure reason for a root session, if degraded or in recovery. */
  rootRepairReason(sessionID: string): string | null
  /** True when `sessionID` is a registered worker child (nested child detection). */
  isChildSession(sessionID: string): boolean
  /** Register an explicit human authorization for a root session (trusted channel only). */
  grantHumanAuthorization(sessionID: string, auth: HumanExplicitAuthorization): void
  /** Human authorizations registered for a session (observability + tests). */
  humanAuthorizations(sessionID: string): readonly HumanExplicitAuthorization[]
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

  const recoveryPolicy: RecoveryPolicy = { ...DEFAULT_RECOVERY_POLICY, ...cfg.recovery }
  const recovery: RecoveryCoordinator = createRecoveryCoordinator(cfg.recovery)
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
    // DELEGATION_DEGRADED: a replacement/retry child that reaches request-started
    // proves the delegation path works again; return to normal worker-first.
    if (before === "delegation_degraded") {
      rootState.noteDelegationHealthy(sessionID)
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "delegation_healthy",
        session_id: sessionID,
      })
      return
    }
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
      // NOTE: the episode reclaim budget is intentionally NOT reset here. It is
      // keyed by the stable assignment_id, and detaching a child (whether it was
      // cancelled mid-redispatch or completed) does not end the logical episode.
      // Redispatch to a replacement child MUST keep the shared budget so the
      // sequence stall -> redispatch -> stall eventually exhausts ONE bounded
      // budget instead of looping forever.
      sessionJob.delete(childSessionID)
      sessionToAssignment.delete(childSessionID)
      pendingRequestStarted.delete(childSessionID)
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
          // Repeated worker failure: record machine-observable routing evidence.
          // Recovery authority is derived only from accumulated evidence, not from
          // an assertion; exceptional takeover no longer exists as a phase.
          rootState.recordDelegationFailure(parent, {
            id: `give-up:${jobID}`,
            kind: "routing_exhausted",
            reason: action.reason,
            observedAtMs: Date.now(),
            taskID: jobID,
          })
          audit?.write(parent, {
            subsystem: "delegation",
            event: "delegation_failure_recorded",
            kind: "routing_exhausted",
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
    noteChildEvidence(parentSessionID, resultText) {
      const anchors = extractEvidenceAnchors(resultText)
      if (anchors.length === 0) return
      rootState.noteWorkerEvidence(parentSessionID, anchors)
      audit?.write(parentSessionID, {
        subsystem: "delegation",
        event: "worker_evidence_available",
        anchor_count: anchors.length,
      })
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
        const parentID = sessionJob.get(sessionID) ?? assignment?.parent_session_id
        if (parentID) {
          rootState.recordDelegationFailure(parentID, {
            id: `routing-no-relaunch-sink:${sessionID}`,
            kind: "routing_exhausted",
            reason: "routing_no_relaunch_sink",
            observedAtMs: Date.now(),
            taskID: sessionID,
          })
          audit?.write(parentID, {
            subsystem: "delegation",
            event: "delegation_failure_recorded",
            kind: "routing_exhausted",
            reason: "routing_no_relaunch_sink",
            model: modelKey,
            assignment_id: assignmentID ?? null,
          })
        }
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
        const parentID = sessionJob.get(sessionID) ?? assignment.parent_session_id
        rootState.recordDelegationFailure(parentID, {
          id: `routing-no-eligible:${id}`,
          kind: "routing_exhausted",
          reason: "routing_no_eligible_worker",
          observedAtMs: Date.now(),
          taskID: id,
        })
        audit?.write(parentID, {
          subsystem: "delegation",
          event: "delegation_failure_recorded",
          kind: "routing_exhausted",
          reason: "routing_no_eligible_worker",
          model: modelKey,
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
      const episodeKey = assignmentIDFor(sessionID) ?? sessionID
      const snapshot = watchdog.snapshot(sessionID)
      const atMs = nowMs ?? Date.now()
      const durationMs = snapshot ? atMs - snapshot.lastChangeAtMs : 0
      if (snapshot && durationMs >= recoveryPolicy.hardStallTerminalMs) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "hard_circuit_breaker_tripped",
          stall_mode: result.stallMode,
          stage: result.stage,
          duration_ms: durationMs,
        })
        const parentID = sessionJob.get(sessionID)
        if (parentID) {
          rootState.recordDelegationFailure(parentID, {
            id: `hard-breaker:${episodeKey}`,
            kind: "watchdog_reclaim_exhausted",
            reason: "hard_circuit_breaker",
            observedAtMs: Date.now(),
            taskID: sessionID,
          })
          audit?.write(parentID, {
            subsystem: "delegation",
            event: "delegation_failure_recorded",
            kind: "watchdog_reclaim_exhausted",
            reason: "hard_circuit_breaker",
            stall_mode: result.stallMode,
            session_id: sessionID,
            duration_ms: durationMs,
          })
        }
        watchdog.onTerminal(sessionID, "cancelled")
        void sink?.cancel(sessionID, `hard circuit breaker tripped after ${durationMs}ms in ${result.stallMode}`)
        return
      }
      const decision = recovery.evaluate(episodeKey, providerModel, result.stallMode, true, nowMs)
      if (decision.kind !== "reclaim") return

      recovery.recordReclaim(episodeKey, providerModel, nowMs)
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
          const parentID = sessionJob.get(sessionID)
          if (parentID) {
            rootState.recordDelegationFailure(parentID, {
              id: `stall-exhausted:${sessionID}`,
              kind: "watchdog_reclaim_exhausted",
              reason: "worker_stall_exhausted",
              observedAtMs: Date.now(),
              taskID: sessionID,
            })
            audit?.write(parentID, {
              subsystem: "delegation",
              event: "delegation_failure_recorded",
              kind: "watchdog_reclaim_exhausted",
              reason: "worker_stall_exhausted",
              stall_mode: result.stallMode,
              session_id: sessionID,
            })
          }
        }
      } else {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "retry_chain_exhausted",
          reason: "same_worker_reclaim_budget_exhausted",
          stall_mode: result.stallMode,
          assignment_id: assignmentID ?? null,
        })
        const parentID = sessionJob.get(sessionID)
        if (parentID) {
          rootState.recordDelegationFailure(parentID, {
            id: `reclaim-budget:${episodeKey}`,
            kind: "watchdog_reclaim_exhausted",
            reason: "worker_stall_exhausted",
            observedAtMs: Date.now(),
            taskID: sessionID,
          })
          audit?.write(parentID, {
            subsystem: "delegation",
            event: "delegation_failure_recorded",
            kind: "watchdog_reclaim_exhausted",
            reason: "worker_stall_exhausted",
            stall_mode: result.stallMode,
            session_id: sessionID,
          })
        }
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
      // RECOVERY MODE: the single recovery probe is a real `task` child. The
      // recovery scope allows `task` only when an active probe exists, so the
      // runtime synthesizes the machine-consumed `recoveryProbe` hint here.
      // AUTO-BEGIN PROBE: when in recovery_mode with no active probe, a real
      // `task` call from a root session auto-starts the probe (machine-generated
      // probeID/nonce via real state, never by assertion). Child sessions never
      // auto-begin.
      let snapshot = rootState.recoverySnapshot(sessionID)
      let effectiveHint = hint
      if (snapshot.phase === "recovery_mode" && tool?.toLowerCase() === "task" && !sessionJob.has(sessionID)) {
        if (snapshot.activeProbe === null) {
          const probeID = `probe-${Date.now()}`
          let nonce: string
          try {
            nonce = crypto.randomBytes(16).toString("hex")
          } catch {
            nonce = Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)
          }
          const started = rootState.beginRecoveryProbe(sessionID, probeID, nonce)
          if (started) {
            audit?.write(sessionID, {
              subsystem: "delegation",
              event: "recovery_probe_started",
              probe_id: probeID,
              session_id: sessionID,
            })
            snapshot = rootState.recoverySnapshot(sessionID)
          }
        }
        if (snapshot.activeProbe) {
          effectiveHint = { ...(hint ?? {}), recoveryProbe: true }
        }
      } else if (
        snapshot.phase === "recovery_mode"
        && snapshot.activeProbe
        && tool?.toLowerCase() === "task"
      ) {
        effectiveHint = { ...(hint ?? {}), recoveryProbe: true }
      }
      const decision = rootState.decide(sessionID, tool, effectiveHint)

      if (decision.humanAuthorized === true) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "root_human_authorized_action",
          tool,
          op_class: decision.opClass,
          phase: beforePhase,
          authorization_id: decision.authorizationId ?? null,
          authorization_scope: decision.authorizationScope ?? null,
        })
        return {
          block: false,
          reason: null,
          steering: null,
          freeWorkerHint: null,
          signal: decision.signal,
          delegated: false,
          selectiveVerification: decision.selectiveVerification,
          humanAuthorized: true,
          authorizationId: decision.authorizationId ?? null,
          authorizationScope: decision.authorizationScope ?? null,
        }
      }

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

      if (decision.materializationCategory !== undefined && decision.materializationCategory !== null) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "root_materialization_action",
          tool,
          op_class: decision.opClass,
          phase: beforePhase,
          materialization_category: decision.materializationCategory,
        })
        return {
          block: false,
          reason: null,
          steering: null,
          freeWorkerHint: null,
          signal: decision.signal,
          delegated: false,
          selectiveVerification: decision.selectiveVerification,
          materializationAuthorized: true,
          materializationCategory: decision.materializationCategory,
        }
      }

      if (beforePhase === "recovery_mode" && decision.recoveryCategory) {
        // RECOVERY MODE: the root is authorized to perform recovery-scope work
        // directly. Record each substantive scoped action for auditability.
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "root_recovery_action",
          tool,
          op_class: decision.opClass,
          phase: "recovery_mode",
          recovery_category: decision.recoveryCategory,
        })
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

      const recoveryAuthorized = beforePhase === "recovery_mode" && decision.recoveryCategory !== null

      return {
        block: false,
        reason: null,
        steering: null,
        freeWorkerHint: null,
        signal: decision.signal,
        delegated: false,
        selectiveVerification: decision.selectiveVerification,
        ...(recoveryAuthorized
          ? { recoveryAuthorized: true, recoveryCategory: decision.recoveryCategory }
          : {}),
      }
    },
    isChildSession(sessionID) {
      return sessionJob.has(sessionID)
    },
    rootPhase(sessionID) {
      return rootState.phase(sessionID)
    },
    evidenceAnchors(sessionID) {
      return rootState.evidenceAnchors(sessionID)
    },
    rootRepairReason(sessionID) {
      return rootState.repairReason(sessionID)
    },
    grantHumanAuthorization(sessionID, auth) {
      rootState.grantHumanAuthorization(sessionID, auth)
    },
    humanAuthorizations(sessionID) {
      return rootState.humanAuthorizations(sessionID)
    },
    recordDelegationFailure(sessionID, evidence) {
      const transition = rootState.recordDelegationFailure(sessionID, evidence)
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "delegation_failure_recorded",
        kind: evidence.kind,
        reason: evidence.reason,
        evidence_id: evidence.id,
        accepted: transition.accepted,
        before_phase: transition.before,
        after_phase: transition.after,
      })
      return transition
    },
    noteDelegationHealthy(sessionID) {
      rootState.noteDelegationHealthy(sessionID)
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "delegation_healthy",
        session_id: sessionID,
      })
    },
    beginRecoveryProbe(sessionID, probeID, nonce) {
      // A nested child cannot begin a recovery probe for itself. Recovery
      // authority belongs to the true root/master session.
      if (sessionJob.has(sessionID)) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "nested_child_probe_rejected",
          session_id: sessionID,
        })
        return false
      }
      const started = rootState.beginRecoveryProbe(sessionID, probeID, nonce)
      if (started) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "recovery_probe_started",
          probe_id: probeID,
          session_id: sessionID,
        })
      }
      return started
    },
    markRecoveryVerified(sessionID, probeID) {
      const verified = rootState.markRecoveryVerified(sessionID, probeID)
      if (verified) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "recovery_verified",
          probe_id: probeID,
          session_id: sessionID,
        })
      }
      return verified
    },
    recordRecoveryProbeFailure(sessionID, probeID, reason) {
      const after = rootState.recordRecoveryProbeFailure(sessionID, probeID, reason)
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "recovery_probe_failed",
        probe_id: probeID,
        reason,
        after_phase: after,
        session_id: sessionID,
      })
      return after
    },
    markRecoveryHandoff(sessionID, path) {
      const marked = rootState.markRecoveryHandoff(sessionID, path)
      if (marked) {
        audit?.write(sessionID, {
          subsystem: "delegation",
          event: "recovery_handoff",
          path,
          session_id: sessionID,
        })
      }
      return marked
    },
    markRecoveryHalted(sessionID) {
      rootState.markRecoveryHalted(sessionID)
      audit?.write(sessionID, {
        subsystem: "delegation",
        event: "recovery_halted",
        session_id: sessionID,
      })
    },
    recoverySnapshot(sessionID) {
      return rootState.recoverySnapshot(sessionID)
    },
    noteChildStartupFailure(parentSessionID, childSessionID, reason) {
      audit?.write(parentSessionID, {
        subsystem: "delegation",
        event: "delegation_failure_recorded",
        kind: "child_startup_failure",
        reason: "child_startup_failure",
        child_session_id: childSessionID ?? null,
        failure_reason: reason,
      })
      rootState.recordDelegationFailure(parentSessionID, {
        id: childSessionID ?? `child-startup:${reason}`,
        kind: "child_startup_failure",
        reason: "child_startup_failure",
        observedAtMs: Date.now(),
        taskID: childSessionID ?? undefined,
        childSessionID: childSessionID ?? null,
      })
    },
    noteEvidencePipelineBroken(parentSessionID, childSessionID, reason) {
      audit?.write(parentSessionID, {
        subsystem: "delegation",
        event: "delegation_failure_recorded",
        kind: "evidence_pipeline_failure",
        reason: "evidence_pipeline_broken",
        child_session_id: childSessionID ?? null,
        failure_reason: reason,
      })
      rootState.recordDelegationFailure(parentSessionID, {
        id: childSessionID ?? `evidence-pipeline:${reason}`,
        kind: "evidence_pipeline_failure",
        reason: "evidence_pipeline_broken",
        observedAtMs: Date.now(),
        taskID: childSessionID ?? undefined,
        childSessionID: childSessionID ?? null,
      })
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
  if (reason === REASON_RECOVERY_SCOPE) {
    return [
      "OUTSIDE_DELEGATION_RECOVERY_SCOPE",
      `the delegation control plane is under repair; direct root work for ${bounded} is outside the approved recovery scope.`,
      "Only recovery-scope inspection/repair/validation of the delegation/watchdog machinery is permitted until delegation is verified healthy.",
    ].join(" ")
  }
  if (reason === REASON_RECOVERY_TERMINAL) {
    return [
      "DELEGATION_RECOVERY_HALTED",
      "delegation recovery has reached a terminal phase (verified/handoff/halt); no further work is permitted in this session.",
      "Capture proof, write the handoff file, and halt. Do not resume the original task.",
    ].join(" ")
  }
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
