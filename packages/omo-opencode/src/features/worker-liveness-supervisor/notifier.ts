/**
 * Phase 6: Notification batcher for the liveness supervisor.
 *
 * Rules:
 * - Ordinary events (heartbeat, progress, diagnostic) are batched and MUST NOT
 *   call onWake before the batch window closes.
 * - Terminal kinds (delegation_completed, wake_parent) flush immediately and
 *   call onWake exactly once per unique terminal kind + id.
 * - Repeated identical terminal events for the same kind + id dedupe across
 *   flushes to a single wake.
 * - wake_parent and delegation_completed are distinct dedup keys.
 * - Exposes pendingCount() and flush(nowMs?).
 */
import type { SupervisorEvent } from "./types"

export type NotificationEvent = SupervisorEvent

export type NotificationBatcherDeps = {
  now: () => number
  windowMs: number
  onWake: (event: NotificationEvent) => void
}

const TERMINAL_KINDS = new Set(["delegation_completed", "wake_parent"])

function isTerminal(kind: string): boolean {
  return TERMINAL_KINDS.has(kind)
}

export function createNotificationBatcher(deps: NotificationBatcherDeps) {
  const { now, windowMs, onWake } = deps

  // Buffer of events since the last wake
  let buffer: NotificationEvent[] = []
  let lastWakeMs = now()

  // Cross-flush terminal dedup: id -> set of terminal kinds already woken.
  const terminalDedup = new Map<string, Set<string>>()

  function flushNow(): void {
    if (buffer.length === 0) return

    const events = buffer
    buffer = []

    const terminalEvents: NotificationEvent[] = []
    const ordinaryEvents: NotificationEvent[] = []

    for (const ev of events) {
      if (isTerminal(ev.kind)) {
        terminalEvents.push(ev)
      } else {
        ordinaryEvents.push(ev)
      }
    }

    // Ordinary events batch into a single wake when the buffer flushes.
    if (ordinaryEvents.length > 0 && terminalEvents.length === 0) {
      onWake(ordinaryEvents[0])
      lastWakeMs = now()
    }

    // Terminal events: each unique kind+id wakes once, cross-flush dedup.
    for (const ev of terminalEvents) {
      const kinds = terminalDedup.get(ev.id) ?? new Set<string>()
      if (kinds.has(ev.kind)) {
        // Already woken for this kind+id; skip.
        continue
      }
      kinds.add(ev.kind)
      terminalDedup.set(ev.id, kinds)
      onWake(ev)
      lastWakeMs = now()
    }
  }

  function pendingCount(): number {
    return buffer.length
  }

  function checkWindow(): void {
    if (now() - lastWakeMs >= windowMs) {
      flushNow()
    }
  }

  return {
    record(event: NotificationEvent): void {
      if (isTerminal(event.kind)) {
        // Cross-flush dedup: skip repeated identical terminal events.
        const kinds = terminalDedup.get(event.id)
        if (kinds && kinds.has(event.kind)) {
          return
        }
        buffer.push(event)
        // Terminal events flush immediately.
        flushNow()
      } else {
        buffer.push(event)
        // Ordinary events flush only when the batch window has closed.
        if (now() - lastWakeMs >= windowMs) {
          flushNow()
        }
      }
    },

    flush: (): void => {
      flushNow()
    },

    pendingCount,

    checkWindow,
  }
}