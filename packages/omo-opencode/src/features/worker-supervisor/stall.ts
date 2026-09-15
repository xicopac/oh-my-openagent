import type { WatchdogMetadata } from "./level1"
import type { StallMode } from "./types"
import type { StallTimeoutPolicy } from "./timeouts"

export type StallClassification = {
  mode: StallMode
  reason: string
  /** True when the stage's own deadline has expired (a genuine stall). */
  timedOut: boolean
}

/**
 * Differentiate a zero-progress child into a specific stall mode using only
 * the metadata-only snapshot (stage, timestamps, progress counter, long-process
 * flag) plus the stage-aware timeout policy. Never reads output or transcripts.
 */
export function classifyStallMode(meta: WatchdogMetadata, timeouts: StallTimeoutPolicy): StallClassification {
  const { stage, nowMs } = meta

  if (meta.hasActiveLongProcess && meta.longProcessElapsedMs >= timeouts.toolStallWedgedMs) {
    return { mode: "TOOL_STALL", reason: "tool/process wedged past threshold", timedOut: true }
  }
  if (meta.hasActiveLongProcess) {
    return { mode: "QUIET_BUT_ACTIVE", reason: "long-running process still within threshold", timedOut: false }
  }

  const elapsedSinceStage = nowMs - meta.stageAtMs

  if (stage === "dispatch_authorized" && elapsedSinceStage >= timeouts.dispatchTimeoutMs) {
    return { mode: "DISPATCH_STALL", reason: "authorized but child session never created", timedOut: true }
  }

  if (stage === "session_created" && elapsedSinceStage >= timeouts.requestStartTimeoutMs) {
    return { mode: "PROVIDER_START_STALL", reason: "session exists but provider request never began", timedOut: true }
  }

  if (stage === "request_started") {
    if (elapsedSinceStage >= timeouts.providerResponseTimeoutMs) {
      return { mode: "PROVIDER_RESPONSE_STALL", reason: "request sent but no provider response", timedOut: true }
    }
    return { mode: "PROVIDER_RESPONSE_STALL", reason: "awaiting first provider response", timedOut: false }
  }

  const quietSince = nowMs - meta.lastActivityAtMs
  if (meta.progressCounter > 0 && quietSince >= timeouts.executionStallThresholdMs) {
    return { mode: "EXECUTION_STALL", reason: "provider responded but no runtime progress since", timedOut: true }
  }

  return { mode: "QUIET_BUT_ACTIVE", reason: "observing, within thresholds", timedOut: false }
}
