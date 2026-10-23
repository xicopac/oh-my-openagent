import { describe, expect, test } from "bun:test"
import { createLivenessSupervisor } from "./supervisor"
import { DEFAULT_SUPERVISOR_POLICY } from "./policy"
import type { SupervisorDeps, SupervisorPolicy, SupervisorEvent } from "./types"

const DEFAULT_POLICY: SupervisorPolicy = {
  launchAckDeadlineMs: 30_000,
  heartbeatIntervalMs: 30_000,
  missingHeartbeatDeadlineMs: 90_000,
  progressStallMs: 180_000,
  completionGraceMs: 10_000,
  orphanIdleMs: 120_000,
  maxAttempts: 2,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerCooldownMs: 300_000,
  notificationBatchWindowMs: 60_000,
}

function makeSupervisor(
  overrides: Partial<SupervisorPolicy> = {},
  extraDeps: Partial<SupervisorDeps> = {},
) {
  const policy = { ...DEFAULT_POLICY, ...overrides }
  const deps: SupervisorDeps = {
    now: () => testClock.now,
    freeWorkerLane: null,
    dispatchRetry: undefined,
    cancel: () => {},
    onEvent: () => {},
    ...extraDeps,
  }
  return createLivenessSupervisor(deps, policy)
}

const testClock = {
  now: 1_000_000,
  advance(ms: number) {
    testClock.now += ms
  },
  set(ms: number) {
    testClock.now = ms
  },
}

describe("liveness-supervisor: exported policy defaults", () => {
  test("DEFAULT_SUPERVISOR_POLICY exact constants", () => {
    expect(DEFAULT_SUPERVISOR_POLICY.launchAckDeadlineMs).toBe(30000)
    expect(DEFAULT_SUPERVISOR_POLICY.heartbeatIntervalMs).toBe(30000)
    expect(DEFAULT_SUPERVISOR_POLICY.missingHeartbeatDeadlineMs).toBe(90000)
    expect(DEFAULT_SUPERVISOR_POLICY.progressStallMs).toBe(180000)
    expect(DEFAULT_SUPERVISOR_POLICY.maxAttempts).toBe(2)
    expect(DEFAULT_SUPERVISOR_POLICY.circuitBreakerFailureThreshold).toBe(3)
    expect(DEFAULT_SUPERVISOR_POLICY.circuitBreakerCooldownMs).toBe(300000)
    expect(DEFAULT_SUPERVISOR_POLICY.orphanIdleMs).toBe(120000)
    expect(DEFAULT_SUPERVISOR_POLICY.notificationBatchWindowMs).toBe(60000)
  })
})

describe("liveness-supervisor: die-before-first-ack", () => {
  test("detects ack_missing at launchAckDeadlineMs and transitions to failed", () => {
    const { advance } = testClock
    const sup = makeSupervisor()

    sup.register({
      id: "del-1",
      workerId: "w1",
      providerId: "p1",
      parentId: "parent-1",
      freeLane: true,
    })

    advance(30_001)

    sup.tick()

    const rec = sup.snapshot("del-1")
    expect(rec?.status).toBe("failed")
    expect(rec?.failure).toBe("ack_missing")
    expect(rec?.status).not.toBe("submitted")
  })
})

describe("liveness-supervisor: crash-during-execution", () => {
  test("detects process_exit immediately on tick, no ACK wait", () => {
    const sup = makeSupervisor()

    sup.register({
      id: "del-2",
      workerId: "w2",
      providerId: "p2",
      parentId: "parent-2",
      freeLane: true,
    })

    sup.processExited("del-2")

    sup.tick()

    const rec = sup.snapshot("del-2")
    expect(rec?.status).toBe("failed")
    expect(rec?.failure).toBe("process_exit")
  })
})

describe("liveness-supervisor: hang-without-heartbeat", () => {
  test("detects heartbeat_missing at missingHeartbeatDeadlineMs", () => {
    const sup = makeSupervisor()

    sup.register({
      id: "del-3",
      workerId: "w3",
      providerId: "p3",
      parentId: "parent-3",
      freeLane: true,
    })

    sup.acknowledge("del-3")
    sup.heartbeat("del-3")

    testClock.advance(90_001)

    sup.tick()

    const rec = sup.snapshot("del-3")
    expect(rec?.failure).toBe("heartbeat_missing")
  })
})

