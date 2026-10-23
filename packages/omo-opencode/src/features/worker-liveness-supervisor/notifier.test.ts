import { describe, expect, test } from "bun:test"
import { createNotificationBatcher } from "./notifier"
import type { NotificationEvent } from "./notifier"

describe("notifier: batching and terminal dedup", () => {
  test("ordinary event below window => 0 wakes, pendingCount 1", () => {
    const clock = { now: 0 }
    const calls: NotificationEvent[] = []
    const batcher = createNotificationBatcher({
      now: () => clock.now,
      windowMs: 60000,
      onWake: (e) => calls.push(e),
    })

    batcher.record({ kind: "heartbeat_observed", id: "x" } as NotificationEvent)

    expect(calls.length).toBe(0)
    expect(batcher.pendingCount()).toBe(1)
  })

  test("advance past window => 1 wake, pending cleared", () => {
    const clock = { now: 0 }
    const calls: NotificationEvent[] = []
    const batcher = createNotificationBatcher({
      now: () => clock.now,
      windowMs: 60000,
      onWake: (e) => calls.push(e),
    })

    batcher.record({ kind: "heartbeat_observed", id: "x" } as NotificationEvent)

    clock.now = 60001
    batcher.checkWindow()

    expect(calls.length).toBe(1)
    expect(batcher.pendingCount()).toBe(0)
  })

  test("terminal event => immediate 1 wake", () => {
    const clock = { now: 0 }
    const calls: NotificationEvent[] = []
    const batcher = createNotificationBatcher({
      now: () => clock.now,
      windowMs: 60000,
      onWake: (e) => calls.push(e),
    })

    batcher.record({ kind: "delegation_completed", id: "t1" } as NotificationEvent)

    expect(calls.length).toBe(1)
  })

  test("duplicate terminal event same kind/id => still 1 wake", () => {
    const clock = { now: 0 }
    const calls: NotificationEvent[] = []
    const batcher = createNotificationBatcher({
      now: () => clock.now,
      windowMs: 60000,
      onWake: (e) => calls.push(e),
    })

    batcher.record({ kind: "delegation_completed", id: "t1" } as NotificationEvent)
    batcher.record({ kind: "delegation_completed", id: "t1" } as NotificationEvent)

    expect(calls.length).toBe(1)
  })

  test("distinct terminal kinds for same id => 2 wakes", () => {
    const clock = { now: 0 }
    const calls: NotificationEvent[] = []
    const batcher = createNotificationBatcher({
      now: () => clock.now,
      windowMs: 60000,
      onWake: (e) => calls.push(e),
    })

    batcher.record({ kind: "delegation_completed", id: "t2" } as NotificationEvent)
    batcher.record({ kind: "wake_parent", id: "t2", wakeReason: "terminal", paidRootWake: true } as NotificationEvent)

    expect(calls.length).toBe(2)
  })

  test("paid-root loop: terminal wake followed by repeated same-id wake_parent => no extra wake", () => {
    const clock = { now: 0 }
    const calls: NotificationEvent[] = []
    const batcher = createNotificationBatcher({
      now: () => clock.now,
      windowMs: 60000,
      onWake: (e) => calls.push(e),
    })

    batcher.record({ kind: "wake_parent", id: "p", wakeReason: "blocked", paidRootWake: true } as NotificationEvent)
    const before = calls.length

    for (let i = 0; i < 5; i++) {
      batcher.record({ kind: "wake_parent", id: "p", wakeReason: "blocked", paidRootWake: true } as NotificationEvent)
    }

    expect(calls.length).toBe(before)
  })
})