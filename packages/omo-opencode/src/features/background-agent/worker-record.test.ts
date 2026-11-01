import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createWorkerRecordStore, workerRecordPath } from "./worker-record"
import type { WorkerRecord, WorkerRecordStore } from "./worker-record-types"

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function createStore(now = new Date("2026-10-30T08:00:00.000Z")): WorkerRecordStore {
  const rootDir = mkdtempSync(join(tmpdir(), "omo-worker-record-cas-"))
  roots.push(rootDir)
  return createWorkerRecordStore({ rootDir, now: () => now })
}

function runningRecord(workerID: string): WorkerRecord {
  return {
    schemaVersion: 1,
    workerID,
    sessionID: `ses_${workerID}`,
    parentSessionID: "ses_parent",
    parentMessageID: "msg_parent",
    agent: "explore",
    description: "inspect lifecycle",
    state: "running",
    createdAt: "2026-10-30T07:55:00.000Z",
    startedAt: "2026-10-30T07:56:00.000Z",
    updatedAt: "2026-10-30T07:56:00.000Z",
  }
}

describe("worker record terminal compare-and-set", () => {
  test("the first terminal transition is immutable across duplicate late events", () => {
    const store = createStore()
    store.save(runningRecord("bg_first_wins"))

    const first = store.terminalize("bg_first_wins", {
      state: "completed",
      terminalOutcome: "completed",
      terminalAt: "2026-10-30T08:00:00.000Z",
      terminalAttemptID: "att_1",
      result: "durable answer",
    })
    const late = store.terminalize("bg_first_wins", {
      state: "failed",
      terminalOutcome: "failed",
      terminalAt: "2026-10-30T08:01:00.000Z",
      terminalAttemptID: "att_2",
      terminalReason: "late provider error",
      result: "wrong late result",
    })

    expect(first?.committed).toBe(true)
    expect(late?.committed).toBe(false)
    expect(late?.record.terminalEventID).toBe(first?.record.terminalEventID)
    expect(store.get("bg_first_wins")).toMatchObject({
      state: "completed",
      terminalOutcome: "completed",
      terminalAttemptID: "att_1",
      result: "durable answer",
      wakeState: "pending",
    })
    expect(store.get("bg_first_wins")?.terminalReason).toBeUndefined()
  })

  test("terminal payload and pending wake outbox are written in one record", () => {
    const store = createStore()
    store.save(runningRecord("bg_atomic"))

    const committed = store.terminalize("bg_atomic", {
      state: "blocked",
      terminalOutcome: "blocked",
      terminalAt: "2026-10-30T08:00:00.000Z",
      terminalAttemptID: "att_blocked",
      terminalReason: "worker disappeared",
      result: "partial result",
    })
    const disk = JSON.parse(readFileSync(workerRecordPath(store.rootDir, "bg_atomic"), "utf8")) as WorkerRecord

    expect(committed?.committed).toBe(true)
    expect(disk.terminalEventID).toMatch(/^wake_/)
    expect(disk.wakeEventID).toBe(disk.terminalEventID)
    expect(disk.wakeState).toBe("pending")
    expect(disk.wakePendingAt).toBe(disk.terminalAt)
    expect(disk.result).toBe("partial result")
  })

  test("wake delivery state is monotonic and pruning requires acknowledgement", () => {
    const store = createStore()
    store.save(runningRecord("bg_outbox"))
    store.terminalize("bg_outbox", {
      state: "completed",
      terminalOutcome: "completed",
      terminalAt: "2026-10-30T08:00:00.000Z",
      terminalAttemptID: "att_1",
      result: "answer",
    })

    expect(store.prune(1, new Date("2026-10-31T08:00:00.000Z"))).toBe(0)
    store.markWakeDispatched("bg_outbox", new Date("2026-10-30T08:01:00.000Z"))
    store.markNotificationQueued("bg_outbox", new Date("2026-10-30T08:02:00.000Z"))
    expect(store.get("bg_outbox")?.wakeState).toBe("dispatched")
    expect(store.prune(1, new Date("2026-10-31T08:00:00.000Z"))).toBe(0)

    store.markWakeAcknowledged("bg_outbox", new Date("2026-10-30T08:03:00.000Z"))
    store.markWakeDispatched("bg_outbox", new Date("2026-10-30T08:04:00.000Z"))
    expect(store.get("bg_outbox")).toMatchObject({
      wakeState: "acknowledged",
      wakeAcknowledgedAt: "2026-10-30T08:03:00.000Z",
      notificationDeliveredAt: "2026-10-30T08:03:00.000Z",
    })
    expect(store.prune(1, new Date("2026-10-31T08:00:00.000Z"))).toBe(1)
  })
})
