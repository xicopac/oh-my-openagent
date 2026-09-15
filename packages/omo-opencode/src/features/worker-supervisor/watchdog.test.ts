import { describe, expect, test } from "bun:test"
import {
  classifyLevel1,
  DEFAULT_WATCHDOG_POLICY,
  isInsecureLevel1,
  type WatchdogMetadata,
} from "./level1"
import { createWatchdog, type WatchdogEventName } from "./watchdog"

function meta(overrides: Partial<WatchdogMetadata> = {}): WatchdogMetadata {
  return {
    workerID: "w1",
    sessionID: "s1",
    status: "running",
    progressCounter: 0,
    previousProgressCounter: 0,
    lastChangeAtMs: 1_000_000,
    lastActivityAtMs: 1_000_000,
    nowMs: 1_000_000,
    hasActiveLongProcess: false,
    longProcessElapsedMs: 0,
    ...overrides,
  }
}

describe("classifyLevel1", () => {
  test("classifies an advancing counter as HEALTHY", () => {
    // given
    const m = meta({ progressCounter: 5, previousProgressCounter: 4 })
    // when
    const r = classifyLevel1(m, DEFAULT_WATCHDOG_POLICY)
    // then
    expect(r.health).toBe("HEALTHY")
    expect(r.advanced).toBe(true)
  })

  test("classifies an unchanged counter with an active long process as QUIET_BUT_ACTIVE", () => {
    // given
    const m = meta({
      progressCounter: 3,
      previousProgressCounter: 3,
      hasActiveLongProcess: true,
      longProcessElapsedMs: 100_000,
    })
    // when
    const r = classifyLevel1(m, DEFAULT_WATCHDOG_POLICY)
    // then
    expect(r.health).toBe("QUIET_BUT_ACTIVE")
    expect(r.advanced).toBe(false)
  })

  test("classifies quiet past the stall threshold as SUSPECTED_STALL", () => {
    // given
    const m = meta({ progressCounter: 3, previousProgressCounter: 3, lastActivityAtMs: 1_000_000 - 200_000 })
    // when
    const r = classifyLevel1(m, DEFAULT_WATCHDOG_POLICY)
    // then
    expect(r.health).toBe("SUSPECTED_STALL")
  })

  test("classifies a terminal status as TERMINAL", () => {
    // given
    const m = meta({ status: "completed" })
    // when
    const r = classifyLevel1(m, DEFAULT_WATCHDOG_POLICY)
    // then
    expect(r.health).toBe("TERMINAL")
  })

  test("classifies a starting status as STARTING", () => {
    // given
    const m = meta({ status: "starting" })
    // when
    const r = classifyLevel1(m, DEFAULT_WATCHDOG_POLICY)
    // then
    expect(r.health).toBe("STARTING")
  })

  test("isInsecureLevel1 is true only for SUSPECTED_STALL", () => {
    expect(isInsecureLevel1("SUSPECTED_STALL")).toBe(true)
    expect(isInsecureLevel1("HEALTHY")).toBe(false)
    expect(isInsecureLevel1("QUIET_BUT_ACTIVE")).toBe(false)
    expect(isInsecureLevel1("STARTING")).toBe(false)
    expect(isInsecureLevel1("TERMINAL")).toBe(false)
  })
})

describe("createWatchdog", () => {
  test("a steady advancing sequence emits only the first watchdog_progress (coalescing)", () => {
    // given
    const events: WatchdogEventName[] = []
    let now = 1_000_000
    const wd = createWatchdog({}, {
      now: () => now,
      onEvent: (_sessionID, event) => events.push(event),
    })
    wd.register("s1", "w1")
    // when
    wd.onActivity("s1")
    const first = wd.check("s1")
    wd.onActivity("s1")
    const second = wd.check("s1")
    wd.onActivity("s1")
    const third = wd.check("s1")
    // then
    expect(first.health).toBe("HEALTHY")
    expect(second.health).toBe("HEALTHY")
    expect(third.health).toBe("HEALTHY")
    expect(events).toEqual(["watchdog_progress"])
  })

  test("check is a pure synchronous function returning a Level1Result", () => {
    // given
    const wd = createWatchdog()
    wd.register("s1", "w1")
    wd.onActivity("s1")
    // when
    const result = wd.check("s1")
    // then
    expect(result.health).toBe("HEALTHY")
    expect(result.reason).toBe("advanced")
    expect(result.advanced).toBe(true)
  })

  test("emits watchdog_stall_suspected then watchdog_recovered on stall and recovery", () => {
    // given
    const events: WatchdogEventName[] = []
    let now = 1_000_000
    const wd = createWatchdog({}, {
      now: () => now,
      onEvent: (_sessionID, event) => events.push(event),
    })
    wd.register("s1", "w1")
    wd.onActivity("s1")
    wd.check("s1")
    // when: time passes with no activity
    now += 200_000
    wd.check("s1")
    // then: activity resumes
    wd.onActivity("s1")
    wd.check("s1")
    expect(events).toEqual(["watchdog_progress", "watchdog_stall_suspected", "watchdog_recovered"])
  })

  test("snapshot exposes only counters and timestamps", () => {
    // given
    const wd = createWatchdog()
    wd.register("s1", "w1")
    wd.onActivity("s1")
    // when
    const snap = wd.snapshot("s1")
    // then
    expect(snap).toBeDefined()
    const expectedKeys = [
      "workerID",
      "sessionID",
      "status",
      "progressCounter",
      "previousProgressCounter",
      "lastChangeAtMs",
      "lastActivityAtMs",
      "nowMs",
      "hasActiveLongProcess",
      "longProcessElapsedMs",
    ]
    expect(Object.keys(snap!).sort()).toEqual([...expectedKeys].sort())
  })

  test("snapshot returns undefined for an unregistered session", () => {
    // given
    const wd = createWatchdog()
    // when
    const snap = wd.snapshot("missing")
    // then
    expect(snap).toBeUndefined()
  })

  test("level1.ts imports nothing but ./types", async () => {
    // given
    const src = await Bun.file(new URL("./level1.ts", import.meta.url)).text()
    // when
    const imports = src.split("\n").filter((line) => line.trimStart().startsWith("import"))
    // then
    expect(imports.length).toBe(1)
    expect(imports[0]).toContain('from "./types"')
  })

  test("watchdog.ts imports only ./level1 and ./types", async () => {
    // given
    const src = await Bun.file(new URL("./watchdog.ts", import.meta.url)).text()
    // when
    const froms = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1])
    // then
    expect(froms.length).toBeGreaterThan(0)
    for (const from of froms) {
      expect(from).toMatch(/^\.\/(level1|types)$/)
    }
  })
})
