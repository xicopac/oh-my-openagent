/**
 * Stage-aware stall timeout policy. Each failure mode has its own bound so a
 * provider request with no response is flagged quickly, an ordinary
 * explore/search worker with no activity is reclaimed on a short bound, and a
 * build/test/process is allowed to run much longer. One naive timeout for
 * everything is exactly what this replaces.
 */
export type StallTimeoutPolicy = {
  /** Authorized but child session never created. */
  dispatchTimeoutMs: number
  /** Session created but provider request never began. */
  requestStartTimeoutMs: number
  /** Provider request sent but no first response arrived. */
  providerResponseTimeoutMs: number
  /** Provider responded but no meaningful tool/process progress since. */
  executionStallThresholdMs: number
  /** Active long-running tool/process past this is considered wedged. */
  toolStallWedgedMs: number
}

export const DEFAULT_STALL_TIMEOUTS: StallTimeoutPolicy = {
  dispatchTimeoutMs: 30_000,
  requestStartTimeoutMs: 30_000,
  providerResponseTimeoutMs: 180_000,
  executionStallThresholdMs: 180_000,
  toolStallWedgedMs: 300_000,
}
