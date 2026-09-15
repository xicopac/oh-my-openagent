/**
 * Delegation Ladder — stateful facade. Owns per-job ladder state and the event
 * stream. `start` seeds a job and selects the first worker; `record` folds an
 * attempt result into accumulated findings and drives the pure decision core.
 * All event detail payloads are metadata only (ids, counters, tiers, booleans)
 * — never prompt text or finding summaries.
 */

import { recommendNextAction, type NextAction } from "./ladder"
import { refineAssignment } from "./refinement"
import type {
  AttemptResult,
  DelegationLadderConfig,
  Finding,
  JobState,
  WorkerCandidate,
} from "./types"
import { DEFAULT_DELEGATION_LADDER_CONFIG } from "./types"

export type DelegationLadderEvents =
  | "delegation_first_selected"
  | "worker_attempt_started"
  | "worker_attempt_inadequate"
  | "worker_prompt_refined"
  | "worker_model_escalated"

export type DelegationLadder = {
  start(jobID: string, prompt: string, workers: WorkerCandidate[]): void
  record(jobID: string, result: AttemptResult): NextAction
  findings(jobID: string): Finding[]
  get(jobID: string): JobState | undefined
  reset(jobID: string): void
}

export type DelegationLadderOptions = {
  onEvent?: (jobID: string, event: DelegationLadderEvents, detail?: Record<string, unknown>) => void
}

type InternalState = JobState & { totalFreeAttempts: number }

export function createDelegationLadder(
  config: Partial<DelegationLadderConfig> = {},
  opts: DelegationLadderOptions = {},
): DelegationLadder {
  const resolved: DelegationLadderConfig = { ...DEFAULT_DELEGATION_LADDER_CONFIG, ...config }
  const states = new Map<string, InternalState>()
  const emit = opts.onEvent

  function requireState(jobID: string): InternalState {
    const state = states.get(jobID)
    if (!state) {
      throw new Error(`delegation ladder: no job started for "${jobID}"`)
    }
    return state
  }

  function currentWorker(state: InternalState): WorkerCandidate {
    return state.workers[state.workerIndex]
  }

  function emitEvent(jobID: string, event: DelegationLadderEvents, detail?: Record<string, unknown>): void {
    if (emit) emit(jobID, event, detail)
  }

  return {
    start(jobID, prompt, workers) {
      const first = workers[0]
      const state: InternalState = {
        jobID,
        prompt,
        workers,
        workerIndex: 0,
        attemptsInTier: 0,
        totalAttempts: 0,
        findings: [],
        totalFreeAttempts: 0,
      }
      states.set(jobID, state)

      emitEvent(jobID, "delegation_first_selected", {
        job_id: jobID,
        worker: first.model_id,
        tier: first.tier,
        free: first.free,
      })
      emitEvent(jobID, "worker_attempt_started", {
        job_id: jobID,
        worker: first.model_id,
        tier: first.tier,
        free: first.free,
        attempt: 1,
      })
    },

    record(jobID, result) {
      const state = requireState(jobID)

      for (const finding of result.findings) {
        state.findings.push(finding)
      }
      for (const item of result.unresolved) {
        state.findings.push({ type: "unresolved", summary: item })
      }

      state.totalAttempts += 1
      state.attemptsInTier += 1
      if (currentWorker(state).free) {
        state.totalFreeAttempts += 1
      }

      if (result.adequate) {
        return { kind: "done" }
      }

      const worker = currentWorker(state)
      emitEvent(jobID, "worker_attempt_inadequate", {
        job_id: jobID,
        worker: worker.model_id,
        tier: worker.tier,
        free: worker.free,
        attempt: state.totalAttempts,
      })

      const refinedPrompt = refineAssignment(state.prompt, result)
      const action = recommendNextAction({
        attemptsInTier: state.attemptsInTier,
        totalFreeAttempts: state.totalFreeAttempts,
        currentWorker: worker,
        result,
        workers: state.workers,
        config: resolved,
        refinedPrompt,
      })

      if (action.kind === "retry_refined") {
        emitEvent(jobID, "worker_prompt_refined", {
          job_id: jobID,
          worker: worker.model_id,
          tier: worker.tier,
          free: worker.free,
          attempt: state.totalAttempts,
        })
        return action
      }

      if (action.kind === "escalate") {
        state.workerIndex += 1
        state.attemptsInTier = 0
        const next = currentWorker(state)
        emitEvent(jobID, "worker_model_escalated", {
          job_id: jobID,
          from: worker.model_id,
          to: next.model_id,
          tier: next.tier,
          free: next.free,
          reason: action.reason,
        })
        return action
      }

      return action
    },

    findings(jobID) {
      const state = states.get(jobID)
      return state ? [...state.findings] : []
    },

    get(jobID) {
      const state = states.get(jobID)
      if (!state) return undefined
      return {
        jobID: state.jobID,
        prompt: state.prompt,
        workers: state.workers,
        workerIndex: state.workerIndex,
        attemptsInTier: state.attemptsInTier,
        totalAttempts: state.totalAttempts,
        findings: state.findings,
      }
    },

    reset(jobID) {
      states.delete(jobID)
    },
  }
}
