/**
 * Delegation Ladder — pure decision core. Given the current worker, the
 * attempt counters, and an inadequate result, decide the next action: done,
 * retry with a refined assignment (same worker), escalate to the next worker
 * model, or give up. Deterministic and side-effect-free; free/paid/cost come
 * only from WorkerCandidate, never from a model id.
 */

import type {
  AttemptResult,
  DelegationLadderConfig,
  Finding,
  WorkerCandidate,
} from "./types"

export type NextAction =
  | { kind: "done" }
  | { kind: "retry_refined"; refinedPrompt: string; preserveFindings: Finding[]; sameWorker: WorkerCandidate }
  | { kind: "escalate"; worker: WorkerCandidate; preserveFindings: Finding[]; reason: "attempt_threshold" | "free_exhausted" }
  | { kind: "give_up"; reason: "no_sufficient_worker" | "expert_exhausted" }

export type RecommendNextActionInput = {
  attemptsInTier: number
  totalFreeAttempts: number
  currentWorker: WorkerCandidate
  result: AttemptResult
  workers: WorkerCandidate[]
  config: DelegationLadderConfig
  refinedPrompt: string
}

export function recommendNextAction(input: RecommendNextActionInput): NextAction {
  const { attemptsInTier, totalFreeAttempts, currentWorker, result, workers, config, refinedPrompt } = input

  if (result.adequate) {
    return { kind: "done" }
  }

  const preserveFindings = result.findings

  const canRetry =
    attemptsInTier < config.escalate_after_attempts &&
    totalFreeAttempts < config.max_free_attempts_total

  if (canRetry) {
    return { kind: "retry_refined", refinedPrompt, preserveFindings, sameWorker: currentWorker }
  }

  const next = nextWorkerAfter(workers, currentWorker)
  if (next) {
    const reason = attemptsInTier >= config.escalate_after_attempts ? "attempt_threshold" : "free_exhausted"
    return { kind: "escalate", worker: next, preserveFindings, reason }
  }

  const reason = currentWorker.tier === "expert" ? "expert_exhausted" : "no_sufficient_worker"
  return { kind: "give_up", reason }
}

function nextWorkerAfter(workers: WorkerCandidate[], current: WorkerCandidate): WorkerCandidate | undefined {
  const index = workers.findIndex((w) => w.model_id === current.model_id)
  if (index < 0) return undefined
  return workers[index + 1]
}
