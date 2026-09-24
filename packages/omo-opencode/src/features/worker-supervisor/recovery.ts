import type { StallMode } from "./types"

/**
 * Recovery policy + correlated-stall tracker. Decides, from a timed-out stall,
 * whether to reclaim the child and whether a retry is worthwhile, and detects
 * correlated parallel stalls (several children failing at the same provider /
 * model within a short window) so the supervisor does not blindly relaunch
 * identical workers into the same failure mode.
 *
 * The reclaim budget is scoped to a LOGICAL delegation/recovery episode
 * (the assignment_id), so redispatch to replacement child sessions MUST NOT
 * reset it. A sequence worker-stall -> redispatch -> new child session ->
 * stall -> redispatch MUST eventually exhaust ONE shared bounded recovery
 * budget for that episode.
 */
export type RecoveryPolicy = {
  /**
   * Reclaims allowed against one logical episode before the supervisor gives up.
   * The reclaim budget is scoped to a LOGICAL delegation/recovery episode
   * (the assignment_id), so redispatch to replacement child sessions MUST NOT
   * reset it.
   */
  sameWorkerMaxReclaims: number
  /** Window in which several same-provider/model reclamations count as correlated. */
  correlatedWindowMs: number
  /** Number of same-provider/model reclamations that mark a correlation. */
  correlatedMinCount: number
  /**
   * Hard circuit breaker: if a child has remained in the SAME no-progress
   * stall state for >= this duration, the runtime MUST hard-terminal it
   * regardless of retry budget. Prevents infinite loops when a worker is
   * wedged. A stuck worker is cancelled cleanly and evidence is recorded.
   */
  hardStallTerminalMs: number
}

/**
 * The reclaim budget is scoped to a LOGICAL delegation/recovery episode
 * (the assignment_id), so redispatch to replacement child sessions MUST NOT
 * reset it.
 */
export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  sameWorkerMaxReclaims: 1,
  correlatedWindowMs: 120_000,
  correlatedMinCount: 2,
  hardStallTerminalMs: 900_000,
}

export type RecoveryDecision =
  | { kind: "observe"; reason: string }
  | { kind: "reclaim"; reason: string; retry: boolean; correlated: boolean }

/**
 * Recovery coordinator keyed by a stable logical episode key (the assignment_id),
 * NOT per-child sessionID. The reclaim budget belongs to the stable logical
 * delegation/recovery episode, so redispatch to replacement child sessions
 * MUST NOT reset it.
 */
export type RecoveryCoordinator = {
  evaluate(
    episodeKey: string,
    providerModel: string | null,
    mode: StallMode,
    timedOut: boolean,
    nowMs?: number,
  ): RecoveryDecision
  recordReclaim(episodeKey: string, providerModel: string | null, nowMs?: number): void
  reclaimCount(episodeKey: string): number
  reset(episodeKey: string): void
}

export function createRecoveryCoordinator(
  policy: Partial<RecoveryPolicy> = DEFAULT_RECOVERY_POLICY,
  now?: () => number,
): RecoveryCoordinator {
  const resolved: RecoveryPolicy = { ...DEFAULT_RECOVERY_POLICY, ...policy }
  const clock = now ?? (() => Date.now())
  const episodeReclaims = new Map<string, number>()
  const reclaimHistory: Array<{ key: string; atMs: number }> = []
  function correlatedFor(providerModel: string | null, atMs: number): boolean {
    if (!providerModel) return false
    const matches = reclaimHistory.filter(
      (r) => r.key === providerModel && atMs - r.atMs <= resolved.correlatedWindowMs,
    )
    return matches.length + 1 >= resolved.correlatedMinCount
  }

  return {
    evaluate(episodeKey, providerModel, mode, timedOut, nowMs) {
      const atMs = nowMs ?? clock()
      if (!timedOut || mode === "QUIET_BUT_ACTIVE") {
        return { kind: "observe", reason: "not a timed-out stall" }
      }
      const correlated = correlatedFor(providerModel, atMs)
      const reclaims = episodeReclaims.get(episodeKey) ?? 0
      if (reclaims >= resolved.sameWorkerMaxReclaims) {
        return {
          kind: "reclaim",
          reason: `stalled (${mode}); same-worker reclaim budget exhausted`,
          retry: false,
          correlated,
        }
      }
      return {
        kind: "reclaim",
        reason: `stalled (${mode})`,
        retry: true,
        correlated,
      }
    },
    recordReclaim(episodeKey, providerModel, nowMs) {
      const atMs = nowMs ?? clock()
      episodeReclaims.set(episodeKey, (episodeReclaims.get(episodeKey) ?? 0) + 1)
      if (providerModel) {
        reclaimHistory.push({ key: providerModel, atMs })
        const cutoff = atMs - resolved.correlatedWindowMs
        while (reclaimHistory.length > 0 && reclaimHistory[0].atMs < cutoff) {
          reclaimHistory.shift()
        }
      }
    },
    reclaimCount(episodeKey) {
      return episodeReclaims.get(episodeKey) ?? 0
    },
    reset(episodeKey) {
      episodeReclaims.delete(episodeKey)
    },
  }
}
