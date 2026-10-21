import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDelegationFirstRuntime, type RelaunchOutcome } from "./runtime"
import { REASON_BROAD, REASON_WAIT } from "./root-worker-state"
import type { ReplayableAssignment } from "./replay"
import type { GovernanceAuditWriter } from "../../shared/governance-audit"
import type { WorkerCandidate } from "../delegation-ladder"

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

function free(id: string): WorkerCandidate {
  return { model_id: id, tier: "free", capability: 0.7, free: true }
}

function makeAssignment(overrides: Partial<ReplayableAssignment> = {}): ReplayableAssignment {
  return {
    assignment_id: "job1",
    root_session_id: "root",
    parent_session_id: "root",
    parent_message_id: "msg-1",
    prompt: "map the auth flow",
    agent: "explore",
    category: "explore",
    workers: [free("a/free-a"), free("b/free-b")],
    ...overrides,
  }
}

function fakeSink() {
  const cancelled: string[] = []
  const relaunches: Array<{ worker: string }> = []
  const sink = {
    cancel: (sessionID: string) => void cancelled.push(sessionID),
    relaunch: (assignment: ReplayableAssignment, action: { worker: WorkerCandidate }) => {
      relaunches.push({ worker: action.worker.model_id })
      return { kind: "launched", taskID: "bg-new", sessionID: "child2" } as RelaunchOutcome
    },
  }
  return { sink, cancelled, relaunches }
}

const availabilityDirs: string[] = []
function tempAvailabilityFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "runtime-liveness-availability-"))
  availabilityDirs.push(dir)
  return join(dir, "model-availability.json")
}

afterAll(() => {
  for (const dir of availabilityDirs) rmSync(dir, { recursive: true, force: true })
})

