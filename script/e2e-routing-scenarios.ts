/**
 * Runtime-level E2E scenarios for disabled-model failover. These drive the REAL
 * `DelegationFirstRuntime` (the exact production object wired into `task`) with
 * a scripted, deterministic worker ladder and a governed recovery sink, and
 * assert on the SAME structured events (the governance audit journal) that a
 * live OpenCode process would write. This is the repo's established E2E
 * convention, applied to the disabled-model failover path via
 * `recordModelUnavailable`.
 *
 * No external model, no network, no paid call. Candidate order and model
 * behavior are fully scripted, which is exactly what a product-provider run
 * cannot guarantee.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { createGovernanceAuditWriter, type GovernanceAuditWriter } from "../packages/omo-opencode/src/shared/governance-audit"
import {
  createDelegationFirstRuntime,
  type DelegationFirstConfig,
  type DelegationFirstRuntime,
  type ReplayableAssignment,
} from "../packages/omo-opencode/src/features/delegation-first"
import type { WorkerCandidate } from "../packages/omo-opencode/src/features/delegation-ladder"

export type CheckResult = { name: string; passed: boolean; failures: string[] }

function freeWorker(id: string): WorkerCandidate {
  return { model_id: id, tier: "free", capability: 0.7, free: true }
}

function assignment(id: string, workers: WorkerCandidate[]): ReplayableAssignment {
  return {
    assignment_id: id,
    root_session_id: "root",
    parent_session_id: "root",
    parent_message_id: "msg-1",
    prompt: "inspect repo and report evidence",
    description: "e2e failover",
    agent: "explore",
    category: "explore",
    parent_model: { providerID: "test", modelID: "root" },
    workers,
  }
}

type AuditEvent = Record<string, unknown>

function readAuditEvents(root: string): AuditEvent[] {
  const events: AuditEvent[] = []
  for (const sessionDir of readdirSync(root)) {
    const journal = join(root, sessionDir, "events.jsonl")
    try {
      for (const line of readFileSync(journal, "utf8").split("\n")) {
        if (line.length === 0) continue
        try { events.push(JSON.parse(line)) } catch { /* ignore */ }
      }
    } catch { /* no journal */ }
  }
  return events
}

function eventNames(events: AuditEvent[]): string[] {
  return events.map((e) => String(e.event ?? "")).filter((s) => s.length > 0)
}

function countNamed(events: AuditEvent[], name: string): number {
  return events.filter((e) => e.event === name).length
}

type RelaunchRecord = { taskID: string; sessionID: string; worker: string }
type Sink = {
  relaunches: RelaunchRecord[]
  cancels: string[]
  relaunch: (assignment: ReplayableAssignment, action: { worker: WorkerCandidate }, prompt: string) => { kind: "launched"; taskID: string; sessionID: string }
  cancel: (sessionID: string, reason: string) => Promise<void>
}

function makeSink(): Sink {
  const sink: Sink = {
    relaunches: [],
    cancels: [],
    relaunch: (assignment, action) => {
      const record: RelaunchRecord = {
        taskID: `bg-${sink.relaunches.length + 1}`,
        sessionID: `child-${sink.relaunches.length + 2}`,
        worker: action.worker.model_id,
      }
      sink.relaunches.push(record)
      return { kind: "launched", taskID: record.taskID, sessionID: record.sessionID }
    },
    cancel: async (sessionID) => {
      sink.cancels.push(sessionID)
    },
  }
  return sink
}

type FailoverRun = {
  rt: DelegationFirstRuntime
  sink: Sink
  audit: GovernanceAuditWriter
  auditRoot: string
  /** Persistent availability store backing this runtime (temp by default). */
  availabilityRoot: string
  flush: () => Promise<void>
  dispose: () => void
}

function startRun(workers: WorkerCandidate[], assignmentID = "job", cfg: DelegationFirstConfig = {}): FailoverRun {
  const auditRoot = mkdtempSync(join(tmpdir(), "oma-e2e-rt-"))
  const audit = createGovernanceAuditWriter({ root: auditRoot })
  // Isolate each scenario's quarantine store by default so quarantines never
  // leak between scenarios through the user's real `~/.omo` store; an explicit
  // `modelAvailabilityFilePath` (cross-runtime persistence) still wins.
  const availabilityFile =
    cfg.modelAvailabilityFilePath ?? join(mkdtempSync(join(tmpdir(), "oma-e2e-avail-")), "model-availability.json")
  const rt = createDelegationFirstRuntime(audit, { ...cfg, modelAvailabilityFilePath: availabilityFile })
  const sink = makeSink()
  rt.setRecoverySink({ cancel: sink.cancel, relaunch: sink.relaunch })
  rt.retainAssignment(assignment(assignmentID, workers), "child-1")
  rt.attachChildSession("root", "child-1")
  rt.markRequestStarted("child-1")
  return {
    rt,
    sink,
    audit,
    auditRoot,
    availabilityRoot: dirname(availabilityFile),
    flush: () => audit.flush(),
    dispose: () => {
      void audit.flush()
      rt.dispose()
    },
  }
}

