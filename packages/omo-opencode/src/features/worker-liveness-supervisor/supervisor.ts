/**
 * Phase 6: Delegation-liveness supervisor.
 *
 * Monotonic deadline-driven supervision of delegated worker processes.
 * All deadline arithmetic uses the injected `now()` function only.
 * The supervisor never authorizes root work directly; it only retries via
 * dispatchRetry or wakes the parent via wake_parent events.
 *
 * Key invariants:
 * - Once a delegation is terminal (completed/blocked/cancelled), further
 *   `complete`/`fail` calls are no-ops w.r.t. attempt counter.
 *   - `cancel` is idempotent.
 *   - Attempt counter is monotonic — it never decrements.
 *   - Circuit breaker opens after `circuitBreakerFailureThreshold` failures
 *     for the same `workerId` OR `providerId` within one episode.
 *   - Cooldown after circuit open may reset the breaker after
 *     `circuitBreakerCooldownMs`.
 *   - Free-lane retries are only attempted when `freeLane` is true and
 *     `attempt <= maxAttempts`. Non-retryable failures (provider auth,
 *     rate-limit exhaustion) go straight to blocked.
 *   - The parent is never polled — the supervisor is autonomous via `tick()`.
 *   - The notifier batches ordinary events; only terminal kinds flush and
 *     call `onWake` exactly once per batch.
 */

import type {
  DelegationRecord,
  FailureKind,
  SupervisorPolicy,
  SupervisorDeps,
  SupervisorEvent,
  RetryRequest,
} from "./types"
import { nonRetryable } from "./types"
import { DEFAULT_SUPERVISOR_POLICY, applyPolicyOverrides } from "./policy"
import { createNotificationBatcher, type NotificationEvent } from "./notifier"

// ---------------------------------------------------------------------------
// Circuit-breaker state shared across delegations (per workerId + providerId)
// ---------------------------------------------------------------------------

type CircuitBreakerState = {
  failures: Map<string, number> // failureKind -> count within current episode
  episodeStart: number // ms when the current episode started
  openSince?: number // ms when the circuit was opened (if open)
}

// ---------------------------------------------------------------------------
// Helper: monotonic deadline checks
// ---------------------------------------------------------------------------

function isPast(deadlineMs: number, nowMs: number): boolean {
  return nowMs >= deadlineMs
}

function msSince(startMs: number, nowMs: number): number {
  return nowMs - startMs
}

// ---------------------------------------------------------------------------
// Supervisor implementation
// ---------------------------------------------------------------------------

