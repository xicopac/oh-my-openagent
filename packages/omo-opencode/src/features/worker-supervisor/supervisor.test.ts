import { describe, expect, test } from "bun:test"
import { createWorkerSupervisor } from "./supervisor"
import type { SupervisionPolicy, WorkerSignal } from "./types"

const POLICY: SupervisionPolicy = {
  startupGraceMs: 60_000,
  quietStallThresholdMs: 180_000,
  loopChecks: 3,
  tokenBurnThreshold: 200_000,
  budgetWarnFraction: 0.9,
  wedgedThresholdMs: 300_000,
  paidQuietStallThresholdMs: 120_000,
  paidMaxInsecureChecksBeforeReclaim: 2,
  freeMaxInsecureChecksBeforeReclaim: 4,
}

function base(overrides: Partial<WorkerSignal> = {}): WorkerSignal {
  return {
    workerID: "w1",
    sessionID: "s1",
    status: "running",
    nowMs: 1_000_000,
    lastActivityAtMs: 1_000_000,
    lastMeaningfulProgressAtMs: 1_000_000,
    tokensDelta: 0,
    toolCallsDelta: 0,
    currentTool: null,
    filesChangedDelta: 0,
    outputTail: "",
    isLongRunningCommand: false,
    commandActive: false,
    commandElapsedMs: 0,
    childTokenBudget: 0,
    childTokensUsed: 0,
    isPaid: false,
    insecureChecks: 0,
    ...overrides,
  }
}

