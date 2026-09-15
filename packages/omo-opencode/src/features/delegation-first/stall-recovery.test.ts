import { describe, expect, test } from "bun:test"
import { createDelegationFirstRuntime } from "./runtime"
import type { GovernanceAuditWriter } from "../../shared/governance-audit"

type CapturedEvent = { sessionID: string; fields: Record<string, unknown> }

function captureAudit(): { writer: GovernanceAuditWriter; events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  const writer: GovernanceAuditWriter = {
    write: (sessionID, fields) => events.push({ sessionID, fields }),
    path: () => "/dev/null",
    flush: async () => {},
  }
  return { writer, events }
}

function eventNames(events: CapturedEvent[], sessionID: string): string[] {
  return events.filter((e) => e.sessionID === sessionID).map((e) => String(e.fields.event))
}

const DUMMY_WORKERS = [{ model_id: "opengateway/explore", tier: "free" as const, capability: 0.7, free: true }]

describe("delegation-first child stall lifecycle and recovery", () => {
  test("healthy child lifecycle reaches completion with the expected milestone sequence", () => {
    // given
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, {})
    // when
    rt.beginDelegation("job1", "parent", "prompt", DUMMY_WORKERS)
    rt.attachChildSession("parent", "child1")
    rt.markRequestStarted("child1")
    rt.watchdogActivity("child1")
    rt.watchdogActivity("child1")
    rt.watchdogTerminal("child1")
    // then
    const names = eventNames(events, "child1")
    expect(names).toContain("child_session_created")
    expect(names).toContain("child_model_request_started")
    expect(names).toContain("child_first_provider_response")
    expect(names).toContain("child_first_progress")
    expect(names).toContain("child_completed")
  })

  test("a zero-progress explore worker is reclaimed as PROVIDER_RESPONSE_STALL within the timeout", () => {
    // given
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, {})
    const cancelled: string[] = []
    rt.setRecoverySink({ cancel: async (sessionID) => void cancelled.push(sessionID) })
    const t0 = Date.now()
    rt.attachChildSession("parent", "child1")
    rt.markRequestStarted("child1")
    // when: the provider never responds for past the response timeout
    const results = rt.checkAllWatchdogs(t0 + 200_000)
    const child = results.find((r) => r.sessionID === "child1")
    // then
    expect(child?.result.stallMode).toBe("PROVIDER_RESPONSE_STALL")
    expect(child?.result.timedOut).toBe(true)
    // when: the sweep reclaims it
    rt.reclaimStalled("child1", "opengateway/explore", t0 + 200_000)
    // then
    expect(cancelled).toEqual(["child1"])
    const childNames = eventNames(events, "child1")
    expect(childNames).toContain("watchdog_reclaimed")
    expect(childNames).toContain("worker_retry_started")
    expect(childNames).toContain("child_cancelled")
    // then: the reclaimed child is truthfully terminal, not running
    expect(rt.checkWatchdog("child1").health).toBe("TERMINAL")
  })

  test("request-never-started is classified as PROVIDER_START_STALL", () => {
    // given
    const { writer } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, {})
    const t0 = Date.now()
    rt.attachChildSession("parent", "child1")
    // when: no markRequestStarted, and time passes past the start timeout
    const results = rt.checkAllWatchdogs(t0 + 60_000)
    // then
    const child = results.find((r) => r.sessionID === "child1")
    expect(child?.result.stallMode).toBe("PROVIDER_START_STALL")
    expect(child?.result.timedOut).toBe(true)
  })

  test("three parallel children stalling at the same provider stage mark retries as alternate_worker (correlated)", () => {
    // given
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, {})
    rt.setRecoverySink({ cancel: async () => {} })
    const t0 = Date.now()
    for (const id of ["c1", "c2", "c3"]) {
      rt.attachChildSession("parent", id)
      rt.markRequestStarted(id)
    }
    rt.checkAllWatchdogs(t0 + 200_000)
    // when: all three are reclaimed against the same provider/model
    rt.reclaimStalled("c1", "opengateway/explore", t0 + 200_000)
    rt.reclaimStalled("c2", "opengateway/explore", t0 + 200_000)
    rt.reclaimStalled("c3", "opengateway/explore", t0 + 200_000)
    // then: the later reclamations are flagged correlated (alternate worker)
    const retries = events
      .filter((e) => e.fields.event === "worker_retry_started")
      .map((e) => e.fields.alternate_worker)
    expect(retries).toContain(true)
  })

  test("audit events carry lifecycle metadata but no child content", () => {
    // given
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, {})
    rt.beginDelegation("job1", "parent", "SECRET PROMPT", DUMMY_WORKERS)
    rt.attachChildSession("parent", "child1")
    rt.markRequestStarted("child1")
    rt.watchdogActivity("child1")
    // when
    const serialized = JSON.stringify(events)
    // then
    expect(serialized).toContain("child_session_created")
    expect(serialized).toContain("session_id")
    expect(serialized).not.toContain("SECRET PROMPT")
  })
})