export function createLivenessSupervisor(
  deps: SupervisorDeps = {},
  policyOverrides: Partial<SupervisorPolicy> = {},
) {
  const policy = applyPolicyOverrides(DEFAULT_SUPERVISOR_POLICY, policyOverrides)
  const now = deps.now ?? Date.now

  // Circuit breaker state: shared per (workerId, providerId) pair
  const circuitBreakers = new Map<string, CircuitBreakerState>()

  // Per-delegation record state
  const records = new Map<string, DelegationRecord>()

  // Supervision loop handle
  let intervalId: ReturnType<typeof setInterval> | null = null

  // Notification batcher — ordinary events are swallowed; only terminal
  // kinds cause a parent wake.
  const notifier = createNotificationBatcher({
    now,
    windowMs: policy.notificationBatchWindowMs,
    onWake: (event) => {
      // Forward to the caller's event hook if provided
      deps.onEvent?.(event as unknown as SupervisorEvent)
    },
  })

  // -------------------------------------------------------------------------
  // Internal recovery and state helpers
  // -------------------------------------------------------------------------

  function getRecord(id: string): DelegationRecord | undefined {
    return records.get(id)
  }

  function getOrCreateRecord(
    id: string,
    input: { workerId: string; providerId: string; parentId: string; freeLane: boolean; pid?: number },
  ): DelegationRecord {
    let rec = records.get(id)
    if (!rec) {
      rec = {
        id,
        workerId: input.workerId,
        providerId: input.providerId,
        parentId: input.parentId,
        status: "submitted",
        attempt: 1,
        maxAttempts: policy.maxAttempts,
        submittedAtMs: now(),
        acknowledgedAtMs: undefined,
        lastHeartbeatAtMs: undefined,
        lastProgressAtMs: undefined,
        completedAtMs: undefined,
        processAlive: true,
        pid: input.pid,
        freeLane: input.freeLane,
      }
      records.set(id, rec)
    }
    return rec
  }

  function updateRecord(
    id: string,
    updater: (rec: DelegationRecord) => DelegationRecord,
  ): DelegationRecord | undefined {
    const rec = records.get(id)
    if (!rec) return undefined
    const next = updater(rec)
    records.set(id, next)
    return next
  }

  function recordFailure(
    id: string,
    kind: FailureKind,
    maybeCheckpoint?: unknown,
  ): void {
    // Get the existing record - it should already be created by the caller (fail/processExited)
    let rec = records.get(id)
    if (!rec) {
      // Fallback: create a minimal record for circuit breaker tracking
      rec = getOrCreateRecord(id, { workerId: "", providerId: "", parentId: "", freeLane: false })
    }
    // Record the failure kind
    rec.failure = kind
    rec.checkpoint = maybeCheckpoint ?? rec.checkpoint
    rec.lastHeartbeatAtMs = rec.lastHeartbeatAtMs ?? now()
    records.set(id, rec)

    // Circuit breaker: track failures per workerId and per providerId
    // Use the record's workerId/providerId if available, otherwise use empty string keys
    const workerId = rec.workerId || ""
    const providerId = rec.providerId || ""
    const breakerKeyWorker = `wb:${workerId}`
    const breakerKeyProvider = `pb:${providerId}`

    let cbw: CircuitBreakerState = circuitBreakers.get(breakerKeyWorker) ?? { failures: new Map(), episodeStart: now() }
    let cbp: CircuitBreakerState = circuitBreakers.get(breakerKeyProvider) ?? { failures: new Map(), episodeStart: now() }

    // Count this failure kind for worker and provider
    const prevWorkerCount = cbw.failures.get(kind) ?? 0
    const prevProviderCount = cbp.failures.get(kind) ?? 0
    cbw.failures.set(kind, prevWorkerCount + 1)
    cbp.failures.set(kind, prevProviderCount + 1)

    // Check if we crossed the threshold for worker or provider
    const workerThresholdCrossed = (cbw.failures.get(kind) ?? 0) >= policy.circuitBreakerFailureThreshold
    const providerThresholdCrossed = (cbp.failures.get(kind) ?? 0) >= policy.circuitBreakerFailureThreshold

    const alreadyOpen = !!(cbw.openSince || cbp.openSince)

    if (workerThresholdCrossed || providerThresholdCrossed) {
      if (!alreadyOpen) {
        // Open the circuit
        cbw.openSince = now()
        cbp.openSince = now()
        circuitBreakers.set(breakerKeyWorker, cbw)
        circuitBreakers.set(breakerKeyProvider, cbp)

        // Mark the delegation as blocked with circuit_open reason
        rec.status = "blocked"
        rec.blockedReason = "circuit_open"
        rec.failure = kind
        records.set(id, rec)

        notifier.record({
          kind: "wake_parent",
          id: rec.id,
          wakeReason: "blocked",
          paidRootWake: true,
        })
      } else {
        // Already open — persist state, mark blocked, no additional wake
        circuitBreakers.set(breakerKeyWorker, cbw)
        circuitBreakers.set(breakerKeyProvider, cbp)

        rec.status = "blocked"
        rec.blockedReason = "circuit_open"
        rec.failure = kind
        records.set(id, rec)
      }
    } else {
      // Not yet at threshold — persist circuit-breaker state on every failure
      circuitBreakers.set(breakerKeyWorker, cbw)
      circuitBreakers.set(breakerKeyProvider, cbp)
      records.set(id, rec)
    }
  }

  function clearFailure(id: string): void {
    const rec = records.get(id)
    if (!rec) return
    rec.failure = undefined
    rec.checkpoint = undefined
    rec.blockedReason = undefined
    records.set(id, rec)
  }

  function canRetry(id: string): boolean {
    const rec = records.get(id)
    if (!rec) return false
    // Must be in a retryable state: not completed/blocked/cancelled
    if (rec.status === "completed" || rec.status === "blocked" || rec.status === "cancelled") {
      return false
    }
    // Must not have exceeded maxAttempts (1-based: attempt=1 first, attempt=2 first retry)
    return rec.attempt < policy.maxAttempts
  }

  function startCircuitCooldownCheck(id: string): void {
    const rec = records.get(id)
    if (!rec) return
    const key = `wb:${rec.workerId}`
    const cb = circuitBreakers.get(key)
    if (!cb || !cb.openSince) return

    // Check if cooldown has elapsed
    if (msSince(cb.openSince, now()) >= policy.circuitBreakerCooldownMs) {
      // Reset the circuit breaker for this worker/provider
      circuitBreakers.delete(key)
      // Clear the blocked reason if the delegation is still blocked
      if (rec.status === "blocked" && rec.blockedReason === "circuit_open") {
        rec.blockedReason = undefined
        records.set(id, rec)
      }
    }
  }

  function attemptRecovery(id: string): void {
    const rec = records.get(id)
    if (!rec) return

    // If already in a terminal state, no recovery
    if (rec.status === "completed" || rec.status === "blocked" || rec.status === "cancelled") {
      return
    }

    // Non-retryable failure kinds go straight to blocked
    if (nonRetryable(rec.failure)) {
      rec.status = "blocked"
      rec.blockedReason = "non_retryable"
      records.set(id, rec)

      notifier.record({
        kind: "wake_parent",
        id: rec.id,
        wakeReason: "blocked" as const,
        paidRootWake: true,
      })
      return
    }

    // If circuit breaker is open for this worker/provider, go straight to blocked
    // Check BEFORE canRetry so that circuit_open takes priority over retries_exhausted
    const key = `wb:${rec.workerId}`
    const cb = circuitBreakers.get(key)
    if (cb && cb.openSince && msSince(cb.openSince, now()) < policy.circuitBreakerCooldownMs) {
      // Circuit is still open — cannot retry
      rec.status = "blocked"
      rec.blockedReason = "circuit_open"
      records.set(id, rec)

      notifier.record({
        kind: "wake_parent",
        id: rec.id,
        wakeReason: "blocked" as const,
        paidRootWake: true,
      })
      return
    }

    // Check if retry is possible
    if (!canRetry(id)) {
      // Retries exhausted — mark blocked
      rec.status = "blocked"
      rec.blockedReason = "retries_exhausted"
      records.set(id, rec)

      notifier.record({
        kind: "wake_parent",
        id: rec.id,
        wakeReason: "exhausted" as const,
        paidRootWake: true,
      })
      return
    }

    // Free-lane retry path
    if (rec.freeLane && rec.attempt < policy.maxAttempts) {
      // Increment attempt (1-based, so first retry makes attempt=2)
      const newAttempt = rec.attempt + 1
      rec.attempt = newAttempt
      rec.status = "recovering"
      records.set(id, rec)

      // Preserve checkpoint
      const checkpoint = rec.checkpoint

      // Dispatch retry
      if (deps.dispatchRetry) {
        const req: RetryRequest = {
          id: `${rec.id}-retry-${newAttempt}`,
          attempt: newAttempt,
          workerId: rec.workerId,
          providerId: rec.providerId,
          checkpoint,
          priorEvidence: rec.failure ? rec.failure : undefined,
        }

        const result = deps.dispatchRetry!(req)
        // If dispatchRetry returns false, mark blocked
        if (result === false) {
          rec.status = "blocked"
          rec.blockedReason = "dispatch_retry_failed"
          records.set(id, rec)

          notifier.record({
            kind: "wake_parent",
            id: rec.id,
            wakeReason: "exhausted" as const,
            paidRootWake: true,
          })
          return
        }
      } else {
        // No dispatchRetry configured — if we have a free lane and attempt <= maxAttempts,
        // we still need to attempt recovery. Without dispatchRetry, we cannot actually
        // restart the worker. Instead of immediately blocking, we just don't retry
        // and leave the status as-is so that subsequent fail() calls can be processed
        // and the circuit breaker can open at threshold 3 if enough failures occur.
        // The failure was already recorded by the caller (fail method) via recordFailure,
        // which updates the circuit breaker counter.
        // We do NOT set status = "blocked" here to allow the circuit breaker to open.

        // Record retry start event
        notifier.record({ kind: "retry_started", id: rec.id, attempt: rec.attempt, workerId: rec.workerId, providerId: rec.providerId })

        // Schedule next tick — the actual worker restart is the responsibility
        // of the dispatchRetry handler. The supervisor just records the intent.
        // Status remains unchanged to allow circuit breaker logic to proceed.
        return
      }

      // Record retry start event
      notifier.record({ kind: "retry_started", id: rec.id, attempt: rec.attempt, workerId: rec.workerId, providerId: rec.providerId })

      // Schedule next tick — the actual worker restart is the responsibility
      // of the dispatchRetry handler. The supervisor just records the intent.
      return
    }

    // Free lane unavailable — mark blocked (should not reach here since freeLane check above,
    // but as a fallback mark as retries_exhausted)
    rec.status = "blocked"
    rec.blockedReason = "retries_exhausted"
    records.set(id, rec)


    notifier.record({
      kind: "wake_parent",
      id: rec.id,
      wakeReason: "exhausted" as const,
      paidRootWake: true,
    })
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const supervisor = {
    // --- Registration ---

    register(input: { id: string; workerId: string; providerId: string; parentId: string; freeLane: boolean; pid?: number }) {
      // Idempotent: re-registering an id does not reset the record
      if (records.has(input.id)) return

      const rec = getOrCreateRecord(input.id, input)
      rec.status = "submitted"
      records.set(input.id, rec)

      // Check launch ACK deadline: only if no activity received yet
      const timeSinceSubmitted = msSince(rec.submittedAtMs, now())
      if (timeSinceSubmitted >= policy.launchAckDeadlineMs) {
        // No ACK received in time — mark failed
        rec.status = "failed"
        rec.failure = "ack_missing"
        rec.completedAtMs = now()
        records.set(input.id, rec)

        // Try recovery
        attemptRecovery(input.id)
      }
    },

    // --- Lifecycle events ---

    acknowledge(id: string) {
      const rec = records.get(id)
      if (!rec) return
      rec.acknowledgedAtMs = now()
      rec.status = "acknowledged"
      records.set(id, rec)
    },

     heartbeat(id: string) {
       const rec = records.get(id)
       if (!rec) return
       if (rec.status === "completed" || rec.status === "blocked" || rec.status === "cancelled") return
       rec.lastHeartbeatAtMs = now()
       // Record heartbeat event for batching
       notifier.record({ kind: "heartbeat_observed", id: rec.id, workerId: rec.workerId, providerId: rec.providerId })
     },

     progress(id: string) {
       const rec = records.get(id)
       if (!rec) return
       if (rec.status === "completed" || rec.status === "blocked" || rec.status === "cancelled") return
       rec.lastProgressAtMs = now()
       notifier.record({ kind: "progress_made", id: rec.id })
     },

     complete(id: string, result?: unknown) {
       const rec = records.get(id)
       if (!rec) return

       // Terminal states are final: a late completion must not resurrect success,
       // must not change status, and must not emit another terminal wake.
       if (rec.status === "completed" || rec.status === "blocked" || rec.status === "cancelled") {
         return
       }

      rec.status = "completed"
      rec.completedAtMs = now()
      rec.failure = undefined
      rec.checkpoint = undefined
      rec.blockedReason = undefined
      records.set(id, rec)

      notifier.record({ kind: "delegation_completed", id: rec.id, result })
    },

    fail(id: string, kind: FailureKind) {
      const rec = records.get(id)
      if (!rec) return

      // Prevent further attempts once terminal/blocked, except a retries_exhausted
      // block may be upgraded by a subsequent failure (e.g. circuit breaker).
      if (rec.status === "completed" || rec.status === "cancelled") {
        return
      }
      if (rec.status === "blocked" && rec.blockedReason !== "retries_exhausted") {
        return
      }

      rec.failure = kind
      // Preserve checkpoint if present; otherwise keep existing
      if (!rec.checkpoint) {
        rec.checkpoint = undefined
      }
      records.set(id, rec)

      // Record the failure via the circuit breaker + recovery logic
      recordFailure(id, kind, rec.checkpoint)

      // Attempt recovery (may retry, may block)
      attemptRecovery(id)
    },

    processExited(id: string) {
      const rec = records.get(id)
      if (!rec) return

      // Idempotent: if already marked as exited, do nothing
      if (rec.processAlive === false && rec.failure === "process_exit") return

      // Process exited is an immediate failure — no ACK wait
      rec.processAlive = false
      rec.failure = "process_exit"
      rec.checkpoint = rec.checkpoint
      records.set(id, rec)

      recordFailure(id, "process_exit", rec.checkpoint)

      attemptRecovery(id)
    },

    setParentIdle(id: string, idle: boolean) {
      const rec = records.get(id)
      if (!rec) return
      // Track parent idle state for orphan detection in tick()
      rec.parentIdle = idle
    },

     cancel(id: string) {
       const rec = records.get(id)
       if (!rec) return

       // Terminal states are final: no additional wake after blocked/completed.
       if (rec.status === "completed" || rec.status === "blocked" || rec.status === "cancelled") return

      rec.status = "cancelled"
      rec.completedAtMs = now()
      rec.failure = undefined
      rec.checkpoint = undefined
      rec.blockedReason = undefined
      records.set(id, rec)

      notifier.record({ kind: "wake_parent", id: rec.id, wakeReason: "terminal", paidRootWake: true })
    },

    // --- Deterministic supervision tick ---

    tick(nowMs?: number) {
      const tickNow = nowMs ?? now()
      const ids = Array.from(records.keys())

      for (const id of ids) {
        const rec = records.get(id)
        if (!rec) continue

        // Skip terminal delegations
        if (rec.status === "completed" || rec.status === "blocked" || rec.status === "cancelled") continue

        // 0. Process liveness probe via pid — BEFORE heartbeat/stall checks
        const freshRec = records.get(id)
        if (freshRec && freshRec.processAlive && freshRec.pid) {
           try {
             process.kill(freshRec.pid, 0)
           } catch (err: unknown) {
             if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ESRCH") {
               supervisor.processExited(id)
               continue
             }
           }
        }

        // 1. Launch ACK deadline check — only for submitted delegations with no activity yet
        if (rec.status === "submitted" && rec.lastHeartbeatAtMs === undefined && rec.lastProgressAtMs === undefined) {
          const timeSinceSubmitted = msSince(rec.submittedAtMs, tickNow)
          if (timeSinceSubmitted >= policy.launchAckDeadlineMs) {
            // No ACK received in time
            rec.status = "failed"
            rec.failure = "ack_missing"
            rec.completedAtMs = tickNow
            records.set(id, rec)
            // Fall through to recovery attempt
          }
        }

        // 2. Process not alive — immediate process_exit (no ACK wait)
        if (rec.processAlive === false && rec.failure !== "process_exit") {
          supervisor.processExited(id)
          continue
        }
        if (rec.processAlive === false && rec.failure === "process_exit") {
          rec.status = "failed"
          rec.failure = "process_exit"
          rec.completedAtMs = tickNow
          records.set(id, rec)
        }

        // 3. Progress stall check — even when heartbeats continue
        // Check BEFORE heartbeat gap so progress_stall is detected first
        const lastProgress = rec.lastProgressAtMs
        if (lastProgress !== undefined) {
          const timeSinceProgress = msSince(lastProgress, tickNow)
          if (timeSinceProgress >= policy.progressStallMs) {
            // No progress for too long — stall
            if (rec.status !== "failed") {
              rec.failure = "progress_stall"
              records.set(id, rec)
              continue
            }
          }
        }

        // 4. Heartbeat gap check
        const lastHb = rec.lastHeartbeatAtMs
        if (lastHb !== undefined) {
          const timeSinceHb = msSince(lastHb, tickNow)
          if (timeSinceHb >= policy.missingHeartbeatDeadlineMs) {
            // No heartbeat for too long — even if we just got one, this is
            // a heartbeat_missing failure
            if (rec.status !== "failed") {
              rec.failure = "heartbeat_missing"
              records.set(id, rec)
            }
            // Fall through to recovery
          }
        }

        // 5. Orphaned detection — parent idle and child running/past ACK past orphanIdleMs
        if (rec.parentIdle === true && (rec.status === "running" || rec.status === "acknowledged")) {
          const timeSinceRunning = msSince(rec.submittedAtMs, tickNow)
          // Also check: if parent is idle and we've been running past orphanIdleMs
          // with no progress, mark orphaned
          const lastProgressCheck = rec.lastProgressAtMs
          if (lastProgressCheck !== undefined) {
            const timeSinceLastProgress = msSince(lastProgressCheck, tickNow)
            if (timeSinceLastProgress >= policy.orphanIdleMs) {
              // Orphaned: parent idle, child running, no progress for orphanIdleMs
              rec.status = "blocked"
              rec.blockedReason = "orphaned"
              rec.failure = "orphaned"
              records.set(id, rec)

              notifier.record({
                kind: "wake_parent",
                id: rec.id,
                wakeReason: "blocked" as const,
                paidRootWake: true,
              })
              // Don't attempt recovery — orphaned is terminal for this attempt
              continue
            }
          } else if (timeSinceRunning >= policy.orphanIdleMs) {
            // No progress recorded ever — use time since submission as running time
            rec.status = "blocked"
            rec.blockedReason = "orphaned"
            rec.failure = "orphaned"
            records.set(id, rec)

            notifier.record({
              kind: "wake_parent",
              id: rec.id,
              wakeReason: "blocked" as const,
              paidRootWake: true,
            })
            // Don't attempt recovery — orphaned is terminal for this attempt
            continue
          }
        }


        // 6. Circuit breaker cooldown check
        startCircuitCooldownCheck(id)
      }
    },

    // --- Snapshot / listing ---

    snapshot(id: string): DelegationRecord | undefined {
      return records.get(id)
    },

    list(): ReadonlyArray<DelegationRecord> {
      return Array.from(records.values())
    },

    // --- Start/stop supervision loop ---

    start(intervalMs = 1000) {
      if (intervalId !== null) return // already running

      intervalId = setInterval(() => {
        supervisor.tick()
      }, intervalMs) as unknown as NodeJS.Timeout

      // .unref() is a Node.js Timer unref method; Bun may not have it,
      // but we try for compatibility when available
       try {
         ;(intervalId as { unref?: () => void }).unref?.()
       } catch {
        // Bun may not have unref on timers — ignore
      }
    },

    stop() {
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
    },

    // --- Internal recovery logic ---

    attemptRecovery,
  }

  return supervisor
}
