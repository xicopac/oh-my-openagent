/**
 * Watchdog Level 1 — stateful metadata-only facade. The integration owner feeds
 * the monotonic per-child-session activity-event count via `onActivity` and the
 * lifecycle stage via `advance`/`markRequestStarted`; this layer classifies
 * health and the specific stall mode from counters, stage, and timestamps alone.
 * It never reads output, transcripts, or session contents, and makes zero model
 * calls. Pure: only `now` and `onEvent` are injectable.
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
import {
  advanceStage,
  isTerminalStage,
  milestoneForStage,
  type ChildMilestoneEvent,
} from "./lifecycle"
import { classifyStallMode, type StallClassification } from "./stall"
import { DEFAULT_STALL_TIMEOUTS, type StallTimeoutPolicy } from "./timeouts"
import type { ChildStage, StallMode, WorkerStatus } from "./types"

export type WatchdogEventName =
  | "watchdog_progress"
  | "watchdog_quiet_active"
  | "watchdog_stall_suspected"
  | "watchdog_recovered"
  | "watchdog_nudged"
  | "watchdog_reclaimed"
  | ChildMilestoneEvent

export type WatchdogCheckResult = Level1Result & {
  stage: ChildStage
  stallMode: StallMode | null
  timedOut: boolean
}

export type Watchdog = {
  register(sessionID: string, workerID: string, initialStage?: ChildStage): void
  unregister(sessionID: string): void
  sessions(): string[]
  onActivity(sessionID: string): void
  onProcessStart(sessionID: string): void
  onProcessEnd(sessionID: string): void
  /** Advance to a lifecycle stage (request_started, first_response, terminal). */
  advance(sessionID: string, stage: ChildStage): void
  /** Mark the provider request as dispatched (== stage request_started). */
  markRequestStarted(sessionID: string): void
  /** Mark the child as reclaimed/stalled (truthful status, no longer running). */
  markStalled(sessionID: string): void
  onTerminal(sessionID: string, stage?: ChildStage): void
  check(sessionID: string, nowMs?: number): WatchdogCheckResult
  checkAll(nowMs?: number): Array<{ sessionID: string; result: WatchdogCheckResult }>
  snapshot(sessionID: string): WatchdogMetadata | undefined
  dispose(): void
}

export type WatchdogOptions = {
  onEvent?: (sessionID: string, event: WatchdogEventName, detail?: Record<string, unknown>) => void
  now?: () => number
  timeouts?: Partial<StallTimeoutPolicy>
}

type SessionState = {
  workerID: string
  status: WorkerStatus
  stage: ChildStage
  stageAtMs: number
  requestStartedAtMs: number
  firstResponseAtMs: number
  firstProgressEmitted: boolean
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
  const timeouts: StallTimeoutPolicy = { ...DEFAULT_STALL_TIMEOUTS, ...opts.timeouts }
  const clock = opts.now ?? (() => Date.now())
  const onEvent = opts.onEvent
  const states = new Map<string, SessionState>()

  function stateFor(sessionID: string): SessionState | undefined {
    return states.get(sessionID)
  }

  function emit(sessionID: string, event: WatchdogEventName, detail?: Record<string, unknown>): void {
    onEvent?.(sessionID, event, detail)
  }

  function advance(state: SessionState, sessionID: string, next: ChildStage): void {
    const before = state.stage
    const resulting = advanceStage(before, next)
    if (resulting === before) return
    const now = clock()
    state.stage = resulting
    state.stageAtMs = now
    if (resulting === "request_started" && state.requestStartedAtMs === 0) {
      state.requestStartedAtMs = now
      state.status = "running"
    }
    if (resulting === "first_response" && state.firstResponseAtMs === 0) {
      state.firstResponseAtMs = now
      state.status = "running"
    }
    if (isTerminalStage(resulting)) {
      state.status = resulting === "completed" ? "completed" : resulting === "failed" ? "error" : "cancelled"
    }
    emit(sessionID, milestoneForStage(resulting), {
      worker_id: state.workerID,
      session_id: sessionID,
      stage: resulting,
      stage_at_ms: state.stageAtMs,
      previous_stage: before,
    })
  }

  return {
    register(sessionID, workerID, initialStage = "session_created") {
      const now = clock()
      states.set(sessionID, {
        workerID,
        status: initialStage === "session_created" ? "starting" : "running",
        stage: initialStage,
        stageAtMs: now,
        requestStartedAtMs: 0,
        firstResponseAtMs: 0,
        firstProgressEmitted: false,
        progressCounter: 0,
        previousProgressCounter: 0,
        lastChangeAtMs: now,
        lastActivityAtMs: now,
        hasActiveLongProcess: false,
        longProcessStartedAtMs: 0,
        lastHealth: null,
      })
      emit(sessionID, milestoneForStage(initialStage), {
        worker_id: workerID,
        session_id: sessionID,
        stage: initialStage,
        stage_at_ms: now,
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
      if (state.status === "starting" || state.status === "pending") {
        state.status = "running"
      }
      // First observed output after dispatch is the provider's first response;
      // a later distinct advance is first meaningful progress.
      if (state.stage === "request_started" || state.stage === "session_created") {
        advance(state, sessionID, "first_response")
      } else if (state.stage === "first_response" && !state.firstProgressEmitted && state.progressCounter >= 2) {
        state.firstProgressEmitted = true
        emit(sessionID, "child_first_progress", {
          worker_id: state.workerID,
          session_id: sessionID,
          progress_counter: state.progressCounter,
        })
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
    advance(sessionID, stage) {
      const state = stateFor(sessionID)
      if (!state) return
      advance(state, sessionID, stage)
    },
    markRequestStarted(sessionID) {
      const state = stateFor(sessionID)
      if (!state) return
      advance(state, sessionID, "request_started")
    },
    markStalled(sessionID) {
      const state = stateFor(sessionID)
      if (!state) return
      state.status = "stalled"
    },
    onTerminal(sessionID, stage = "completed") {
      const state = stateFor(sessionID)
      if (!state) return
      advance(state, sessionID, stage)
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
          emit(sessionID, event, {
            worker_id: state.workerID,
            session_id: sessionID,
            progress_counter: state.progressCounter,
            previous_progress_counter: state.previousProgressCounter,
            last_change_at_ms: state.lastChangeAtMs,
            health: result.health,
            stage: state.stage,
          })
        }
      }
      state.lastHealth = result.health
      const stall = classifyStallMode(meta, timeouts)
      return {
        ...result,
        stage: state.stage,
        stallMode: stall.mode,
        timedOut: stall.timedOut,
      }
    },
    snapshot(sessionID) {
      const state = stateFor(sessionID)
      if (!state) return undefined
      return buildMetadata(state, sessionID, clock())
    },
    checkAll(nowMs) {
      const now = nowMs ?? clock()
      const out: Array<{ sessionID: string; result: WatchdogCheckResult }> = []
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
            emit(sessionID, event, {
              worker_id: state.workerID,
              session_id: sessionID,
              progress_counter: state.progressCounter,
              previous_progress_counter: state.previousProgressCounter,
              last_change_at_ms: state.lastChangeAtMs,
              health: result.health,
              stage: state.stage,
            })
          }
        }
        state.lastHealth = result.health
        const stall = classifyStallMode(meta, timeouts)
        out.push({
          sessionID,
          result: { ...result, stage: state.stage, stallMode: stall.mode, timedOut: stall.timedOut },
        })
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
    stage: state.stage,
    stageAtMs: state.stageAtMs,
    requestStartedAtMs: state.requestStartedAtMs,
    firstResponseAtMs: state.firstResponseAtMs,
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

export type { StallClassification }