describe("delegation-first child liveness", () => {
  test("detach of a running child records unexpected exit plus root failure evidence", () => {
    // given: a child advanced to request_started with a retained assignment and sink
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    const { sink, relaunches } = fakeSink()
    rt.setRecoverySink(sink)
    rt.retainAssignment(makeAssignment(), "child1")
    rt.attachChildSession("root", "child1")
    rt.markRequestStarted("child1")
    // when: the child session is deleted while still running
    rt.detachChildSession("child1")
    // then: unexpected-exit audit plus root failure evidence, with one bounded redispatch
    const names = events.map((e) => String(e.fields.event))
    expect(names).toContain("child_exited_unexpectedly")
    const evidence = rt.recoverySnapshot("root").evidence
    expect(evidence.some((e) => e.id === "child-exited-unexpectedly:child1")).toBe(true)
    expect(evidence.some((e) => e.kind === "child_lost")).toBe(true)
    expect(relaunches.length).toBe(1)
    rt.dispose()
  })

  test("detach of a terminal child records no unexpected exit", () => {
    // given: a child that reached a terminal stage
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    rt.attachChildSession("root", "child1")
    rt.markRequestStarted("child1")
    rt.watchdogTerminal("child1")
    // when: the completed child is detached
    rt.detachChildSession("child1")
    // then: no unexpected-exit audit and no child_lost evidence
    const names = events.map((e) => String(e.fields.event))
    expect(names).not.toContain("child_exited_unexpectedly")
    const evidence = rt.recoverySnapshot("root").evidence
    expect(evidence.some((e) => e.id === "child-exited-unexpectedly:child1")).toBe(false)
    rt.dispose()
  })

  test("preGruntCheck with zero live children steers to dispatch instead of WAIT deadlock", () => {
    // given: a root in worker_active phase with a live child
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    rt.attachChildSession("root", "child1")
    rt.markRequestStarted("child1")
    expect(rt.rootPhase("root")).toBe("worker_active")
    // when: no probe is injected, a broad op blocks with WAIT
    const baseline = rt.preGruntCheck("root", "glob", { target: "src/**" })
    // then: baseline behavior is unchanged (WAIT block)
    expect(baseline.block).toBe(true)
    expect(baseline.reason).toBe(REASON_WAIT)
    // when: the probe reports zero live children and zero background tasks
    rt.setLivenessProbe(() => ({ liveChildren: 0, activeBackgroundTasks: 0 }))
    const steered = rt.preGruntCheck("root", "glob", { target: "src/**" })
    // then: no WAIT deadlock; worker-dispatch steering with vanished-child evidence
    expect(steered.block).toBe(true)
    expect(steered.reason).toBe(REASON_BROAD)
    expect(steered.steering).not.toBeNull()
    const names = events.map((e) => String(e.fields.event))
    expect(names).toContain("root_waiting_on_vanished_child")
    const evidence = rt.recoverySnapshot("root").evidence
    expect(evidence.some((e) => e.id === "root-waiting-on-vanished-child:root")).toBe(true)
    rt.dispose()
  })

  test("noteModelHealthy clears a previously marked-unavailable key", () => {
    // given: a model marked unavailable via the runtime API
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    const { sink } = fakeSink()
    rt.setRecoverySink(sink)
    rt.recordModelUnavailable("child1", "a/free-a", "Model is disabled")
    expect(rt.unavailableModels()).toContain("a/free-a")
    // when: the model proves healthy again
    rt.noteModelHealthy("a/free-a")
    // then: the key is cleared and recovery is audited
    expect(rt.unavailableModels()).not.toContain("a/free-a")
    const names = events.map((e) => String(e.fields.event))
    expect(names).toContain("worker_model_recovered")
    rt.dispose()
  })

  test("detach with explicit completed stage reports no unexpected exit", () => {
    // given: a running child with a retained assignment and relaunch sink
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    rt.setRecoverySink({ cancel: () => {}, relaunch: () => ({ kind: "blocked", reason: "test" }) })
    rt.retainAssignment(makeAssignment(), "child1")
    rt.attachChildSession("root", "child1")
    rt.markRequestStarted("child1")
    // when: the manager detaches with a managed terminal stage
    rt.detachChildSession("child1", "completed")
    // then: no unexpected-exit detection, no failure evidence, no redispatch
    const names = events.map((e) => String(e.fields.event))
    expect(names).not.toContain("child_exited_unexpectedly")
    const evidence = rt.recoverySnapshot("root").evidence
    expect(evidence.some((e) => e.id === "child-exited-unexpectedly:child1")).toBe(false)
    expect(names).not.toContain("worker_retry_planned")
    rt.dispose()
  })

  test("detach with explicit cancelled stage reports no unexpected exit", () => {
    // given: a running child with a retained assignment and relaunch sink
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    rt.setRecoverySink({ cancel: () => {}, relaunch: () => ({ kind: "blocked", reason: "test" }) })
    rt.retainAssignment(makeAssignment(), "child1")
    rt.attachChildSession("root", "child1")
    rt.markRequestStarted("child1")
    // when: the manager detaches with a managed cancel
    rt.detachChildSession("child1", "cancelled")
    // then: no unexpected-exit detection and no failure evidence
    const names = events.map((e) => String(e.fields.event))
    expect(names).not.toContain("child_exited_unexpectedly")
    const evidence = rt.recoverySnapshot("root").evidence
    expect(evidence.some((e) => e.id === "child-exited-unexpectedly:child1")).toBe(false)
    rt.dispose()
  })

  test("first child activity clears the worker model quarantine once", () => {
    // given: model a/free-a quarantined; assignment lineage current_worker is a/free-a
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    rt.retainAssignment(makeAssignment(), "child1")
    rt.attachChildSession("root", "child1")
    rt.recordModelUnavailable("child1", "a/free-a", "Model is disabled")
    expect(rt.unavailableModels()).toContain("a/free-a")
    // when: the child shows activity twice
    rt.watchdogActivity("child1")
    rt.watchdogActivity("child1")
    // then: the quarantine is cleared and recovery audited exactly once
    expect(rt.unavailableModels()).not.toContain("a/free-a")
    const recovered = events.filter((e) => String(e.fields.event) === "worker_model_recovered")
    expect(recovered.length).toBe(1)
    rt.dispose()
  })

  test("liveChildCount counts only still-registered children per parent", () => {
    // given: two children on parent A, one on parent B
    const { writer } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    rt.attachChildSession("parentA", "childA1")
    rt.attachChildSession("parentA", "childA2")
    rt.attachChildSession("parentB", "childB1")
    // when / then
    expect(rt.liveChildCount("parentA")).toBe(2)
    expect(rt.liveChildCount("parentB")).toBe(1)
    // when: one child detaches
    rt.detachChildSession("childA1")
    // then: detached children are not counted; unknown parents count zero
    expect(rt.liveChildCount("parentA")).toBe(1)
    expect(rt.liveChildCount("parentB")).toBe(1)
    expect(rt.liveChildCount("unknown-parent")).toBe(0)
    rt.dispose()
  })
})
