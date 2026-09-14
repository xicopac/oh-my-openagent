/**
 * Worker health classification from cheap signals. Deterministic, no model
 * inspection. Budget-aware: paid workers are held to stricter stall thresholds.
 */

import type { SupervisionPolicy, WorkerHealth, WorkerSignal } from "./types"

export type Classification = {
  health: WorkerHealth
  reason: string
}

export function classifyWorker(signal: WorkerSignal, policy: SupervisionPolicy): Classification {
  if (signal.status === "starting" || signal.status === "pending") {
    return { health: "STARTING", reason: "within startup grace" }
  }
  if (signal.status === "completed" || signal.status === "error" || signal.status === "cancelled") {
    return { health: "HEALTHY", reason: "terminal state" }
  }

  const quietThreshold = signal.isPaid ? policy.paidQuietStallThresholdMs : policy.quietStallThresholdMs
  const quietFor = signal.nowMs - signal.lastActivityAtMs

  if (signal.childTokenBudget > 0) {
    const fraction = signal.childTokensUsed / signal.childTokenBudget
    if (fraction >= 1) return { health: "EXHAUSTED", reason: "child token budget reached" }
    if (fraction >= policy.budgetWarnFraction) {
      return { health: "BUDGET_WARNING", reason: "worker approaching child budget" }
    }
  }

  if (signal.isLongRunningCommand) {
    if (signal.commandActive || signal.outputTail.length > 0) {
      if (signal.commandElapsedMs < policy.wedgedThresholdMs) {
        return { health: "LONG_RUNNING", reason: "build/test command advancing" }
      }
    }
    if (!signal.commandActive && signal.commandElapsedMs >= policy.wedgedThresholdMs) {
      return { health: "WEDGED", reason: "long command stalled without CPU/IO" }
    }
  }

  const noActivity = quietFor >= quietThreshold
  const burningTokens = signal.tokensDelta >= policy.tokenBurnThreshold
  const noStateChange = signal.outputTail.length === 0 && signal.filesChangedDelta === 0

  if (noActivity && burningTokens && noStateChange) {
    return { health: "TOKEN_BURN", reason: "tokens rising with no state change" }
  }
  if (noActivity) {
    return { health: "QUIET_STALL", reason: "quiet past stall threshold" }
  }

  return { health: "HEALTHY", reason: "active" }
}

/** Whether a classification warrants moving down the intervention ladder. */
export function isInsecure(health: WorkerHealth): boolean {
  return (
    health === "QUIET_STALL" ||
    health === "LOOP" ||
    health === "TOKEN_BURN" ||
    health === "WEDGED"
  )
}
