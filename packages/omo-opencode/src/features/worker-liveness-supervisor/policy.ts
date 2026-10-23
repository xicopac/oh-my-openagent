/**
 * Phase 6: Delegation-liveness supervisor policy.
 *
 * All deadlines are monotonic ms arithmetic using the injected `now()` function.
 * maxAttempts counts total attempts (1-based): attempt=1 is the first try,
 * attempt=2 is the first retry. The default of 2 means one retry is allowed
 * before blocking.
 */

import type { SupervisorPolicy } from "./types"
/**
 * Default supervisor policy with all liveness deadlines.
 *
 * - launchAckDeadlineMs: 30_000 — parent must ACK within 30s of submit
 * - heartbeatIntervalMs: 30_000 — heartbeats expected every 30s
 * - missingHeartbeatDeadlineMs: 90_000 — no heartbeat for 90s => failure
 * - progressStallMs: 180_000 — no progress for 180s => stall (even with heartbeats)
 * - completionGraceMs: 10_000 — grace period after completion
 * - orphanIdleMs: 120_000 — running child with idle parent for 120s => orphaned
 * - maxAttempts: 2 — total attempts (1-based), one retry allowed
 * - circuitBreakerFailureThreshold: 3 — 3 failures open the circuit
 * - circuitBreakerCooldownMs: 300_000 — cooldown before breaker resets
 * - notificationBatchWindowMs: 60_000 — batching window for notifications
 */
export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = {
  launchAckDeadlineMs: 30_000,
  heartbeatIntervalMs: 30_000,
  missingHeartbeatDeadlineMs: 90_000,
  progressStallMs: 180_000,
  completionGraceMs: 10_000,
  orphanIdleMs: 120_000,
  maxAttempts: 2,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerCooldownMs: 300_000,
  notificationBatchWindowMs: 60_000,
}

/**
 * Applies policy overrides on top of defaults. Returns a new policy object.
 */
export function applyPolicyOverrides(
  base: SupervisorPolicy,
  overrides: Partial<SupervisorPolicy>,
): SupervisorPolicy {
  return {
    ...base,
    ...overrides,
  }
}