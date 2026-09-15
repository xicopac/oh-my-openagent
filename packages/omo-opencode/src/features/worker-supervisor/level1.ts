/**
 * Watchdog Level 1 — metadata-only health classification. Pure deterministic
 * TypeScript: it reads ONLY a monotonic progress counter plus timestamps. It
 * never reads worker output, transcript, token deltas, tool-call deltas, or
 * file contents, and it makes zero model/SDK/provider calls.
 */

import type { WorkerStatus } from "./types"

export type WatchdogMetadata = {
  workerID: string
  sessionID: string
  status: WorkerStatus
  /** Monotonic activity counter (per-child-session activity-event count). */
  progressCounter: number
  previousProgressCounter: number
  /** Last time the counter advanced. */
  lastChangeAtMs: number
  /** Last time any event/activity was seen. */
  lastActivityAtMs: number
  nowMs: number
  /** A build/test/process is known to be running. */
  hasActiveLongProcess: boolean
  longProcessElapsedMs: number
}

export type Level1Health = "HEALTHY" | "QUIET_BUT_ACTIVE" | "SUSPECTED_STALL" | "STARTING" | "TERMINAL"

export type WatchdogPolicy = {
  startupGraceMs: number
  quietStallThresholdMs: number
  wedgedThresholdMs: number
}

export const DEFAULT_WATCHDOG_POLICY: WatchdogPolicy = {
  startupGraceMs: 60_000,
  quietStallThresholdMs: 180_000,
  wedgedThresholdMs: 300_000,
}

export type Level1Result = {
  health: Level1Health
  reason: string
  advanced: boolean
}

export function classifyLevel1(meta: WatchdogMetadata, policy: WatchdogPolicy): Level1Result {
  if (meta.status === "starting" || meta.status === "pending") {
    return { health: "STARTING", reason: "within startup grace", advanced: false }
  }
  if (meta.status === "completed" || meta.status === "error" || meta.status === "cancelled") {
    return { health: "TERMINAL", reason: "terminal state", advanced: false }
  }
  if (meta.progressCounter > meta.previousProgressCounter) {
    return { health: "HEALTHY", reason: "advanced", advanced: true }
  }
  if (meta.hasActiveLongProcess && meta.longProcessElapsedMs < policy.wedgedThresholdMs) {
    return { health: "QUIET_BUT_ACTIVE", reason: "long process advancing", advanced: false }
  }
  if (meta.nowMs - meta.lastActivityAtMs >= policy.quietStallThresholdMs) {
    return { health: "SUSPECTED_STALL", reason: "quiet past stall threshold", advanced: false }
  }
  return { health: "HEALTHY", reason: "observing, within threshold", advanced: false }
}

/** Whether a Level-1 health warrants escalation to a higher ladder layer. */
export function isInsecureLevel1(health: Level1Health): boolean {
  return health === "SUSPECTED_STALL"
}
