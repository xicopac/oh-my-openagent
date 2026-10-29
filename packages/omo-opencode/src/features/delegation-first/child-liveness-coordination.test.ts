import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "./runtime"
import { REASON_WAIT } from "./root-worker-state"
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

const availabilityDirs: string[] = []
function tempAvailabilityFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "child-liveness-coordination-"))
  availabilityDirs.push(dir)
  return join(dir, "model-availability.json")
}

afterAll(() => {
  for (const dir of availabilityDirs) rmSync(dir, { recursive: true, force: true })
})

function eventNames(events: CapturedEvent[], event: string): CapturedEvent[] {
  return events.filter((e) => String(e.fields.event) === event)
}

function makeRuntime(audit?: GovernanceAuditWriter): DelegationFirstRuntime {
  return createDelegationFirstRuntime(audit, { modelAvailabilityFilePath: tempAvailabilityFile() })
}

describe("root latch clear", () => {
  test("a killed child with no session event clears the root latch bounded by the sweep deadlines", () => {
    // given: a root in worker_active with one live child and no session events after attach
    const { writer } = captureAudit()
    const rt = makeRuntime(writer)
    const cancelled: string[] = []
    rt.setRecoverySink({ cancel: async (sessionID) => void cancelled.push(sessionID) })
    const t0 = Date.now()
    rt.attachChildSession("root", "child1")
    rt.markRequestStarted("child1")
    expect(rt.rootPhase("root")).toBe("worker_active")

    // when: time passes past the watchdog deadlines and the sweep reclaims the child
    rt.checkAllWatchdogs(t0 + 1_000_000)
    rt.reclaimStalled("child1", "opengateway/explore", t0 + 1_000_000)

    // then: the root latch is cleared and broad work no longer returns WAIT
    expect(cancelled).toEqual(["child1"])
    expect(rt.rootPhase("root")).not.toBe("worker_active")
    const broad = rt.preGruntCheck("root", "glob", { target: "**/*.ts" })
    expect(broad.reason).not.toBe(REASON_WAIT)
    rt.dispose()
  })

  test("a completed child detach moves the root to evidence-available", () => {
    const rt = makeRuntime()
    rt.attachChildSession("root", "child1")
    rt.markRequestStarted("child1")
    rt.watchdogTerminal("child1")
    rt.detachChildSession("child1", "completed")
    expect(rt.rootPhase("root")).toBe("worker_evidence_available")
    // renewed broad work re-delegates rather than deadlocking
    const renewed = rt.preGruntCheck("root", "bash", { command: "grep -R x ." })
    expect(renewed.block).toBe(true)
    rt.dispose()
  })

  test("a cancelled/failed child detach parks the root at worker_required (can delegate again)", () => {
    const rt = makeRuntime()
    rt.attachChildSession("root", "c1")
    rt.markRequestStarted("c1")
    rt.detachChildSession("c1", "cancelled")
    expect(rt.rootPhase("root")).toBe("worker_required")
    expect(rt.preGruntCheck("root", "task", {}).block).toBe(false)
    rt.dispose()
  })

  test("a crashed child (session deleted while running) records evidence and clears the latch", () => {
    const rt = makeRuntime()
    rt.attachChildSession("root", "c1")
    rt.markRequestStarted("c1")
    // no terminal stage: the session vanished while running
    rt.detachChildSession("c1")
    expect(rt.rootPhase("root")).not.toBe("worker_active")
    const evidence = rt.recoverySnapshot("root").evidence
    expect(evidence.some((e) => e.id === "child-exited-unexpectedly:c1")).toBe(true)
    rt.dispose()
  })
})

describe("watchdog telemetry attribution", () => {
  test("a child milestone names the child as worker and the root as parent", () => {
    // given: a root with one attached child and a captured governance journal
    const { writer, events } = captureAudit()
    const rt = makeRuntime(writer)
    rt.attachChildSession("root", "child1")
    rt.markRequestStarted("child1")

    // when: the provider responds and the child produces meaningful progress
    rt.watchdogActivity("child1", "provider_response")
    rt.watchdogActivity("child1", "progress")
    rt.watchdogActivity("child1", "progress")
    const checked = rt.checkWatchdog("child1", Date.now() + 1)

    // then: every milestone is filed under the child session and identifies the
    // child as the worker, never the root (the root is the parent session)
    expect(checked.health).toBe("HEALTHY")
    const milestones = [
      eventNames(events, "child_session_created")[0],
      eventNames(events, "child_first_provider_response")[0],
      eventNames(events, "child_first_progress")[0],
      eventNames(events, "watchdog_progress")[0],
    ]
    for (const milestone of milestones) {
      expect(milestone?.sessionID).toBe("child1")
      expect(milestone?.fields.worker_id).toBe("child1")
      expect(milestone?.fields.parent_session_id).toBe("root")
    }
    rt.dispose()
  })
})

describe("terminal notification + single-cancel coordination", () => {
  test("terminal BLOCKED is surfaced to the parent exactly once (no repeated wakes)", () => {
    const { writer, events } = captureAudit()
    const rt = makeRuntime(writer)
    rt.attachChildSession("root", "c1")
    rt.markRequestStarted("c1")

    // when: the child is cancelled and its session-deleted event arrives twice
    rt.detachChildSession("c1", "cancelled")
    rt.detachChildSession("c1", "cancelled")

    // then: exactly one terminal BLOCKED notification for the child
    const blocked = eventNames(events, "worker_liveness_blocked")
    expect(blocked.length).toBe(1)
    expect(blocked[0]?.fields.wake_reason).toBe("terminal")
    expect(rt.rootPhase("root")).toBe("worker_required")
    rt.dispose()
  })

  test("no double-cancel: watchdog reclaim then child detach cancels the child exactly once", () => {
    const rt = makeRuntime()
    const cancelled: string[] = []
    rt.setRecoverySink({ cancel: async (sessionID) => void cancelled.push(sessionID) })
    rt.attachChildSession("root", "c1")
    rt.markRequestStarted("c1")
    const t0 = Date.now()

    // when: the sweep reclaims the stalled child, then the child session is deleted
    rt.checkAllWatchdogs(t0 + 200_000)
    rt.reclaimStalled("c1", "opengateway/explore", t0 + 200_000)
    expect(cancelled).toEqual(["c1"])
    rt.detachChildSession("c1", "cancelled")

    // then: the child is cancelled exactly once (the liveness supervisor never cancels)
    expect(cancelled).toEqual(["c1"])
    rt.dispose()
  })

  test("the single-cancel arbiter collapses repeated reclaims of the same child", () => {
    const rt = makeRuntime()
    const cancelled: string[] = []
    rt.setRecoverySink({ cancel: async (sessionID) => void cancelled.push(sessionID) })
    rt.attachChildSession("root", "c1")
    rt.markRequestStarted("c1")
    const t0 = Date.now()
    rt.checkAllWatchdogs(t0 + 200_000)

    rt.reclaimStalled("c1", "opengateway/explore", t0 + 200_000)
    rt.reclaimStalled("c1", "opengateway/explore", t0 + 200_000)

    expect(cancelled.length).toBe(1)
    rt.dispose()
  })
})