describe("subagent supervisor", () => {
  test("leaves a healthy active child alone", () => {
    const sup = createWorkerSupervisor(POLICY)
    const r = sup.check(base({ filesChangedDelta: 2, outputTail: "wrote auth.ts" }))
    expect(r.health).toBe("HEALTHY")
    expect(r.intervention.action).toBe("OBSERVE")
  })

  test("grants startup grace regardless of quiet", () => {
    const sup = createWorkerSupervisor(POLICY)
    const r = sup.check(base({ status: "starting", lastActivityAtMs: 0 }))
    expect(r.health).toBe("STARTING")
    expect(r.intervention.action).toBe("OBSERVE")
  })

  test("detects a quiet stall and requests status, not immediate reclaim", () => {
    const sup = createWorkerSupervisor(POLICY)
    const r = sup.check(base({ lastActivityAtMs: 1_000_000 - 200_000 }))
    expect(r.health).toBe("QUIET_STALL")
    expect(r.intervention.action).toBe("STATUS_REQUEST")
  })

  test("reclaims after continued stall (free worker, 4 insecure checks)", () => {
    const sup = createWorkerSupervisor(POLICY)
    let last = sup.check(base({ lastActivityAtMs: 1_000_000 - 200_000 }))
    for (let i = 0; i < 4; i++) {
      last = sup.check(base({ lastActivityAtMs: 0, insecureChecks: i }))
    }
    expect(last.health).toBe("QUIET_STALL")
    expect(last.intervention.action).toBe("RECLAIM")
    expect(last.intervention.preservePartial).toBe(true)
  })

  test("detects a token burn (tokens rising, no state change) as a loop", () => {
    const sup = createWorkerSupervisor(POLICY)
    const r = sup.check(base({ lastActivityAtMs: 0, tokensDelta: 300_000, toolCallsDelta: 0 }))
    expect(r.classification).toContain("TOKEN_BURN")
    expect(r.events.some((e) => e.event === "worker-suspected-loop")).toBe(true)
  })

  test("treats a legitimate long-running build as healthy while active", () => {
    const sup = createWorkerSupervisor(POLICY)
    const r = sup.check(base({
      isLongRunningCommand: true,
      commandActive: true,
      commandElapsedMs: 100_000,
      currentTool: "bash",
    }))
    expect(r.health).toBe("LONG_RUNNING")
    expect(r.intervention.action).toBe("OBSERVE")
  })

  test("classifies a wedged build (no CPU, past threshold) as WEDGED", () => {
    const sup = createWorkerSupervisor(POLICY)
    const r = sup.check(base({
      isLongRunningCommand: true,
      commandActive: false,
      commandElapsedMs: 400_000,
      currentTool: "bash",
    }))
    expect(r.health).toBe("WEDGED")
  })

  test("supervises paid workers more strictly (fewer insecure checks before reclaim)", () => {
    const sup = createWorkerSupervisor(POLICY)
    sup.check(base({ isPaid: true, lastActivityAtMs: 1_000_000 - 200_000 }))
    const r = sup.check(base({ isPaid: true, lastActivityAtMs: 0 }))
    expect(r.intervention.action).toBe("RECLAIM")
  })

  test("changed code + rerun test is not a false-positive stall", () => {
    const sup = createWorkerSupervisor(POLICY)
    const r = sup.check(base({ filesChangedDelta: 1, outputTail: "edited sync.ts", currentTool: "bash" }))
    expect(r.classification).not.toContain("LOOP")
    expect(r.health).toBe("HEALTHY")
  })

  test("new incremental output advances progress (fingerprint changes)", () => {
    const sup = createWorkerSupervisor(POLICY)
    const r1 = sup.check(base({ lastActivityAtMs: 1_000_000 - 250_000, outputTail: "found route.ts" }))
    const r2 = sup.check(base({ lastActivityAtMs: 1_000_000 - 240_000, outputTail: "found controller.ts" }))
    expect(r2.classification).not.toContain("fingerprint unchanged")
    expect(r2.intervention.action).not.toBe("RECLAIM")
  })

  test("nudge can recover a stalled worker (stall-cleared event)", () => {
    const sup = createWorkerSupervisor(POLICY)
    const stalled = sup.check(base({ lastActivityAtMs: 1_000_000 - 200_000 }))
    expect(stalled.intervention.action).toBe("STATUS_REQUEST")
    // worker reports progress -> clears
    const recovered = sup.check(base({ filesChangedDelta: 1, outputTail: "fixed auth.ts" }))
    expect(recovered.events.some((e) => e.event === "worker-stall-cleared")).toBe(true)
    expect(recovered.insecureChecks).toBe(0)
  })

  test("independent workers do not share ladder state", () => {
    const sup = createWorkerSupervisor(POLICY)
    sup.check(base({ workerID: "a", lastActivityAtMs: 0 }))
    sup.check(base({ workerID: "a", lastActivityAtMs: 0 }))
    const other = sup.check(base({ workerID: "b", lastActivityAtMs: 1_000_000 - 200_000 }))
    expect(other.intervention.action).toBe("STATUS_REQUEST")
  })

  test("detects a repeated search loop via unchanged fingerprint across checks", () => {
    const sup = createWorkerSupervisor(POLICY)
    // when the same grep pattern keeps consuming tokens/tools with no file change
    for (let i = 0; i < 3; i++) {
      sup.check(base({ tokenDelta: 50_000, toolCallsDelta: 1, currentTool: "grep", outputTail: "found src/auth.ts" }))
    }
    const r = sup.check(base({ tokenDelta: 50_000, toolCallsDelta: 1, currentTool: "grep", outputTail: "found src/auth.ts" }))
    expect(r.health).toBe("LOOP")
    expect(r.events.some((e) => e.event === "worker-suspected-loop")).toBe(true)
  })

  test("budget warning nudges the worker to return a partial result", () => {
    const sup = createWorkerSupervisor(POLICY)
    const r = sup.check(base({ childTokenBudget: 600_000, childTokensUsed: 580_000 }))
    expect(r.health).toBe("BUDGET_WARNING")
    expect(r.intervention.action).toBe("NUDGE")
  })

  test("budget exhaustion reclaims the worker and preserves partial output", () => {
    const sup = createWorkerSupervisor(POLICY)
    const r = sup.check(base({ childTokenBudget: 600_000, childTokensUsed: 600_000 }))
    expect(r.health).toBe("EXHAUSTED")
    expect(r.intervention.action).toBe("RECLAIM")
    expect(r.events.some((e) => e.event === "worker-partial-result-preserved")).toBe(true)
  })
})
