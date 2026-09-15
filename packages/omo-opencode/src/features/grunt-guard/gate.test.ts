import { describe, expect, test } from "bun:test"
import {
  analyzeGruntSignals,
  createPreGruntGate,
  evaluateEarlyDelegation,
  moduleRoot,
} from "./index"
import type { ToolActivityEvent } from "./detector"

const T0 = 1_000_000

function ev(tool: string, atMs: number, target?: string, selective?: boolean): ToolActivityEvent {
  return { tool, atMs, ...(target ? { target } : {}), ...(selective ? { selective: true } : {}) }
}

describe("evaluateEarlyDelegation (early gate detector)", () => {
  test("one tiny root lookup is allowed", () => {
    // given a single narrow grep
    const events = [ev("grep", T0, "src/auth")]

    // when classified
    const verdict = evaluateEarlyDelegation(events)

    // then it is not delegation-required
    expect(verdict.shouldDelegate).toBe(false)
    expect(verdict.reason).toBeNull()
  })

  test("one exact anchored read is treated as verification, not grunt", () => {
    // given a worker-identified anchored read (offset+limit)
    const events = [ev("read", T0, "src/auth/refresh.ts", true)]

    // when classified
    const verdict = evaluateEarlyDelegation(events)

    // then it contributes no grunt weight
    expect(verdict.shouldDelegate).toBe(false)
    expect(verdict.signal.gruntCount).toBe(0)
  })

  test("a broad search/read sequence triggers early delegation", () => {
    // given a grep -> read -> read -> grep -> read sweep
    const events = [
      ev("grep", T0, "src/auth"),
      ev("read", T0 + 1, "src/auth/login.ts"),
      ev("read", T0 + 2, "src/auth/token.ts"),
      ev("grep", T0 + 3, "src/auth"),
      ev("read", T0 + 4, "src/auth/refresh.ts"),
    ]

    // when classified
    const verdict = evaluateEarlyDelegation(events)

    // then it requires delegation with the search->read->search reason
    expect(verdict.shouldDelegate).toBe(true)
    expect(verdict.signal.searchReadSearch).toBe(true)
    expect(verdict.reason).toContain("search")
  })

  test("cross-module investigation triggers delegation", () => {
    // given reads across the Android and server module roots
    const events = [
      ev("grep", T0, "lobodamar-android/onboarding"),
      ev("read", T0 + 1, "lobodamar-android/OnboardingActivity.kt"),
      ev("grep", T0 + 2, "lobodamar-server/routes"),
      ev("read", T0 + 3, "lobodamar-server/schema.sql"),
    ]

    // when classified
    const verdict = evaluateEarlyDelegation(events)

    // then the cross-module signal fires
    expect(verdict.shouldDelegate).toBe(true)
    expect(verdict.signal.crossModule).toBe(true)
    expect(verdict.signal.distinctModules).toBeGreaterThanOrEqual(2)
    expect(verdict.reason).toContain("cross-module")
  })

  test("the gate acts before many operations accumulate (threshold 4, not 10-20)", () => {
    // given four grunt operations in one file tree
    const events = [
      ev("grep", T0, "src"),
      ev("read", T0 + 1, "src/a.ts"),
      ev("read", T0 + 2, "src/b.ts"),
      ev("read", T0 + 3, "src/c.ts"),
    ]

    // when classified
    const verdict = evaluateEarlyDelegation(events)

    // then it fires at 4 ops, not after a long crawl
    expect(verdict.shouldDelegate).toBe(true)
    expect(verdict.signal.gruntCount).toBe(4)
  })

  test("high context pressure lowers the threshold", () => {
    // given three grunt ops (below the default-4 threshold)
    const events = [
      ev("read", T0, "src/a.ts"),
      ev("read", T0 + 1, "src/b.ts"),
      ev("read", T0 + 2, "src/c.ts"),
    ]

    // when classified at full context pressure
    const low = evaluateEarlyDelegation(events)
    const high = evaluateEarlyDelegation(events, { contextPressure: 1 })

    // then full pressure fires earlier than no pressure
    expect(low.shouldDelegate).toBe(false)
    expect(high.shouldDelegate).toBe(true)
    expect(high.effectiveThreshold).toBeLessThan(low.effectiveThreshold)
  })

  test("a low-context fresh task still delegates immediately via search->read->search", () => {
    // given a search -> read -> search pattern with no prior context
    const events = [
      ev("grep", T0, "src/handlers"),
      ev("read", T0 + 1, "src/handlers/auth.ts"),
      ev("grep", T0 + 2, "src/handlers"),
    ]

    // when classified at zero pressure
    const verdict = evaluateEarlyDelegation(events, { contextPressure: 0 })

    // then it still requires delegation without a high root-token budget
    expect(verdict.shouldDelegate).toBe(true)
  })
})

describe("analyzeGruntSignals + moduleRoot", () => {
  test("extracts the top-level module root from a path", () => {
    expect(moduleRoot("src/auth/refresh.ts")).toBe("src")
    expect(moduleRoot("lobodamar-server/routes.ts")).toBe("lobodamar-server")
    expect(moduleRoot(undefined)).toBe("")
  })

  test("a delegation tool resets accumulated signals", () => {
    // given a sweep interrupted by a task delegation
    const events = [
      ev("grep", T0, "src"),
      ev("read", T0 + 1, "src/a.ts"),
      ev("task", T0 + 2),
    ]

    // when analyzed
    const signal = analyzeGruntSignals(events)

    // then the delegation reset the counts
    expect(signal.gruntCount).toBe(0)
    expect(signal.searchReadSearch).toBe(false)
  })
})

describe("createPreGruntGate (stateful, on the real root tool path)", () => {
  test("allows non-grunt root exceptions (git status, edit, write, session metadata)", () => {
    const gate = createPreGruntGate()

    const bash = gate.inspect("main", "bash")
    const edit = gate.inspect("main", "edit")
    const list = gate.inspect("main", "session_list")

    expect(bash.block).toBe(false)
    expect(edit.block).toBe(false)
    expect(list.block).toBe(false)
  })

  test("blocks a broad crawl and steers, then a delegation resets the window", () => {
    const gate = createPreGruntGate()

    gate.inspect("main", "grep", { target: "src" })
    gate.inspect("main", "read", { target: "src/a.ts" })
    gate.inspect("main", "read", { target: "src/b.ts" })
    const blocked = gate.inspect("main", "read", { target: "src/c.ts" })

    expect(blocked.block).toBe(true)
    expect(blocked.steering).toContain("explore")
    expect(gate.isSteered("main")).toBe(true)

    const delegated = gate.inspect("main", "task")
    expect(delegated.block).toBe(false)
    expect(delegated.delegated).toBe(true)
    expect(gate.isSteered("main")).toBe(false)

    const next = gate.inspect("main", "read", { target: "src/d.ts" })
    expect(next.block).toBe(false)
  })

  test("allows anonymous single lookup and one anchored verification read", () => {
    const gate = createPreGruntGate()

    expect(gate.inspect("main", "grep", { target: "src/foo" }).block).toBe(false)
    expect(gate.inspect("main", "read", { target: "src/foo.ts", selective: true }).selectiveVerification).toBe(true)
    expect(gate.inspect("main", "read", { target: "src/foo.ts", selective: true }).block).toBe(false)
  })
})
