/**
 * Watchdog Level 1 — stateful metadata-only facade. The integration owner feeds
 * the monotonic per-child-session activity-event count via `onActivity`; this
 * layer classifies health from counters + timestamps alone and emits a
 * COALESCED metadata-only event stream on health transitions. Pure: no model,
 * no SDK, no process, no fs. Only `now` and `onEvent` are injectable.
 */

import {
  classifyLevel1,
  DEFAULT_WATCHDOG_POLICY,
  isInsecureLevel1,
  type Level1Health,
  type Level1Result,
  type WatchdogMetadata,
  type WatchdogPolicy,
} from "./level1"
import type { WorkerStatus } from "./types"

export type WatchdogEventName =
  | "watchdog_progress"
  | "watchdog_quiet_active"
  | "watchdog_stall_suspected"
  | "watchdog_recovered"
  | "watchdog_nudged"
  | "watchdog_reclaimed"

export type Watchdog = {
  register(sessionID: string, workerID: string): void
  unregister(sessionID: string): void
  sessions(): string[]
  onActivity(sessionID: string): void
  onProcessStart(sessionID: string): void
  onProcessEnd(sessionID: string): void
  onTerminal(sessionID: string): void
  check(sessionID: string, nowMs?: number): Level1Result
  checkAll(nowMs?: number): Array<{ sessionID: string; result: Level1Result }>
  snapshot(sessionID: string): WatchdogMetadata | undefined
  dispose(): void
}

export type WatchdogOptions = {
  onEvent?: (sessionID: string, event: WatchdogEventName, detail?: Record<string, unknown>) => void
  now?: () => number
}

type SessionState = {
  workerID: string
  status: WorkerStatus
  progressCounter: number
  previousProgressCounter: number
  lastChangeAtMs: number
  lastActivityAtMs: number
  hasActiveLongProcess: boolean
  longProcessStartedAtMs: number
  lastHealth: Level1Health | null
}

export function createWatchdog(policy: Partial<WatchdogPolicy> = {}, opts: WatchdogOptions = {}): Watchdog {
  const resolved: WatchdogPolicy = { ...DEFAULT_WATCHDOG_POLICY, ...policy }
  const clock = opts.now ?? (() => Date.now())
  const onEvent = opts.onEvent
  const states = new Map<string, SessionState>()

  function stateFor(sessionID: string): SessionState | undefined {
    return states.get(sessionID)
  }

  return {
    register(sessionID, workerID) {
      const now = clock()
      states.set(sessionID, {
        workerID,
        status: "starting",
        progressCounter: 0,
        previousProgressCounter: 0,
        lastChangeAtMs: now,
        lastActivityAtMs: now,
        hasActiveLongProcess: false,
        longProcessStartedAtMs: 0,
        lastHealth: null,
      })
    },
    unregister(sessionID) {
      states.delete(sessionID)
    },
    sessions() {
      return [...states.keys()]
    },
    onActivity(sessionID) {
      const state = stateFor(sessionID)
      if (!state) return
      const now = clock()
      state.progressCounter += 1
      state.lastChangeAtMs = now
      state.lastActivityAtMs = now
      // First activity moves the worker out of startup into running.
      if (state.status === "starting" || state.status === "pending") {
        state.status = "running"
      }
    },
    onProcessStart(sessionID) {
      const state = stateFor(sessionID)
      if (!state) return
      state.hasActiveLongProcess = true
      state.longProcessStartedAtMs = clock()
    },
    onProcessEnd(sessionID) {
      const state = stateFor(sessionID)
      if (!state) return
      state.hasActiveLongProcess = false
      state.longProcessStartedAtMs = 0
    },
    onTerminal(sessionID) {
      const state = stateFor(sessionID)
      if (!state) return
      state.status = "completed"
    },
    check(sessionID, nowMs) {
      const state = stateFor(sessionID)
      if (!state) {
        throw new Error(`watchdog: no registered worker for session ${sessionID}`)
      }
      const now = nowMs ?? clock()
      const meta = buildMetadata(state, sessionID, now)
      const result = classifyLevel1(meta, resolved)
      const previousHealth = state.lastHealth
      state.previousProgressCounter = state.progressCounter
      if (previousHealth !== result.health) {
        const event = eventFor(result.health, result.advanced, previousHealth)
        if (event) {
          onEvent?.(sessionID, event, {
            worker_id: state.workerID,
            session_id: sessionID,
            progress_counter: state.progressCounter,
            previous_progress_counter: state.previousProgressCounter,
            last_change_at_ms: state.lastChangeAtMs,
            health: result.health,
          })
        }
      }
      state.lastHealth = result.health
      return result
    },
    snapshot(sessionID) {
      const state = stateFor(sessionID)
      if (!state) return undefined
      return buildMetadata(state, sessionID, clock())
    },
    checkAll(nowMs) {
      const now = nowMs ?? clock()
      const out: Array<{ sessionID: string; result: Level1Result }> = []
      for (const sessionID of states.keys()) {
        const state = states.get(sessionID)
        if (!state) continue
        const meta = buildMetadata(state, sessionID, now)
        const result = classifyLevel1(meta, resolved)
        const previousHealth = state.lastHealth
        state.previousProgressCounter = state.progressCounter
        if (previousHealth !== result.health) {
          const event = eventFor(result.health, result.advanced, previousHealth)
          if (event) {
            onEvent?.(sessionID, event, {
              worker_id: state.workerID,
              session_id: sessionID,
              progress_counter: state.progressCounter,
              previous_progress_counter: state.previousProgressCounter,
              last_change_at_ms: state.lastChangeAtMs,
              health: result.health,
            })
          }
        }
        state.lastHealth = result.health
        out.push({ sessionID, result })
      }
      return out
    },
    dispose() {
      states.clear()
    },
  }
}

function buildMetadata(state: SessionState, sessionID: string, nowMs: number): WatchdogMetadata {
  return {
    workerID: state.workerID,
    sessionID,
    status: state.status,
    progressCounter: state.progressCounter,
    previousProgressCounter: state.previousProgressCounter,
    lastChangeAtMs: state.lastChangeAtMs,
    lastActivityAtMs: state.lastActivityAtMs,
    nowMs,
    hasActiveLongProcess: state.hasActiveLongProcess,
    longProcessElapsedMs: state.hasActiveLongProcess ? nowMs - state.longProcessStartedAtMs : 0,
  }
}

function eventFor(health: Level1Health, advanced: boolean, previousHealth: Level1Health | null): WatchdogEventName | null {
  if (health === "HEALTHY") {
    if (previousHealth !== null && isInsecureLevel1(previousHealth)) return "watchdog_recovered"
    if (advanced) return "watchdog_progress"
    return null
  }
  if (health === "QUIET_BUT_ACTIVE") return "watchdog_quiet_active"
  if (health === "SUSPECTED_STALL") return "watchdog_stall_suspected"
  return null
}