async function snapshot(run: FailoverRun): Promise<AuditEvent[]> {
  await run.flush()
  return readAuditEvents(run.auditRoot)
}

function ok(name: string): CheckResult {
  return { name, passed: true, failures: [] }
}
function fail(name: string, failures: string[]): CheckResult {
  return { name, passed: false, failures }
}

export async function runRuntimeScenarios(): Promise<{ checks: CheckResult[]; traceDirs: string[] }> {
  const allChecks: CheckResult[] = []
  const traceDirs: string[] = []

  // ---- Scenario 2: [disabled, ok] -> quarantine + single replacement ---------
  {
    const run = startRun([freeWorker("test/worker-disabled"), freeWorker("test/worker-ok")])
    traceDirs.push(run.auditRoot)
    traceDirs.push(run.availabilityRoot)

    run.rt.recordModelUnavailable("child-1", "test/worker-disabled", "Model is disabled")
    let events = await snapshot(run)
    const names = eventNames(events)

    allChecks.push(
      names.includes("worker_model_unavailable")
        ? ok("Disabled model quarantine")
        : fail("Disabled model quarantine", [`missing worker_model_unavailable; got ${names.join(",")}`]),
    )
    allChecks.push(
      run.rt.unavailableModels().includes("test/worker-disabled")
        ? ok("Disabled model marked unavailable")
        : fail("Disabled model marked unavailable", ["disabled model not in unavailableModels()"]),
    )
    allChecks.push(
      countNamed(events, "retry_chain_exhausted") === 0
        ? ok("No premature failure notification")
        : fail("No premature failure notification", ["retry_chain_exhausted emitted during failover"]),
    )

    allChecks.push(
      run.sink.relaunches.length === 1 && run.sink.relaunches[0].worker === "test/worker-ok"
        ? ok("Replacement attempt")
        : fail("Replacement attempt", [`relaunches=${run.sink.relaunches.length} worker=${run.sink.relaunches[0]?.worker}`]),
    )
    allChecks.push(
      names.includes("replacement_child_created")
        ? ok("Replacement child created")
        : fail("Replacement child created", ["missing replacement_child_created"]),
    )
    allChecks.push(
      run.rt.lineage("job")?.attempt_number === 2
        ? ok("Lineage advanced to attempt 2")
        : fail("Lineage advanced to attempt 2", [`attempt_number=${run.rt.lineage("job")?.attempt_number}`]),
    )

    run.rt.noteReplacementSession("job", "child-2")
    run.rt.attachChildSession("root", "child-2")
    run.rt.markRequestStarted("child-2")
    run.rt.detachChildSession("child-2")

    events = await snapshot(run)
    allChecks.push(
      countNamed(events, "replacement_child_completed") === 1
        ? ok("Completion exactly once")
        : fail("Completion exactly once", [`replacement_child_completed=${countNamed(events, "replacement_child_completed")}`]),
    )
    allChecks.push(
      run.sink.cancels.length === 0
        ? ok("No cancel on healthy failover")
        : fail("No cancel on healthy failover", [`cancels=${run.sink.cancels.join(",")}`]),
    )
    run.dispose()
  }

  // ---- Scenario 3: [disabled, disabled-2, ok] -> multiple failovers ----------
  {
    const run = startRun([freeWorker("test/worker-disabled"), freeWorker("test/worker-disabled-2"), freeWorker("test/worker-ok")])
    traceDirs.push(run.auditRoot)
    traceDirs.push(run.availabilityRoot)

    run.rt.recordModelUnavailable("child-1", "test/worker-disabled", "Model is disabled")
    let events = await snapshot(run)
    allChecks.push(
      countNamed(events, "retry_chain_exhausted") === 0
        ? ok("Logical task remains RUNNING (after A)")
        : fail("Logical task remains RUNNING (after A)", ["premature retry_chain_exhausted"]),
    )

    run.rt.recordModelUnavailable("child-2", "test/worker-disabled-2", "Model is disabled")
    events = await snapshot(run)
    allChecks.push(
      run.sink.relaunches.length === 2
        ? ok("Two replacements dispatched")
        : fail("Two replacements dispatched", [`relaunches=${run.sink.relaunches.length}`]),
    )
    allChecks.push(
      countNamed(events, "worker_model_unavailable") === 2
        ? ok("Both disabled models quarantined")
        : fail("Both disabled models quarantined", [`worker_model_unavailable=${countNamed(events, "worker_model_unavailable")}`]),
    )
    allChecks.push(
      countNamed(events, "retry_chain_exhausted") === 0
        ? ok("No premature allComplete / failure")
        : fail("No premature allComplete / failure", ["retry_chain_exhausted seen mid-failover"]),
    )

    run.rt.noteReplacementSession("job", "child-3")
    run.rt.attachChildSession("root", "child-3")
    run.rt.markRequestStarted("child-3")
    run.rt.detachChildSession("child-3")
    events = await snapshot(run)
    allChecks.push(
      countNamed(events, "replacement_child_completed") === 1
        ? ok("Completion exactly once (3-candidate)")
        : fail("Completion exactly once (3-candidate)", [`replacement_child_completed=${countNamed(events, "replacement_child_completed")}`]),
    )
    allChecks.push(
      run.rt.lineage("job")?.attempt_number === 3
        ? ok("Lineage advanced to attempt 3")
        : fail("Lineage advanced to attempt 3", [`attempt_number=${run.rt.lineage("job")?.attempt_number}`]),
    )
    run.dispose()
  }

  // ---- Scenario 4: true exhaustion -> single logical failure ----------------
  {
    const run = startRun([freeWorker("test/worker-disabled"), freeWorker("test/worker-disabled-2")])
    traceDirs.push(run.auditRoot)
    traceDirs.push(run.availabilityRoot)

    run.rt.recordModelUnavailable("child-1", "test/worker-disabled", "Model is disabled")
    run.rt.recordModelUnavailable("child-2", "test/worker-disabled-2", "Model is disabled")

    const events = await snapshot(run)
    allChecks.push(
      countNamed(events, "retry_chain_exhausted") === 1
        ? ok("Exhaustion exactly once")
        : fail("Exhaustion exactly once", [`retry_chain_exhausted=${countNamed(events, "retry_chain_exhausted")}`]),
    )
    allChecks.push(
      run.sink.cancels.length === 1
        ? ok("Single truthful cancel at exhaustion")
        : fail("Single truthful cancel at exhaustion", [`cancels=${run.sink.cancels.length}`]),
    )
    allChecks.push(
      countNamed(events, "worker_model_unavailable") === 2
        ? ok("Both disabled models recorded")
        : fail("Both disabled models recorded", [`worker_model_unavailable=${countNamed(events, "worker_model_unavailable")}`]),
    )
    run.dispose()
  }

  // ---- Scenario 5: attempt-level ERROR vs logical state ---------------------
  {
    const run = startRun([freeWorker("test/worker-disabled"), freeWorker("test/worker-ok")])
    traceDirs.push(run.auditRoot)
    traceDirs.push(run.availabilityRoot)

    run.rt.recordModelUnavailable("child-1", "test/worker-disabled", "Model is disabled")

    const lineage = run.rt.lineage("job")
    const events = await snapshot(run)
    const names = eventNames(events)

    allChecks.push(
      names.includes("worker_model_unavailable")
        ? ok("Attempt-level ERROR recorded (disabled model)")
        : fail("Attempt-level ERROR recorded (disabled model)", ["missing worker_model_unavailable"]),
    )
    allChecks.push(
      lineage !== undefined && countNamed(events, "retry_chain_exhausted") === 0
        ? ok("Logical state NOT terminal while candidate remains")
        : fail("Logical state NOT terminal while candidate remains", ["logical assignment terminal/lineage lost during failover"]),
    )
    allChecks.push(
      run.sink.relaunches.length === 1
        ? ok("Attempt failure does not stop the logical assignment")
        : fail("Attempt failure does not stop the logical assignment", [`relaunches=${run.sink.relaunches.length}`]),
    )
    run.dispose()
  }

  return { checks: allChecks, traceDirs }
}

export { startRun, snapshot, readAuditEvents, eventNames, countNamed, makeSink, freeWorker, assignment }
export type { FailoverRun, Sink, RelaunchRecord, AuditEvent }