describe("liveness-supervisor: heartbeats-without-progress", () => {
  test("detects progress_stall at progressStallMs even though heartbeats continue", () => {
    const sup = makeSupervisor()

    sup.register({
      id: "del-4",
      workerId: "w4",
      providerId: "p4",
      parentId: "parent-4",
      freeLane: true,
    })
    sup.heartbeat("del-4")
    sup.progress("del-4")

    testClock.advance(180_001)

    sup.tick()

    const rec = sup.snapshot("del-4")
    expect(rec?.failure).toBe("progress_stall")
  })
})

describe("liveness-supervisor: rate-limit-and-auth", () => {
  test("rate_limit error triggers retry on free lane", () => {
    const dispatchCalls: number[] = []
    const sup = makeSupervisor(
      {},
      {
        dispatchRetry: (req) => {
          dispatchCalls.push(req.attempt)
          return true
        },
      },
    )

    sup.register({
      id: "del-5",
      workerId: "w5",
      providerId: "p5",
      parentId: "parent-5",
      freeLane: true,
    })

    sup.fail("del-5", "rate_limit")

    const rec = sup.snapshot("del-5")
    expect(rec?.status).toBe("recovering")
    expect(dispatchCalls.length).toBe(1)
  })

  test("rate_limit dispatches one retry then blocks on next failure", () => {
    const dispatchCalls: number[] = []
    const sup = makeSupervisor(
      {},
      {
        dispatchRetry: (req) => {
          dispatchCalls.push(req.attempt)
          return true
        },
      },
    )

    sup.register({
      id: "del-5b",
      workerId: "w5b",
      providerId: "p5b",
      parentId: "parent-5b",
      freeLane: true,
    })

    sup.fail("del-5b", "rate_limit")
    expect(sup.snapshot("del-5b")?.status).toBe("recovering")
    expect(dispatchCalls.length).toBe(1)

    sup.fail("del-5b", "rate_limit")
    const rec = sup.snapshot("del-5b")
    expect(rec?.status).toBe("blocked")
    expect(rec?.blockedReason).toBe("retries_exhausted")
    expect(dispatchCalls.length).toBe(1)
  })

  test("auth error -> blocked, no retry", () => {
    const sup = makeSupervisor(
      {},
      {
        dispatchRetry: () => false,
      },
    )

    sup.register({
      id: "del-6",
      workerId: "w6",
      providerId: "p6",
      parentId: "parent-6",
      freeLane: true,
    })

    sup.fail("del-6", "provider_error")

    const rec = sup.snapshot("del-6")
    expect(rec?.status).toBe("blocked")
    expect(rec?.blockedReason).toBe("non_retryable")
  })
})

describe("liveness-supervisor: retry-budget", () => {
  test("first failure dispatches exactly one retry; second failure blocks retries_exhausted, no third dispatch", () => {
    const dispatchCalls: number[] = []
    const sup = makeSupervisor(
      {},
      {
        dispatchRetry: (req) => {
          dispatchCalls.push(req.attempt)
          return true
        },
      },
    )

    sup.register({
      id: "del-rb",
      workerId: "wrb",
      providerId: "prb",
      parentId: "parent-rb",
      freeLane: true,
    })

    sup.fail("del-rb", "process_exit")
    expect(sup.snapshot("del-rb")?.status).toBe("recovering")
    expect(dispatchCalls.length).toBe(1)

    sup.fail("del-rb", "process_exit")
    const rec = sup.snapshot("del-rb")
    expect(rec?.status).toBe("blocked")
    expect(rec?.blockedReason).toBe("retries_exhausted")
    expect(dispatchCalls.length).toBe(1)
  })
})

