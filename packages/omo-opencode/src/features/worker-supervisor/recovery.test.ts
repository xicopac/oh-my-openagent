import { describe, expect, test } from "bun:test"
import { createRecoveryCoordinator } from "./recovery"

describe("createRecoveryCoordinator", () => {
  test("observes a non-timed-out stall", () => {
    // given
    const c = createRecoveryCoordinator()
    // when
    const d = c.evaluate("s1", "p/m", "PROVIDER_RESPONSE_STALL", false)
    // then
    expect(d.kind).toBe("observe")
  })

  test("observes a QUIET_BUT_ACTIVE mode even when timedOut is true", () => {
    // given
    const c = createRecoveryCoordinator()
    // when
    const d = c.evaluate("s1", "p/m", "QUIET_BUT_ACTIVE", true)
    // then
    expect(d.kind).toBe("observe")
  })

  test("reclaims a timed-out stall with retry enabled", () => {
    // given
    const c = createRecoveryCoordinator()
    // when
    const d = c.evaluate("s1", "p/m", "PROVIDER_RESPONSE_STALL", true)
    // then
    expect(d.kind).toBe("reclaim")
    if (d.kind === "reclaim") {
      expect(d.retry).toBe(true)
      expect(d.correlated).toBe(false)
    }
  })

  test("stops retrying once the same worker reclaim budget is exhausted", () => {
    // given
    const c = createRecoveryCoordinator()
    c.recordReclaim("s1", "p/m")
    // when
    const d = c.evaluate("s1", "p/m", "PROVIDER_RESPONSE_STALL", true)
    // then
    expect(d.kind).toBe("reclaim")
    if (d.kind === "reclaim") {
      expect(d.retry).toBe(false)
    }
  })

  test("detects correlated same-provider/model reclamations within the window", () => {
    // given
    let now = 1_000_000
    const c = createRecoveryCoordinator({}, () => now)
    c.recordReclaim("s1", "opengateway/explore", now)
    c.recordReclaim("s2", "opengateway/explore", now)
    // when: a third identical stall arrives
    const d = c.evaluate("s3", "opengateway/explore", "PROVIDER_RESPONSE_STALL", true, now)
    // then
    expect(d.kind).toBe("reclaim")
    if (d.kind === "reclaim") {
      expect(d.correlated).toBe(true)
    }
  })

  test("does not mark different providers as correlated", () => {
    // given
    let now = 1_000_000
    const c = createRecoveryCoordinator({}, () => now)
    c.recordReclaim("s1", "opengateway/explore", now)
    // when
    const d = c.evaluate("s2", "anthropic/claude-fable", "PROVIDER_RESPONSE_STALL", true, now)
    // then
    expect(d.kind).toBe("reclaim")
    if (d.kind === "reclaim") {
      expect(d.correlated).toBe(false)
    }
  })

  test("reset clears a session's reclaim count", () => {
    // given
    const c = createRecoveryCoordinator()
    c.recordReclaim("s1", "p/m")
    c.reset("s1")
    // when
    const d = c.evaluate("s1", "p/m", "PROVIDER_RESPONSE_STALL", true)
    // then
    expect(d.kind).toBe("reclaim")
    if (d.kind === "reclaim") expect(d.retry).toBe(true)
  })
})
