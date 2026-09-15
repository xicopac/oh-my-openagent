import { describe, expect, test } from "bun:test"
import { createDelegationFirstRuntime } from "./runtime"
import type { ReplayableAssignment, RetryLineage } from "./replay"
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

function eventNames(events: CapturedEvent[]): string[] {
  return events.map((e) => String(e.fields.event))
}

function eventsFor(events: CapturedEvent[], sessionID: string): CapturedEvent[] {
  return events.filter((e) => e.sessionID === sessionID)
}

function free(id: string): WorkerCandidate {
  return { model_id: id, tier: "free", capability: 0.7, free: true }
}

function paid(id: string): WorkerCandidate {
  return { model_id: id, tier: "cheap_paid", capability: 1.0, free: false, cost_usd_per_1m_input: 1 }
}

function makeAssignment(overrides: Partial<ReplayableAssignment> = {}): ReplayableAssignment {
  return {
    assignment_id: "job1",
    root_session_id: "root",
    parent_session_id: "root",
    parent_message_id: "msg-1",
    prompt: "find auth middleware and token refresh flow",
    description: "map auth",
    agent: "explore",
    category: "explore",
    workers: [free("openai/free-a"), free("openai/free-b"), paid("openai/paid-c")],
    ...overrides,
  }
}

type SinkHarness = {
  sink: {
    cancel: (sessionID: string, reason: string) => Promise<void>
    relaunch: (assignment: ReplayableAssignment, action: never, prompt: string) => RelaunchOutcome
  }
  cancelled: string[]
  relaunches: Array<{ assignment: ReplayableAssignment; prompt: string; worker: string }>
  setOutcome: (outcome: RelaunchOutcome) => void
}

function fakeSink(): SinkHarness {
  const cancelled: string[] = []
  const relaunches: Array<{ assignment: ReplayableAssignment; prompt: string; worker: string }> = []
  let outcome: RelaunchOutcome = { kind: "launched", taskID: "bg-new", sessionID: "child2" }
  return {
    cancelled,
    relaunches,
    setOutcome(next) {
      outcome = next
    },
    sink: {
      cancel: async (sessionID) => void cancelled.push(sessionID),
      relaunch: (assignment, action, prompt) => {
        relaunches.push({ assignment, prompt, worker: action.worker.model_id })
        return outcome
      },
    },
  }
}

// Advance a child past the provider-response timeout so it classifies as a
// timed-out PROVIDER_RESPONSE_STALL, then reclaim it.
function stallAndReclaim(
  rt: ReturnType<typeof createDelegationFirstRuntime>,
  sessionID: string,
  providerModel: string,
  t0: number,
): void {
  rt.markRequestStarted(sessionID)
  rt.checkAllWatchdogs(t0 + 200_000)
  rt.reclaimStalled(sessionID, providerModel, t0 + 200_000)
}

const TIGHT = { ladder: { max_attempts_per_tier: 1, max_free_attempts_total: 3, escalate_after_attempts: 2 } }