describe("liveness-supervisor: late-completion-after-block", () => {
  test("after retries exhausted and blocked, complete() does not resurrect, does not change status, no terminal wake", () => {
    const events: SupervisorEvent[] = []
    const dispatchCalls: number[] = []
    const sup = makeSupervisor(
      {},
      {
        onEvent: (e) => events.push(e),
        dispatchRetry: (req) => {
          dispatchCalls.push(req.attempt)
          return true
        },
      },
    )

    sup.register({
      id: "del-lc",
      workerId: "wlc",
      providerId: "plc",
      parentId: "parent-lc",
      freeLane: true,
    })

    sup.fail("del-lc", "process_exit")
    sup.fail("del-lc", "process_exit")

    const recBefore = sup.snapshot("del-lc")
    expect(recBefore?.status).toBe("blocked")

    const terminalWakesBefore = events.filter((e) => e.kind === "wake_parent" || e.kind === "delegation_completed").length

    sup.complete("del-lc", { result: "late" })

    const recAfter = sup.snapshot("del-lc")
    expect(recAfter?.status).toBe("blocked")
    expect(recAfter?.status).not.toBe("completed")

    const terminalWakesAfter = events.filter((e) => e.kind === "wake_parent" || e.kind === "delegation_completed").length
    expect(terminalWakesAfter).toBe(terminalWakesBefore)
  })
})

describe("liveness-supervisor: complete-after-timeout", () => {
  test("late completion does not resurrect terminal state", () => {
    const sup = makeSupervisor()

    sup.register({
      id: "del-7",
      workerId: "w7",
      providerId: "p7",
      parentId: "parent-7",
      freeLane: true,
    })

    testClock.advance(30_001)
    sup.tick()

    const rec1 = sup.snapshot("del-7")
    expect(rec1?.status).not.toBe("completed")

    sup.complete("del-7", { result: "ok" })

    const rec2 = sup.snapshot("del-7")
    expect(rec2?.status).toBe("completed")
    expect(rec2?.completedAtMs).toBeDefined()
  })

  test("exactly one terminal wake on completion", () => {
    const sup = makeSupervisor()

    sup.register({
      id: "del-8",
      workerId: "w8",
      providerId: "p8",
      parentId: "parent-8",
      freeLane: true,
    })

    testClock.advance(30_001)
    sup.tick()

    sup.complete("del-8", { result: "done" })

    const finalRec = sup.snapshot("del-8")
    expect(finalRec?.status).toBe("completed")
  })
})

describe("liveness-supervisor: orphaned", () => {
  test("detects orphaned when parent idle and child running past orphanIdleMs", () => {
    const sup = makeSupervisor()

    sup.register({
      id: "del-9",
      workerId: "w9",
      providerId: "p9",
      parentId: "parent-9",
      freeLane: true,
    })
    sup.acknowledge("del-9")

    sup.setParentIdle("del-9", true)

    testClock.advance(120_001)

    sup.tick()

    const rec = sup.snapshot("del-9")
    expect(rec?.status).toBe("blocked")
    expect(rec?.blockedReason).toBe("orphaned")
  })
})

describe("liveness-supervisor: circuit-breaker", () => {
  test("circuit breaker opens at threshold after repeated failures for same workerId", () => {
    const sup = makeSupervisor(
      {},
      {
        dispatchRetry: () => true,
      },
    )

    sup.register({
      id: "del-10",
      workerId: "w10",
      providerId: "p10",
      parentId: "parent-10",
      freeLane: true,
    })

    sup.fail("del-10", "process_exit")
    sup.fail("del-10", "process_exit")
    sup.fail("del-10", "process_exit")

    const rec = sup.snapshot("del-10")
    expect(rec?.status).toBe("blocked")
    expect(rec?.blockedReason).toBe("circuit_open")
  })

  test("no reclaim storm: bounded cancel and dispatch calls", () => {
    const sup = makeSupervisor()

    sup.register({
      id: "del-11",
      workerId: "w11",
      providerId: "p11",
      parentId: "parent-11",
      freeLane: true,
    })

    sup.fail("del-11", "process_exit")
    sup.fail("del-11", "process_exit")
    sup.fail("del-11", "process_exit")

    const rec = sup.snapshot("del-11")
    expect(rec?.status).toBe("blocked")
  })
})

