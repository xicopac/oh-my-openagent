import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDelegationFirstRuntime } from "./runtime"
import type { ReplayableAssignment } from "./replay"
import type { RelaunchOutcome } from "./runtime"
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

function makeAssignment(workers: WorkerCandidate[]): ReplayableAssignment {
  return {
    assignment_id: "job1",
    root_session_id: "root",
    parent_session_id: "root",
    parent_message_id: "msg-1",
    prompt: "trace the auth flow",
    agent: "explore",
    category: "explore",
    workers,
  }
}

function fakeSink() {
  const cancelled: string[] = []
  const relaunches: Array<{ worker: string; prompt: string }> = []
  const sink = {
    cancel: async (sessionID: string) => void cancelled.push(sessionID),
    relaunch: (_assignment: ReplayableAssignment, action: { worker: WorkerCandidate }, prompt: string) => {
      relaunches.push({ worker: action.worker.model_id, prompt })
      return { kind: "launched", taskID: "bg-new", sessionID: "child2" } as RelaunchOutcome
    },
  }
  return { sink, cancelled, relaunches }
}

// Point every runtime at its own temp persistent store so quarantines never
// reach the real ~/.omo/model-availability.json during tests.
const availabilityDirs: string[] = []
function tempAvailabilityFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "record-unavailable-availability-"))
  availabilityDirs.push(dir)
  return join(dir, "model-availability.json")
}

afterAll(() => {
  for (const dir of availabilityDirs) rmSync(dir, { recursive: true, force: true })
})

describe("recordModelUnavailable (disabled-model hard-fail + auto-replace)", () => {
  test("marks the model unavailable and re-dispatches the next eligible worker", () => {
    //#given
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    const { sink, relaunches } = fakeSink()
    rt.setRecoverySink(sink)
    rt.retainAssignment(makeAssignment([free("a/free-a"), free("b/free-b")]), "child1")

    //#when
    rt.recordModelUnavailable("child1", "a/free-a", "Model is disabled")

    //#then
    expect(rt.unavailableModels()).toContain("a/free-a")
    expect(relaunches.length).toBe(1)
    expect(relaunches[0].worker).toBe("b/free-b")
    expect(events.map((e) => e.fields.event)).toContain("worker_model_unavailable")
  })

  test("hard-fails (cancel, no relaunch) when no eligible worker remains", () => {
    //#given
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    const { sink, cancelled, relaunches } = fakeSink()
    rt.setRecoverySink(sink)
    rt.retainAssignment(makeAssignment([free("a/free-a")]), "child1")

    //#when
    rt.recordModelUnavailable("child1", "a/free-a", "Model is disabled")

    //#then
    expect(relaunches.length).toBe(0)
    expect(cancelled).toContain("child1")
    expect(events.map((e) => e.fields.event)).toContain("retry_chain_exhausted")
  })

  test("skips any model that is already unavailable when selecting the replacement", () => {
    //#given
    const { writer } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, { modelAvailabilityFilePath: tempAvailabilityFile() })
    const { sink, relaunches } = fakeSink()
    rt.setRecoverySink(sink)
    rt.retainAssignment(makeAssignment([free("a/free-a"), free("b/disabled"), free("c/free-c")]), "child1")

    //#when
    rt.recordModelUnavailable("child2", "b/disabled", "Model is disabled")
    rt.recordModelUnavailable("child1", "a/free-a", "Model is disabled")

    //#then
    const last = relaunches[relaunches.length - 1]
    expect(last.worker).toBe("c/free-c")
  })
})
