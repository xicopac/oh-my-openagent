import { describe, expect, test } from "bun:test"
import type { WatchdogMetadata } from "./level1"
import { classifyStallMode } from "./stall"
import { DEFAULT_STALL_TIMEOUTS } from "./timeouts"
import type { ChildStage } from "./types"

function meta(stage: ChildStage, overrides: Partial<WatchdogMetadata> = {}): WatchdogMetadata {
  return {
    workerID: "w1",
    sessionID: "s1",
    status: "running",
    stage,
    stageAtMs: 0,
    requestStartedAtMs: 0,
    firstResponseAtMs: 0,
    progressCounter: 0,
    previousProgressCounter: 0,
    lastChangeAtMs: 0,
    lastActivityAtMs: 0,
    nowMs: 0,
    hasActiveLongProcess: false,
    longProcessElapsedMs: 0,
    ...overrides,
  }
}

describe("classifyStallMode", () => {
  test("classifies authorized-but-no-session as DISPATCH_STALL", () => {
    // given
    const m = meta("dispatch_authorized", { nowMs: 60_000, stageAtMs: 0 })
    // when
    const r = classifyStallMode(m, DEFAULT_STALL_TIMEOUTS)
    // then
    expect(r.mode).toBe("DISPATCH_STALL")
    expect(r.timedOut).toBe(true)
  })

  test("classifies session-created-but-request-never-started as PROVIDER_START_STALL", () => {
    // given
    const m = meta("session_created", { nowMs: 60_000, stageAtMs: 0 })
    // when
    const r = classifyStallMode(m, DEFAULT_STALL_TIMEOUTS)
    // then
    expect(r.mode).toBe("PROVIDER_START_STALL")
    expect(r.timedOut).toBe(true)
  })

  test("classifies request-started-with-no-response as PROVIDER_RESPONSE_STALL", () => {
    // given
    const m = meta("request_started", {
      requestStartedAtMs: 0,
      firstResponseAtMs: 0,
      nowMs: 200_000,
      stageAtMs: 0,
    })
    // when
    const r = classifyStallMode(m, DEFAULT_STALL_TIMEOUTS)
    // then
    expect(r.mode).toBe("PROVIDER_RESPONSE_STALL")
    expect(r.timedOut).toBe(true)
  })

  test("keeps a response still within the provider deadline (not yet timed out)", () => {
    // given
    const m = meta("request_started", {
      requestStartedAtMs: 0,
      firstResponseAtMs: 0,
      nowMs: 50_000,
      stageAtMs: 0,
    })
    // when
    const r = classifyStallMode(m, DEFAULT_STALL_TIMEOUTS)
    // then
    expect(r.mode).toBe("PROVIDER_RESPONSE_STALL")
    expect(r.timedOut).toBe(false)
  })

  test("classifies provider-responded-but-no-progress as EXECUTION_STALL", () => {
    // given
    const m = meta("first_response", {
      firstResponseAtMs: 0,
      progressCounter: 2,
      lastActivityAtMs: 0,
      nowMs: 200_000,
    })
    // when
    const r = classifyStallMode(m, DEFAULT_STALL_TIMEOUTS)
    // then
    expect(r.mode).toBe("EXECUTION_STALL")
    expect(r.timedOut).toBe(true)
  })

  test("does NOT falsely stall an active long-running process within threshold", () => {
    // given
    const m = meta("first_response", {
      progressCounter: 0,
      hasActiveLongProcess: true,
      longProcessElapsedMs: 100_000,
      nowMs: 1_000_000,
      lastActivityAtMs: 1_000_000,
    })
    // when
    const r = classifyStallMode(m, DEFAULT_STALL_TIMEOUTS)
    // then
    expect(r.mode).toBe("QUIET_BUT_ACTIVE")
    expect(r.timedOut).toBe(false)
  })

  test("classifies a wedged long-running process as TOOL_STALL", () => {
    // given
    const m = meta("first_response", {
      progressCounter: 0,
      hasActiveLongProcess: true,
      longProcessElapsedMs: 400_000,
      nowMs: 1_000_000,
      lastActivityAtMs: 1_000_000,
    })
    // when
    const r = classifyStallMode(m, DEFAULT_STALL_TIMEOUTS)
    // then
    expect(r.mode).toBe("TOOL_STALL")
    expect(r.timedOut).toBe(true)
  })

  test("classifies an idle-but-healthy child as QUIET_BUT_ACTIVE", () => {
    // given
    const m = meta("first_response", {
      progressCounter: 5,
      lastActivityAtMs: 90_000,
      nowMs: 100_000,
    })
    // when
    const r = classifyStallMode(m, DEFAULT_STALL_TIMEOUTS)
    // then
    expect(r.mode).toBe("QUIET_BUT_ACTIVE")
    expect(r.timedOut).toBe(false)
  })
})