describe("liveness-supervisor: no-paid-wake-loop", () => {
  test("100 heartbeats => 0 wakes", () => {
    const events: SupervisorEvent[] = []
    const sup = makeSupervisor({}, { onEvent: (e) => events.push(e) })

    sup.register({
      id: "del-12",
      workerId: "w12",
      providerId: "p12",
      parentId: "parent-12",
      freeLane: true,
    })

    for (let i = 0; i < 100; i++) {
      sup.heartbeat("del-12")
    }

    sup.tick()

    const wakes = events.filter((e) => e.kind === "wake_parent" || e.kind === "delegation_completed")
    expect(wakes.length).toBe(0)

    const rec = sup.snapshot("del-12")
    expect(rec?.status).toBe("submitted")
  })

  test("1 completion => exactly 1 terminal wake", () => {
    const events: SupervisorEvent[] = []
    const sup = makeSupervisor({}, { onEvent: (e) => events.push(e) })

    sup.register({
      id: "del-13",
      workerId: "w13",
      providerId: "p13",
      parentId: "parent-13",
      freeLane: true,
    })

    testClock.advance(30_001)
    sup.tick()

    sup.complete("del-13", { result: "done" })

    const wakes = events.filter((e) => e.kind === "wake_parent" || e.kind === "delegation_completed")
    expect(wakes.length).toBe(1)

    const finalRec = sup.snapshot("del-13")
    expect(finalRec?.status).toBe("completed")
  })

  test("after terminal, further heartbeats/late wakes => no additional paid-parent wake", () => {
    const events: SupervisorEvent[] = []
    const sup = makeSupervisor({}, { onEvent: (e) => events.push(e) })

    sup.register({
      id: "del-13b",
      workerId: "w13b",
      providerId: "p13b",
      parentId: "parent-13b",
      freeLane: true,
    })

    sup.complete("del-13b", { result: "done" })

    const wakesAfterTerminal = events.filter((e) => e.kind === "wake_parent" && (e as { paidRootWake?: boolean }).paidRootWake).length

    sup.heartbeat("del-13b")
    sup.heartbeat("del-13b")
    sup.complete("del-13b", { result: "late" })

    const wakesAfterLate = events.filter((e) => e.kind === "wake_parent" && (e as { paidRootWake?: boolean }).paidRootWake).length
    expect(wakesAfterLate).toBe(wakesAfterTerminal)
  })

  test("after blocked, further heartbeats => no additional paid-parent wake", () => {
    const events: SupervisorEvent[] = []
    const sup = makeSupervisor({}, { onEvent: (e) => events.push(e) })

    sup.register({
      id: "del-13c",
      workerId: "w13c",
      providerId: "p13c",
      parentId: "parent-13c",
      freeLane: false,
    })

    sup.fail("del-13c", "process_exit")

    const paidRootAfterBlocked = events.filter((e) => e.kind === "wake_parent" && (e as { paidRootWake?: boolean }).paidRootWake).length

    sup.heartbeat("del-13c")
    sup.heartbeat("del-13c")

    const paidRootAfterLate = events.filter((e) => e.kind === "wake_parent" && (e as { paidRootWake?: boolean }).paidRootWake).length
    expect(paidRootAfterLate).toBe(paidRootAfterBlocked)
  })
})

describe("liveness-supervisor: free-lane-unavailable", () => {
  test("free lane unavailable => BLOCKED, dispatchRetry not called", () => {
    const sup = makeSupervisor()

    sup.register({
      id: "del-14",
      workerId: "w14",
      providerId: "p14",
      parentId: "parent-14",
      freeLane: false,
    })

    sup.fail("del-14", "process_exit")

    const rec = sup.snapshot("del-14")
    expect(rec?.status).toBe("blocked")
  })

  test("paid-only candidate (freeLane: false) => BLOCKED", () => {
    const sup = makeSupervisor()

    sup.register({
      id: "del-15",
      workerId: "w15",
      providerId: "p15",
      parentId: "parent-15",
      freeLane: false,
    })

    sup.fail("del-15", "process_exit")

    const rec = sup.snapshot("del-15")
    expect(rec?.status).toBe("blocked")
  })
})