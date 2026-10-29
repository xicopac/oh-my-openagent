/**
 * Phase 6: Delegation-liveness supervisor types.
 *
 * Monotonic deadline-driven supervision of delegated worker processes.
 * No semantic re-inspection — all signals are cheap timestamps and booleans.
 */

export type DelegationStatus =
  | "submitted"
  | "acknowledged"
  | "running"
  | "recovering"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

/**
 * Distinct failure kinds that the supervisor can record and react to.
 * Each maps to a specific symptom so the supervisor can apply the correct
 * recovery policy (retry vs block vs wake parent).
 */
export type FailureKind =
  | "ack_missing"
  | "process_exit"
  | "provider_error"
  | "rate_limit"
  | "heartbeat_missing"
  | "progress_stall"
  | "handshake_hang"
  | "completion_hang"
  | "orphaned";

/**
 * A delegation record tracks the lifecycle of a single delegated unit of work.
 * All timestamps are monotonic ms since epoch. The supervisor never reads
 * transcripts or sessions — only the fields below.
 */
export type DelegationRecord = {
  /** Unique delegation identifier. */
  id: string;
  /** Identifier of the worker performing the delegated work. */
  workerId: string;
  /** Identifier of the provider supplying the capability. */
  providerId: string;
  /** Identifier of the parent that requested the delegation. */
  parentId: string;
  /** Current status of the delegation. */
  status: DelegationStatus;
  /** 1-based attempt number. Increments on retry. */
  attempt: number;
  /** Maximum number of attempts before giving up. */
  maxAttempts: number;
  /** When the delegation was first submitted. */
  submittedAtMs: number;
  /** When the ACK was received, if any. */
  acknowledgedAtMs?: number;
  /** When the last heartbeat was observed. */
  lastHeartbeatAtMs?: number;
  /** When last meaningful progress was observed. */
  lastProgressAtMs?: number;
  /** When the delegation completed, if done. */
  completedAtMs?: number;
  /** Whether the underlying process is still alive. */
  processAlive: boolean;
  /** Optional OS pid of the delegated worker process, used for liveness probing. */
  pid?: number;
  /** Last checkpoint data, preserved across retries. */
  checkpoint?: unknown;
  /** Recorded failure reason, if any. */
  failure?: FailureKind;
  /** Reason the delegation entered the "blocked" terminal state. */
  blockedReason?: string;
  /** Whether this delegation owns a free lane. */
  freeLane: boolean;
  /** Whether the parent is currently idle (for orphan detection). */
  parentIdle?: boolean;
};

/**
 * Policy configuration for the liveness supervisor.
 * All deadlines are monotonic ms arithmetic using the injected `now()` function.
 * maxAttempts counts total attempts (1-based): attempt=1 is the first try,
 * attempt=2 is the first retry. The default of 2 means one retry is allowed
 * before blocking.
 */
export type SupervisorPolicy = {
  /** Deadline (ms) by which the parent must ACK the delegation after submit. */
  launchAckDeadlineMs: number;
  /** Interval (ms) at which heartbeats are expected. */
  heartbeatIntervalMs: number;
  /** Deadline (ms) after which a missing heartbeat is fatal. */
  missingHeartbeatDeadlineMs: number;
  /** Deadline (ms) after which no progress is considered stalled. */
  progressStallMs: number;
  /** Grace period (ms) after completion before state cleanup. */
  completionGraceMs: number;
  /** Idle timeout (ms) for a running delegation whose parent is idle. */
  orphanIdleMs: number;
  /** Maximum number of attempts (1-based). Default 2 = one retry. */
  maxAttempts: number;
  /** Circuit breaker failure threshold within one episode. */
  circuitBreakerFailureThreshold: number;
  /** Cooldown (ms) after which the circuit breaker resets. */
  circuitBreakerCooldownMs: number;
  /** Batching window (ms) for notification deduplication. */
  notificationBatchWindowMs: number;
};

/**
 * Determines whether a failure kind is non-retryable (e.g. auth errors that
 * must not be retried). Provider errors are treated as non-retryable.
 */
export function nonRetryable(kind: FailureKind | undefined | null): boolean {
  return kind === "provider_error"
}

export type RetryRequest = {
  id: string
  attempt: number
  workerId: string
  providerId: string
  checkpoint?: unknown
  priorEvidence?: FailureKind
}

export type SupervisorEvent =
  | { id: string; kind: "heartbeat_observed"; workerId?: string; providerId?: string }
  | { id: string; kind: "progress_made" }
  | { id: string; kind: "diagnostic"; text: string }
  | { id: string; kind: "delegation_completed"; result?: unknown }
  | { id: string; kind: "wake_parent"; wakeReason: "terminal" | "replan" | "exhausted" | "blocked"; paidRootWake: boolean }
  | { id: string; kind: "retry_started"; attempt?: number; workerId?: string; providerId?: string }

export type SupervisorDeps = {
  now?: () => number
  freeWorkerLane?: unknown
  dispatchRetry?: (req: RetryRequest) => boolean | void | Promise<boolean | void>
  cancel?: () => void
  onEvent?: (event: SupervisorEvent) => void
  onStallDetected?: (id: string, kind: FailureKind) => void
}