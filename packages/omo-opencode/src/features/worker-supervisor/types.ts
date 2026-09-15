/**
 * Subagent Supervisor / Worker Watchdog — types. Delegation creates an
 * obligation to supervise: the root periodically checks each active child
 * using CHEAP deterministic signals (NOT semantic re-inspection of the whole
 * transcript) and intervenes on a bounded ladder.
 */

export type WorkerStatus =
  | "pending"
  | "starting"
  | "running"
  | "idle"
  | "blocked"
  | "stalled"
  | "completed"
  | "error"
  | "cancelled"

/**
 * Monotonic lifecycle stage of a child dispatch. Recorded as the child moves
 * through the real production path (authorization -> session -> provider
 * request -> first output -> terminal). The stage reached when progress stops
 * is exactly the "where" in the reported stall investigation.
 */
export type ChildStage =
  | "dispatch_authorized"
  | "session_created"
  | "request_started"
  | "first_response"
  | "completed"
  | "failed"
  | "cancelled"

/**
 * Differentiated zero-progress failure modes. Each maps to a distinct stage /
 * timeout so a supervisor reports the specific class of stall instead of an
 * undifferentiated "agent stalled".
 */
export type StallMode =
  | "DISPATCH_STALL"
  | "PROVIDER_START_STALL"
  | "PROVIDER_RESPONSE_STALL"
  | "EXECUTION_STALL"
  | "TOOL_STALL"
  | "QUIET_BUT_ACTIVE"

export type WorkerHealth =
  | "HEALTHY"
  | "STARTING"
  | "QUIET_STALL"
  | "LOOP"
  | "TOKEN_BURN"
  | "LONG_RUNNING"
  | "WEDGED"
  | "BUDGET_WARNING"
  | "EXHAUSTED"

export type InterventionAction = "OBSERVE" | "STATUS_REQUEST" | "NUDGE" | "RECLAIM" | "REPLACE"

export type Intervention = {
  action: InterventionAction
  message: string
  preservePartial: boolean
}

/**
 * One cheap observation snapshot of a child. The caller owns gathering these
 * from runtime state (timestamps, current tool, token delta, output tail) —
 * the pure core never reads transcripts or sessions.
 */
export type WorkerSignal = {
  workerID: string
  sessionID: string
  status: WorkerStatus
  nowMs: number
  /** Last time any activity (output/event) was observed. */
  lastActivityAtMs: number
  /** Last time MEANINGFUL progress (see progress.ts) was observed. */
  lastMeaningfulProgressAtMs: number
  /** Raw-token delta attributable to this worker since the previous check. */
  tokensDelta: number
  /** Tool calls since the previous check. */
  toolCallsDelta: number
  currentTool: string | null
  /** Distinct files changed/read since the previous check. */
  filesChangedDelta: number
  /** Cheap incremental output tail (new output only, cursor-managed). */
  outputTail: string
  /** Whether the current tool is a known long-running build/test command. */
  isLongRunningCommand: boolean
  /** Whether the current command shows CPU/IO activity. */
  commandActive: boolean
  /** Elapsed milliseconds of the current long-running command. */
  commandElapsedMs: number
  /** Child escrow token budget (0 when unknown/unbounded). */
  childTokenBudget: number
  /** Child escrow tokens consumed so far. */
  childTokensUsed: number
  isPaid: boolean
  /** Number of consecutive checks already classified as a stall/loop. */
  insecureChecks: number
}

export type SupervisionPolicy = {
  startupGraceMs: number
  quietStallThresholdMs: number
  loopChecks: number
  tokenBurnThreshold: number
  budgetWarnFraction: number
  wedgedThresholdMs: number
  /** Paid workers are supervised more strictly than free workers. */
  paidQuietStallThresholdMs: number
  paidMaxInsecureChecksBeforeReclaim: number
  freeMaxInsecureChecksBeforeReclaim: number
}

export const DEFAULT_SUPERVISION_POLICY: SupervisionPolicy = {
  startupGraceMs: 60_000,
  quietStallThresholdMs: 180_000,
  loopChecks: 3,
  tokenBurnThreshold: 200_000,
  budgetWarnFraction: 0.9,
  wedgedThresholdMs: 300_000,
  paidQuietStallThresholdMs: 120_000,
  paidMaxInsecureChecksBeforeReclaim: 2,
  freeMaxInsecureChecksBeforeReclaim: 4,
}