describe("automatic child failover (reclaim -> governed re-dispatch)", () => {
  test("a stalled child is reclaimed and the retry action actually launches a replacement", () => {
    // given
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    const t0 = Date.now()
    rt.retainAssignment(makeAssignment(), "child1")
    rt.attachChildSession("root", "child1")
    // when
    stallAndReclaim(rt, "child1", "openai/free-a", t0)
    // then
    expect(harness.cancelled).toEqual(["child1"])
    expect(harness.relaunches.length).toBe(1)
    expect(harness.relaunches[0].worker).toBe("openai/free-b")
    const names = eventNames(events)
    expect(names).toContain("worker_reclaimed")
    expect(names).toContain("worker_retry_planned")
    expect(names).toContain("worker_retry_dispatched")
    expect(names).toContain("replacement_child_created")
  })

  test("the replacement receives the original bounded assignment", () => {
    // given
    const { writer } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    const assignment = makeAssignment()
    rt.retainAssignment(assignment, "child1")
    rt.attachChildSession("root", "child1")
    // when
    stallAndReclaim(rt, "child1", "openai/free-a", Date.now())
    // then
    expect(harness.relaunches[0].assignment.assignment_id).toBe("job1")
    expect(harness.relaunches[0].assignment.prompt).toBe("find auth middleware and token refresh flow")
    expect(harness.relaunches[0].assignment.parent_session_id).toBe("root")
    expect(harness.relaunches[0].prompt).toContain("find auth middleware")
  })

  test("useful partial findings survive into the replacement prompt", () => {
    // given
    const { writer } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    rt.retainAssignment(makeAssignment(), "child1")
    rt.attachChildSession("root", "child1")
    rt.recordPartialFindings("job1", [
      { type: "anchor", summary: "refresh flow", anchors: ["src/auth/refresh.ts:24:rotateToken"] },
      { type: "unresolved", summary: "where is the token grant?" },
    ])
    // when
    stallAndReclaim(rt, "child1", "openai/free-a", Date.now())
    // then
    expect(harness.relaunches[0].prompt).toContain("refresh flow")
    expect(harness.relaunches[0].prompt).toContain("where is the token grant?")
  })

  test("the old child stays terminal (cancelled), never revived", () => {
    // given
    const { writer } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    rt.retainAssignment(makeAssignment(), "child1")
    rt.attachChildSession("root", "child1")
    stallAndReclaim(rt, "child1", "openai/free-a", Date.now())
    // when / then
    expect(rt.checkWatchdog("child1").health).toBe("TERMINAL")
  })

  test("a replacement session gets fresh watchdog state and its own lineage", () => {
    // given
    const { writer } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    rt.retainAssignment(makeAssignment(), "child1")
    rt.attachChildSession("root", "child1")
    stallAndReclaim(rt, "child1", "openai/free-a", Date.now())
    // when: the replacement session resolves and attaches
    rt.noteReplacementSession("job1", "child2")
    rt.attachChildSession("root", "child2")
    // then
    const lineage = rt.lineage("child2")
    expect(lineage?.attempt_number).toBe(2)
    expect(lineage?.current_worker).toBe("openai/free-b")
    expect(lineage?.previous_workers).toContain("openai/free-a")
    // the replacement has its own fresh watchdog entry, not the old counters
    expect(rt.checkWatchdog("child2").health).not.toBe("TERMINAL")
  })

  test("repeated same-model provider stall switches model/provider", () => {
    // given: the ladder has a second worker at a different model
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    const assignment = makeAssignment({ workers: [free("openai/free-a"), free("anthropic/free-b")] })
    rt.retainAssignment(assignment, "child1")
    rt.attachChildSession("root", "child1")
    // when: a provider-response stall
    rt.markRequestStarted("child1")
    rt.checkAllWatchdogs(Date.now() + 200_000)
    rt.reclaimStalled("child1", "openai/free-a", Date.now() + 200_000)
    // then: it selected the alternate model/provider
    expect(harness.relaunches[0].worker).toBe("anthropic/free-b")
    expect(eventNames(events)).toContain("alternate_worker_selected")
  })

  test("correlated parallel stalls are flagged and do not blind-relaunch the same target", () => {
    // given: three children on the same provider/model
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    const t0 = Date.now()
    for (const [i, sid] of ["c1", "c2", "c3"].entries()) {
      rt.retainAssignment(
        makeAssignment({
          assignment_id: `job${i}`,
          workers: [free("openai/free-a"), free("anthropic/free-b")],
        }),
        sid,
      )
      rt.attachChildSession("root", sid)
    }
    // when: all three reclaim against the same provider/model
    for (const sid of ["c1", "c2", "c3"]) {
      stallAndReclaim(rt, sid, "openai/free-a", t0)
    }
    // then: later reclamations select an alternate target
    const planned = events.filter((e) => e.fields.event === "worker_retry_planned")
    expect(planned.some((e) => e.fields.correlated === true)).toBe(true)
    expect(harness.relaunches.some((r) => r.worker === "anthropic/free-b")).toBe(true)
  })

  test("retry attempt count is bounded and exhausted retries produce a truthful terminal", () => {
    // given: ceiling = max_attempts_per_tier (1) * workers (2) = 2
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(
      writer,
      { ladder: { max_attempts_per_tier: 1, max_free_attempts_total: 2, escalate_after_attempts: 2 } },
    )
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    const t0 = Date.now()
    // attempt 1 (original) stalls -> attempt 2 (replacement)
    rt.retainAssignment(makeAssignment({ workers: [free("openai/free-a"), free("anthropic/free-b")] }), "child1")
    rt.attachChildSession("root", "child1")
    stallAndReclaim(rt, "child1", "openai/free-a", t0)
    expect(harness.relaunches.length).toBe(1)
    // attempt 2 (replacement) stalls -> ceiling exhausted, no 3rd launch
    rt.noteReplacementSession("job1", "child2")
    rt.attachChildSession("root", "child2")
    stallAndReclaim(rt, "child2", "anthropic/free-b", t0)
    // then: no second relaunch, and the chain is exhausted
    expect(harness.relaunches.length).toBe(1)
    const names = eventNames(events)
    expect(names).toContain("retry_chain_exhausted")
  })

  test("an aggregate budget block on the replacement is truthful and does not bypass", () => {
    // given
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    harness.setOutcome({ kind: "blocked", reason: "RESOURCE_BUDGET_EXHAUSTED" })
    rt.setRecoverySink(harness.sink as never)
    rt.retainAssignment(makeAssignment(), "child1")
    rt.attachChildSession("root", "child1")
    // when
    stallAndReclaim(rt, "child1", "openai/free-a", Date.now())
    // then
    expect(harness.relaunches.length).toBe(1)
    const names = eventNames(events)
    expect(names).toContain("replacement_child_blocked")
    expect(names).toContain("retry_chain_exhausted")
    // the old child is still truthfully terminal
    expect(rt.checkWatchdog("child1").health).toBe("TERMINAL")
  })

  test("no root grunt-work takeover occurs; the ladder re-dispatches to a worker", () => {
    // given
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    rt.retainAssignment(makeAssignment(), "child1")
    rt.attachChildSession("root", "child1")
    // when: MAIN does a broad crawl (would be grunt) but the ladder redirects to a worker
    stallAndReclaim(rt, "child1", "openai/free-a", Date.now())
    // then: a worker was relaunched, not a root takeover
    expect(harness.relaunches.length).toBe(1)
    // no root-direct exception was journaled for the reclaim itself
    expect(eventNames(events)).not.toContain("root_direct_exception")
  })

  test("audit events carry lineage metadata but no prompt/output/secrets", () => {
    // given
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    rt.retainAssignment(
      makeAssignment({ prompt: "SECRET PROMPT TEXT", workers: [free("openai/free-a"), free("anthropic/free-b")] }),
      "child1",
    )
    rt.attachChildSession("root", "child1")
    // when
    stallAndReclaim(rt, "child1", "openai/free-a", Date.now())
    // then
    const serialized = JSON.stringify(events)
    expect(serialized).toContain("worker_reclaimed")
    expect(serialized).toContain("assignment_id")
    expect(serialized).not.toContain("SECRET PROMPT TEXT")
  })

  test("no retained assignment yields an exhausted retry, not an ad-hoc root fallback", () => {
    // given: a child with no retained assignment (legacy path)
    const { writer, events } = captureAudit()
    const rt = createDelegationFirstRuntime(writer, TIGHT)
    const harness = fakeSink()
    rt.setRecoverySink(harness.sink as never)
    rt.attachChildSession("root", "child1")
    // when
    stallAndReclaim(rt, "child1", "openai/free-a", Date.now())
    // then: no relaunch (no assignment to replay), exhausted truthfully
    expect(harness.relaunches.length).toBe(0)
    expect(eventNames(events)).toContain("retry_chain_exhausted")
  })
})
