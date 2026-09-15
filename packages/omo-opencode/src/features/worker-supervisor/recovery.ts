import type { StallMode } from "./types"

/**
 * Recovery policy + correlated-stall tracker. Decides, from a timed-out stall,
 * whether to reclaim the child and whether a retry is worthwhile, and detects
 * correlated parallel stalls (several children failing at the same provider /
 * model within a short window) so the supervisor does not blindly relaunch
 * identical workers into the same failure mode.
 */
export type RecoveryPolicy = {
  /** Reclaims allowed against one worker before the supervisor gives up. */
  sameWorkerMaxReclaims: number
  /** Window in which several same-provider/model reclamations count as correlated. */
  correlatedWindowMs: number
  /** Number of same-provider/model reclamations that mark a correlation. */
  correlatedMinCount: number
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  sameWorkerMaxReclaims: 1,
  correlatedWindowMs: 120_000,
  correlatedMinCount: 2,
}

export type RecoveryDecision =
  | { kind: "observe"; reason: string }
  | { kind: "reclaim"; reason: string; retry: boolean; correlated: boolean }

export type RecoveryCoordinator = {
  evaluate(
    sessionID: string,
    providerModel: string | null,
    mode: StallMode,
    timedOut: boolean,
    nowMs?: number,
  ): RecoveryDecision
  recordReclaim(sessionID: string, providerModel: string | null, nowMs?: number): void
  reclaimCount(sessionID: string): number
  reset(sessionID: string): void
}

export function createRecoveryCoordinator(
  policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
  now?: () => number,
): RecoveryCoordinator {
  const resolved: RecoveryPolicy = { ...DEFAULT_RECOVERY_POLICY, ...policy }
  const clock = now ?? (() => Date.now())
  const sessionReclaims = new Map<string, number>()
  const reclaimHistory: Array<{ key: string; atMs: number }> = []

  function correlatedFor(providerModel: string | null, atMs: number): boolean {
    if (!providerModel) return false
    const matches = reclaimHistory.filter(
      (r) => r.key === providerModel && atMs - r.atMs <= resolved.correlatedWindowMs,
    )
    return matches.length + 1 >= resolved.correlatedMinCount
  }

  return {
    evaluate(sessionID, providerModel, mode, timedOut, nowMs) {
      const atMs = nowMs ?? clock()
      if (!timedOut || mode === "QUIET_BUT_ACTIVE") {
        return { kind: "observe", reason: "not a timed-out stall" }
      }
      const correlated = correlatedFor(providerModel, atMs)
      const reclaims = sessionReclaims.get(sessionID) ?? 0
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
    recordReclaim(sessionID, providerModel, nowMs) {
      const atMs = nowMs ?? clock()
      sessionReclaims.set(sessionID, (sessionReclaims.get(sessionID) ?? 0) + 1)
      if (providerModel) {
        reclaimHistory.push({ key: providerModel, atMs })
        const cutoff = atMs - resolved.correlatedWindowMs
        while (reclaimHistory.length > 0 && reclaimHistory[0].atMs < cutoff) {
          reclaimHistory.shift()
        }
      }
    },
    reclaimCount(sessionID) {
      return sessionReclaims.get(sessionID) ?? 0
    },
    reset(sessionID) {
      sessionReclaims.delete(sessionID)
    },
  }
}
