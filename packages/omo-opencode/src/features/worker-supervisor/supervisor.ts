/**
 * Subagent Supervisor facade (stateful, per-worker). Pure decision core on top
 * of classify + intervention. The caller gathers cheap signals and calls
 * `check` on each supervision tick; this layer owns the ladder state, loop
 * detection across checks, and the supervision event stream.
 */

import { classifyWorker, isInsecure } from "./classify"
import { nextIntervention, type LadderState } from "./intervention"
import { progressFingerprint } from "./progress"
import type {
  Intervention,
  SupervisionPolicy,
  WorkerHealth,
  WorkerSignal,
} from "./types"
import { SUPERVISION_EVENTS, type SupervisionEventName } from "./events"
import { DEFAULT_SUPERVISION_POLICY } from "./types"

export type SupervisionEventRecord = { event: SupervisionEventName; workerID: string }

export type SupervisionResult = {
  health: WorkerHealth
  classification: string
  intervention: Intervention
  insecureChecks: number
  events: SupervisionEventRecord[]
}

export type WorkerState = LadderState & { lastFingerprint: string | null; unchangedChecks: number }

export type WorkerSupervisor = {
  check(signal: WorkerSignal): SupervisionResult
  reset(workerID: string): void
}

export function createWorkerSupervisor(policy: SupervisionPolicy = DEFAULT_SUPERVISION_POLICY): WorkerSupervisor {
  const states = new Map<string, WorkerState>()

  function stateFor(signal: WorkerSignal): WorkerState {
    let state = states.get(signal.workerID)
    if (!state) {
      state = { insecureChecks: 0, nudgesSent: 0, alreadyReclaimed: false, lastFingerprint: null, unchangedChecks: 0 }
      states.set(signal.workerID, state)
    }
    return state
  }

  return {
    check(signal) {
      const state = stateFor(signal)
      let { health, reason } = classifyWorker(signal, policy)
      const events: SupervisionEventRecord[] = [{ event: "worker-supervision-check", workerID: signal.workerID }]

      const fingerprint = progressFingerprint(signal)
      const unchanged = state.lastFingerprint !== null && state.lastFingerprint === fingerprint
      if (unchanged) {
        state.unchangedChecks += 1
      } else {
        state.unchangedChecks = 0
      }
      state.lastFingerprint = fingerprint

      const keepBurning = signal.tokensDelta > 0 || signal.toolCallsDelta > 0
      if (health === "HEALTHY" && unchanged && keepBurning && state.unchangedChecks >= policy.loopChecks) {
        health = "LOOP"
        reason = "unchanged fingerprint while consuming tokens/tools"
      }

      if (isInsecure(health)) {
        state.insecureChecks += 1
        events.push({ event: loopOrStallEvent(health), workerID: signal.workerID })
      } else {
        if (state.insecureChecks > 0) {
          events.push({ event: "worker-stall-cleared", workerID: signal.workerID })
        }
        state.insecureChecks = 0
        state.nudgesSent = 0
      }

      const intervention = nextIntervention(health, signal, policy, state)
      recordInterventionEvent(events, intervention, signal.workerID)
      if (intervention.action === "NUDGE") state.nudgesSent += 1
      if (intervention.action === "RECLAIM") state.alreadyReclaimed = true

      return {
        health,
        classification: `${health}: ${reason}${unchanged ? " (fingerprint unchanged)" : ""}`,
        intervention,
        insecureChecks: state.insecureChecks,
        events,
      }
    },
    reset(workerID) {
      states.delete(workerID)
    },
  }
}

function loopOrStallEvent(health: WorkerHealth): SupervisionEventName {
  return health === "LOOP" || health === "TOKEN_BURN" ? "worker-suspected-loop" : "worker-suspected-stall"
}

function recordInterventionEvent(events: SupervisionEventRecord[], intervention: Intervention, workerID: string): void {
  switch (intervention.action) {
    case "NUDGE":
      events.push({ event: "worker-nudged", workerID })
      return
    case "RECLAIM":
      events.push({ event: "worker-reclaimed", workerID })
      if (intervention.preservePartial) events.push({ event: "worker-partial-result-preserved", workerID })
      return
    case "REPLACE":
      events.push({ event: "worker-replaced", workerID })
      return
    default:
      return
  }
}

// Re-exported so consumers can enumerate the catalog without a second import.
export { SUPERVISION_EVENTS }
