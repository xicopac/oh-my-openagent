/**
 * Availability-aware worker selection for disabled-model failover. When a
 * provider rejects a child with "Model is disabled", that model is marked
 * unavailable and the next eligible worker (not the failed one, not any
 * model already marked unavailable) is selected for automatic re-dispatch.
 * Pure and deterministic — the unavailable set and worker list are injected.
 */

import type { WorkerCandidate } from "../delegation-ladder"

export type AvailabilitySelectionResult =
  | { kind: "next_worker"; worker: WorkerCandidate; index: number }
  | { kind: "no_eligible_worker" }

/**
 * Select the next dispatchable worker after `currentIndex`, skipping any
 * worker whose model id is in `unavailable`. Escalation is forward-only: the
 * ladder is ordered cheapest-sufficient to strongest, so a disabled model
 * escalates to the next stronger eligible worker, never back to an earlier
 * rung. Returns `no_eligible_worker` when no later candidate remains, which is
 * a truthful hard failure (the assignment must not silently fall back to MAIN
 * grunt work).
 */
export function selectNextEligibleWorker(
  workers: readonly WorkerCandidate[],
  currentIndex: number,
  unavailable: ReadonlySet<string>,
): AvailabilitySelectionResult {
  for (let i = currentIndex + 1; i < workers.length; i += 1) {
    const worker = workers[i]
    if (unavailable.has(worker.model_id)) continue
    return { kind: "next_worker", worker, index: i }
  }
  return { kind: "no_eligible_worker" }
}
