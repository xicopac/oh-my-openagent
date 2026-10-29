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
    stage: "first_response",
    stageAtMs: 1_000_000,
    requestStartedAtMs: 1_000_000,
    firstResponseAtMs: 1_000_000,
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

  test("classifies a stalled status as SUSPECTED_STALL", () => {
    // given
    const m = meta({ status: "stalled" })
    // when
    const r = classifyLevel1(m, DEFAULT_WATCHDOG_POLICY)
    // then
    expect(r.health).toBe("SUSPECTED_STALL")
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
  test("registration emits child_session_created then a steady sequence emits only watchdog_progress (coalescing)", () => {
    // given
    const events: WatchdogEventName[] = []
    let now = 1_000_000
    const wd = createWatchdog({}, {
      now: () => now,
      onEvent: (_sessionID, event) => events.push(event),
    })
    wd.register("s1", "w1")
    wd.markRequestStarted("s1")
    // when
    wd.onActivity("s1", "progress")
    const first = wd.check("s1")
    wd.onActivity("s1", "progress")
    const second = wd.check("s1")
    wd.onActivity("s1", "progress")
    const third = wd.check("s1")
    // then
    expect(first.health).toBe("HEALTHY")
    expect(second.health).toBe("HEALTHY")
    expect(third.health).toBe("HEALTHY")
    expect(events).toEqual([
      "child_session_created",
      "child_model_request_started",
      "child_first_provider_response",
      "watchdog_progress",
      "child_first_progress",
    ])
  })

  test("check is a pure synchronous function returning a WatchdogCheckResult", () => {
    // given
    const wd = createWatchdog()
    wd.register("s1", "w1")
    wd.markRequestStarted("s1")
    wd.onActivity("s1", "progress")
    // when
    const result = wd.check("s1")
    // then
    expect(result.health).toBe("HEALTHY")
    expect(result.reason).toBe("advanced")
    expect(result.advanced).toBe(true)
  })

  test("generic activity keeps the child at request_started instead of faking a provider response", () => {
    // given
    const events: WatchdogEventName[] = []
    let now = 1_000_000
    const wd = createWatchdog({}, {
      now: () => now,
      onEvent: (_sessionID, event) => events.push(event),
    })
    wd.register("s1", "w1")
    wd.markRequestStarted("s1")
    // when: startup/user echoes arrive with no provider output
    wd.onActivity("s1")
    wd.onActivity("s1")
    const result = wd.check("s1")
    // then: the child is still waiting for the provider, not reported responsive
    expect(result.stage).toBe("request_started")
    expect(result.stallMode).toBe("PROVIDER_RESPONSE_STALL")
    expect(wd.snapshot("s1")?.firstResponseAtMs).toBe(0)
    expect(events).not.toContain("child_first_provider_response")
    expect(events).not.toContain("child_first_progress")
  })

  test("a genuine provider response advances first_response and later work becomes first_progress", () => {
    // given
    const events: WatchdogEventName[] = []
    let now = 1_000_000
    const wd = createWatchdog({}, {
      now: () => now,
      onEvent: (_sessionID, event) => events.push(event),
    })
    wd.register("s1", "w1")
    wd.markRequestStarted("s1")
    // when: assistant output arrives, then meaningful tool/text progress
    wd.onActivity("s1", "provider_response")
    now += 1
    wd.onActivity("s1", "progress")
    now += 1
    wd.onActivity("s1", "progress")
    // then
    const snapshot = wd.snapshot("s1")
    expect(snapshot?.stage).toBe("first_response")
    expect(snapshot?.firstResponseAtMs).toBe(1_000_000)
    expect(snapshot?.progressCounter).toBe(2)
    expect(events.filter((event) => event === "child_first_provider_response")).toHaveLength(1)
    expect(events.filter((event) => event === "child_first_progress")).toHaveLength(1)
  })

  test("watchdog_progress reports the previous check's counter, not the current one", () => {
    // given: three children have the same progress but are swept through different entry points
    const details: Array<Record<string, unknown>> = []
    const now = 1_000_000
    const wd = createWatchdog({}, {
      now: () => now,
      onEvent: (_sessionID, event, detail) => {
        if (event === "watchdog_progress") details.push(detail ?? {})
      },
    })
    for (const sessionID of ["s1", "s2", "s3"]) {
      wd.register(sessionID, sessionID)
      wd.markRequestStarted(sessionID)
      wd.onActivity(sessionID, "provider_response")
      wd.onActivity(sessionID, "progress")
      wd.onActivity(sessionID, "progress")
    }
    // when: the periodic sweep and the single-session check both emit a heartbeat
    wd.checkAll()
    wd.check("s3")
    // then
    expect(details).toHaveLength(3)
    for (const detail of details) {
      expect(detail.progress_counter).toBe(2)
      expect(detail.previous_progress_counter).toBe(0)
    }
  })

  test("emits milestone + stall + recovery events across a stall and recovery", () => {
    // given
    const events: WatchdogEventName[] = []
    let now = 1_000_000
    const wd = createWatchdog({}, {
      now: () => now,
      onEvent: (_sessionID, event) => events.push(event),
    })
    wd.register("s1", "w1")
    wd.markRequestStarted("s1")
    wd.onActivity("s1", "progress")
    wd.check("s1")
    // when: time passes with no activity
    now += 200_000
    wd.check("s1")
    // then: activity resumes
    wd.onActivity("s1", "progress")
    wd.check("s1")
    expect(events).toEqual([
      "child_session_created",
      "child_model_request_started",
      "child_first_provider_response",
      "watchdog_progress",
      "watchdog_stall_suspected",
      "child_first_progress",
      "watchdog_recovered",
    ])
  })

  test("duplicate register is a no-op preserving counters, stage, and creation milestone", () => {
    // given
    const events: WatchdogEventName[] = []
    let now = 1_000_000
    const wd = createWatchdog({}, {
      now: () => now,
      onEvent: (_sessionID, event) => events.push(event),
    })
    wd.register("s1", "w1")
    wd.markRequestStarted("s1")
    wd.onActivity("s1", "progress")
    wd.onActivity("s1", "progress")
    wd.check("s1")
    const before = wd.snapshot("s1")
    const createdBefore = events.filter((e) => e === "child_session_created").length
    // when
    wd.register("s1", "w1")
    const after = wd.snapshot("s1")
    // then
    expect(before).toBeDefined()
    expect(after).toBeDefined()
    expect(after!.progressCounter).toBe(2)
    expect(after!.progressCounter).toBe(before!.progressCounter)
    expect(after!.stage).toBe(before!.stage)
    expect(after!.lastActivityAtMs).toBe(before!.lastActivityAtMs)
    expect(after!.lastChangeAtMs).toBe(before!.lastChangeAtMs)
    expect(createdBefore).toBe(1)
    expect(events.filter((e) => e === "child_session_created").length).toBe(1)
  })

  test("snapshot exposes only counters, stage, and timestamps", () => {
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
      "stage",
      "stageAtMs",
      "requestStartedAtMs",
      "firstResponseAtMs",
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

  test("watchdog.ts imports only local pure modules", async () => {
    // given
    const src = await Bun.file(new URL("./watchdog.ts", import.meta.url)).text()
    // when
    const froms = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1])
    // then
    expect(froms.length).toBeGreaterThan(0)
    for (const from of froms) {
      expect(from).toMatch(/^\.\/(level1|lifecycle|stall|timeouts|types)$/)
    }
  })
})
