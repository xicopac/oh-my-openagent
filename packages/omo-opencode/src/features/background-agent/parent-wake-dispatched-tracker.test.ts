import { afterEach, describe, expect, test } from "bun:test"

import type { PendingParentWake } from "./parent-wake-dedupe"
import { ParentWakeDispatchedTracker } from "./parent-wake-dispatched-tracker"

const trackers: ParentWakeDispatchedTracker[] = []

afterEach(() => {
  while (trackers.length > 0) trackers.pop()?.shutdown()
})

function wake(workerID: string, notification: string): PendingParentWake {
  return {
    promptContext: { agent: "sisyphus" },
    notifications: [notification],
    shouldReply: true,
    workerIDs: [workerID],
    queuedAt: 100,
  }
}

describe("dispatched parent wake ownership", () => {
  test("a newer dispatch retains every earlier unacknowledged worker debt", () => {
    const tracker = new ParentWakeDispatchedTracker({
      failureRequeueWindowMs: 60_000,
      onFailureRequeueWindowElapsed: () => {},
    })
    trackers.push(tracker)

    tracker.trackWake("ses_parent", wake("bg_first", "first result"), 200)
    tracker.trackWake("ses_parent", wake("bg_second", "second result"), 300)

    expect(tracker.getWake("ses_parent")).toMatchObject({
      notifications: ["second result", "first result"],
      workerIDs: ["bg_first", "bg_second"],
      dispatchedAt: 300,
    })
  })
})
