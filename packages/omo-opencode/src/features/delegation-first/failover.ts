/**
 * Stall-aware failover decision core. Given a timed-out stall, the retained
 * assignment's ladder, and the retry lineage, decide the next action: retry
 * the same worker, switch to an alternate worker/model, escalate up the
 * ladder, or give up. Stage information and correlated-failure signals change
 * the decision so a provider-response stall does not blindly re-fire the same
 * broken model/provider.
 */

import type {
  DelegationLadderConfig,
  Finding,
  WorkerCandidate,
} from "../delegation-ladder"
import type { StallMode } from "../worker-supervisor"

export type FailoverAction =
  | {
      kind: "retry_worker"
      worker: WorkerCandidate
      worker_index: number
      preserveFindings: Finding[]
      reason: string
    }
  | {
      kind: "alternate_worker"
      worker: WorkerCandidate
      worker_index: number
      preserveFindings: Finding[]
      reason: string
    }
  | {
      kind: "escalate_worker"
      worker: WorkerCandidate
      worker_index: number
      preserveFindings: Finding[]
      reason: string
    }
  | { kind: "give_up"; reason: "retry_chain_exhausted" | "no_sufficient_worker" }

/** A failover action that carries a dispatchable worker (i.e. not give_up). */
export type RedispatchAction = Exclude<FailoverAction, { kind: "give_up" }>

export type FailoverContext = {
  workers: WorkerCandidate[]
  /** Attempts already run for this assignment (>= 1, the failing one included). */
  attempt_number: number
  /** Index of the worker used for the failing attempt. */
  worker_index: number
  /** Model ids of PRIOR attempts (excluding the failing one), in order. */
  previous_workers: string[]
  config: DelegationLadderConfig
  stallMode: StallMode
  correlated: boolean
  findings: Finding[]
}

function maxTotalAttempts(config: DelegationLadderConfig, workers: WorkerCandidate[]): number {
  return Math.max(1, config.max_attempts_per_tier) * Math.max(1, workers.length)
}

/** Consecutive tail of `previous_workers` equal to `model_id` (excludes current). */
function consecutiveSameWorker(previous_workers: string[], model_id: string): number {
  let count = 0
  for (let i = previous_workers.length - 1; i >= 0; i -= 1) {
    if (previous_workers[i] === model_id) count += 1
    else break
  }
  return count
}

/** Next worker at a different model id (same provider allowed, distinct model). */
function nextDifferentModel(
  workers: WorkerCandidate[],
  currentIndex: number,
): { worker: WorkerCandidate; index: number } | undefined {
  const current = workers[currentIndex]
  if (!current) return undefined
  for (let i = 0; i < workers.length; i += 1) {
    const candidate = workers[i]
    if (i !== currentIndex && candidate.model_id !== current.model_id) {
      return { worker: candidate, index: i }
    }
  }
  return undefined
}

function nextWorkerInLadder(
  workers: WorkerCandidate[],
  currentIndex: number,
): { worker: WorkerCandidate; index: number } | undefined {
  const index = currentIndex + 1
  const worker = workers[index]
  return worker ? { worker, index } : undefined
}

/**
 * Decide the next action after a timed-out stall. Pure and deterministic.
 */
export function recommendFailoverAction(ctx: FailoverContext): FailoverAction {
  const { workers, attempt_number, worker_index, previous_workers, config, stallMode, correlated, findings } =
    ctx
  const current = workers[worker_index] ?? workers[0]
  const preserveFindings = findings

  // Hard bound: no relaunch past the ladder's attempt ceiling.
  if (attempt_number >= maxTotalAttempts(config, workers)) {
    return { kind: "give_up", reason: "retry_chain_exhausted" }
  }

  // Free-attempt ceiling: never spin past the allowed free budget before
  // escalating to a paid tier or giving up.
  if (current && current.free && attempt_number >= config.max_free_attempts_total) {
    const escalated = nextWorkerInLadder(workers, worker_index)
    if (escalated) {
      return {
        kind: "escalate_worker",
        worker: escalated.worker,
        worker_index: escalated.index,
        preserveFindings,
        reason: "free_exhausted",
      }
    }
    return { kind: "give_up", reason: "no_sufficient_worker" }
  }

  // Infrastructure stalls (dispatch / provider-start) are launch failures, not
  // bad reasoning: re-fire the same worker, no model switch.
  if (stallMode === "DISPATCH_STALL" || stallMode === "PROVIDER_START_STALL") {
    return {
      kind: "retry_worker",
      worker: current,
      worker_index,
      preserveFindings,
      reason: "infrastructure stall, retry same worker",
    }
  }

  // A correlated failure or a provider that never responded means the current
  // provider/model is likely broken: prefer an alternate model/provider.
  if (correlated || stallMode === "PROVIDER_RESPONSE_STALL") {
    const alt = nextDifferentModel(workers, worker_index)
    if (alt) {
      return {
        kind: "alternate_worker",
        worker: alt.worker,
        worker_index: alt.index,
        preserveFindings,
        reason: correlated
          ? "correlated provider/model failure, alternate target"
          : "provider response stall, alternate provider/model",
      }
    }
    const escalated = nextWorkerInLadder(workers, worker_index)
    if (escalated) {
      return {
        kind: "escalate_worker",
        worker: escalated.worker,
        worker_index: escalated.index,
        preserveFindings,
        reason: "no alternate model for provider response stall",
      }
    }
    return {
      kind: "retry_worker",
      worker: current,
      worker_index,
      preserveFindings,
      reason: "no alternate target, bounded retry same worker",
    }
  }

  // Repeated execution/tool stalls on the same worker escalate up the ladder.
  const sameWorkerAttempts = 1 + consecutiveSameWorker(previous_workers, current.model_id)
  if (sameWorkerAttempts >= config.escalate_after_attempts) {
    const escalated = nextWorkerInLadder(workers, worker_index)
    if (escalated) {
      return {
        kind: "escalate_worker",
        worker: escalated.worker,
        worker_index: escalated.index,
        preserveFindings,
        reason: "attempt_threshold",
      }
    }
    return { kind: "give_up", reason: "no_sufficient_worker" }
  }

  // Default: execution/tool stall -> retry the same worker (possibly refined),
  // preserving partial work.
  return {
    kind: "retry_worker",
    worker: current,
    worker_index,
    preserveFindings,
    reason: "execution stall, retry same worker",
  }
}
