/**
 * Deterministic E2E scenarios for evidence-based routing degradation (the
 * `delegation_degraded` path). These drive the REAL DelegationFirstRuntime
 * with a scripted worker ladder and assert on the same structured governance
 * audit events a live OpenCode process would write.
 *
 * Current semantics (no root takeover): after a routing failure the phase is
 * `delegation_degraded` (or `recovery_mode` past the evidence threshold),
 * `rootRepairReason` reports the routing reason, broad root work stays
 * blocked, and `delegation_failure_recorded` is audited. Recovery returns via
 * a fresh delegation reaching request-started (`delegation_healthy`).
 *
 * No external model, no network, no paid call. Candidate order and failure
 * behavior are fully scripted.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter, type GovernanceAuditWriter } from "../packages/omo-opencode/src/shared/governance-audit"
import {
  createDelegationFirstRuntime,
  type DelegationFirstRuntime,
  type ReplayableAssignment,
} from "../packages/omo-opencode/src/features/delegation-first"
import type { AttemptResult, WorkerCandidate } from "../packages/omo-opencode/src/features/delegation-ladder"
import { createPaidWorkerGate } from "../packages/omo-opencode/src/tools/delegate-task/paid-worker-gate"

export type CheckResult = { name: string; passed: boolean; failures: string[] }

function freeWorker(id: string): WorkerCandidate {
  return { model_id: id, tier: "free", capability: 0.7, free: true }
}

function paidWorker(id: string): WorkerCandidate {
  return { model_id: id, tier: "cheap_paid", capability: 0.9, free: false, cost_usd_per_1m_input: 1 }
}

function assignment(id: string, workers: WorkerCandidate[]): ReplayableAssignment {
  return {
    assignment_id: id,
    root_session_id: "root",
    parent_session_id: "root",
    parent_message_id: "msg-1",
    prompt: "inspect repo and report evidence",
    description: "e2e repair",
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

type ScenarioContext = {
  rt: DelegationFirstRuntime
  audit: GovernanceAuditWriter
  auditRoot: string
  availabilityRoot: string
  flush: () => Promise<void>
  dispose: () => void
}

function makeScenario(): ScenarioContext {
  const auditRoot = mkdtempSync(join(tmpdir(), "e2e-repair-audit-"))
  const availabilityRoot = mkdtempSync(join(tmpdir(), "e2e-repair-avail-"))
  const audit = createGovernanceAuditWriter({ root: auditRoot })
  const rt = createDelegationFirstRuntime(audit, {
    modelAvailabilityFilePath: join(availabilityRoot, "model-availability.json"),
  })
  return {
    rt,
    audit,
    auditRoot,
    availabilityRoot,
    flush: () => audit.flush(),
    dispose: () => {
      rt.dispose()
      rmSync(auditRoot, { recursive: true, force: true })
      rmSync(availabilityRoot, { recursive: true, force: true })
    },
  }
}

type Run = {
  ctx: ScenarioContext
  events: AuditEvent[]
  names: string[]
}

async function runScenario(
  body: (ctx: ScenarioContext) => void | Promise<void>,
): Promise<Run> {
  const ctx = makeScenario()
  try {
    await body(ctx)
  } finally {
    await ctx.flush()
  }
  const events = readAuditEvents(ctx.auditRoot)
  ctx.dispose()
  return { ctx, events, names: eventNames(events) }
}

function checkFor(run: Run, name: string): CheckResult {
  return { name, passed: true, failures: [] }
}

export async function runRepairScenarios(): Promise<{ checks: CheckResult[]; traceDirs: string[] }> {
  const checks: CheckResult[] = []
  const traceDirs: string[] = []

  // 1. NORMAL WORKER-FIRST preserved: healthy delegation never enters repair
  {
    const run = await runScenario(async (ctx) => {
      const { rt } = ctx
      rt.beginDelegation("job", "root", "map auth", [freeWorker("free-a")])
      rt.attachChildSession("root", "child")
      rt.markRequestStarted("child")
      rt.recordWorkerResult("job", {
        adequate: true,
        objective: "map auth",
        status: "complete",
        findings: [{ type: "anchor", summary: "auth", anchors: ["src/auth.ts:1:x"] }],
        confidence: 0.9,
        unresolved: [],
      })
    })
    const healthy = !run.names.includes("root_repair_mode_entered")
      && run.names.includes("worker_evidence_available")
    checks.push(
      healthy
        ? { name: "Normal worker-first preserved", passed: true, failures: [] }
        : { name: "Normal worker-first preserved", passed: false, failures: [`events=${run.names.join(",")}`] },
    )
    traceDirs.push(run.ctx.auditRoot)
  }

  // 2. STARTUP FAILURE degrades with routing evidence (no silent drop, no takeover)
  {
    let phase = ""
    let reason: string | null = null
    const run = await runScenario(async (ctx) => {
      const { rt } = ctx
      rt.beginDelegation("job", "root", "map auth", [freeWorker("free-a")])
      rt.attachChildSession("root", "child")
      rt.markRequestStarted("child")
      rt.noteChildStartupFailure("root", "child", "EACCES")
      phase = rt.rootPhase("root")
      reason = rt.rootRepairReason("root")
    })
    const kinds = run.events
      .filter((e) => e.event === "delegation_failure_recorded")
      .map((e) => String(e.kind ?? ""))
    const ok = phase === "delegation_degraded"
      && reason === "child_startup_failure"
      && kinds.includes("child_startup_failure")
      && !run.names.includes("exceptional_root_takeover")
    checks.push(
      ok
        ? { name: "Startup failure degrades with routing evidence", passed: true, failures: [] }
        : { name: "Startup failure degrades with routing evidence", passed: false, failures: [`phase=${phase} reason=${reason} kinds=${kinds.join(",")} events=${run.names.join(",")}`] },
    )
    traceDirs.push(run.ctx.auditRoot)
  }

  // 3. ROOT BROAD WORK STAYS BLOCKED after a routing failure (no break-glass)
  {
    let blockedAll = false
    const run = await runScenario(async (ctx) => {
      const { rt } = ctx
      rt.beginDelegation("job", "root", "map auth", [freeWorker("free-a")])
      rt.attachChildSession("root", "child")
      rt.markRequestStarted("child")
      rt.noteChildStartupFailure("root", "child", "EACCES")
      const read = rt.preGruntCheck("root", "read", { target: "src/a.ts" })
      const bash = rt.preGruntCheck("root", "bash", { command: "grep -R x src/" })
      const edit = rt.preGruntCheck("root", "edit", { target: "src/a.ts" })
      blockedAll = read.block && bash.block && edit.block
    })
    const ok = blockedAll
      && run.names.includes("delegation_failure_recorded")
      && !run.names.includes("exceptional_root_takeover")
    checks.push(
      ok
        ? { name: "Root broad work stays blocked after routing failure", passed: true, failures: [] }
        : { name: "Root broad work stays blocked after routing failure", passed: false, failures: [`blockedAll=${blockedAll} events=${run.names.join(",")}`] },
    )
    traceDirs.push(run.ctx.auditRoot)
  }

  // 4. LOGICAL TASK REMAINS ACTIVE after a routing failure (evidence recorded, no terminal)
  {
    const run = await runScenario(async (ctx) => {
      const { rt } = ctx
      rt.beginDelegation("job", "root", "map auth", [freeWorker("free-a")])
      rt.attachChildSession("root", "child")
      rt.markRequestStarted("child")
      rt.noteChildStartupFailure("root", "child", "EACCES")
    })
    const noTerminal = run.names.includes("delegation_failure_recorded")
      && !run.names.includes("retry_chain_exhausted")
      && !run.names.includes("exceptional_root_takeover")
    checks.push(
      noTerminal
        ? { name: "Logical task remains active", passed: true, failures: [] }
        : { name: "Logical task remains active", passed: false, failures: [`events=${run.names.join(",")}`] },
    )
    traceDirs.push(run.ctx.auditRoot)
  }

  // 5. RECOVERY returns to worker-first (degraded -> fresh delegation -> healthy -> evidence)
  {
    let finalPhase = ""
    const run = await runScenario(async (ctx) => {
      const { rt } = ctx
      rt.beginDelegation("job", "root", "map auth", [freeWorker("free-a")])
      rt.attachChildSession("root", "child")
      rt.markRequestStarted("child")
      rt.noteChildStartupFailure("root", "child", "EACCES")
      // a fresh delegation reaching request-started proves the path works again
      rt.beginDelegation("job2", "root", "map auth (retry)", [freeWorker("free-a")])
      rt.attachChildSession("root", "child2")
      rt.markRequestStarted("child2")
      rt.recordWorkerResult("job2", {
        adequate: true,
        objective: "map auth",
        status: "complete",
        findings: [{ type: "anchor", summary: "auth", anchors: ["src/auth.ts:1:x"] }],
        confidence: 0.9,
        unresolved: [],
      })
      finalPhase = rt.rootPhase("root")
    })
    const ok = run.names.includes("delegation_failure_recorded")
      && run.names.includes("delegation_healthy")
      && run.names.includes("worker_evidence_available")
      && finalPhase === "worker_evidence_available"
      && !run.names.includes("exceptional_root_takeover")
    checks.push(
      ok
        ? { name: "Recovery returns to worker-first", passed: true, failures: [] }
        : { name: "Recovery returns to worker-first", passed: false, failures: [`phase=${finalPhase} events=${run.names.join(",")}`] },
    )
    traceDirs.push(run.ctx.auditRoot)
  }

  // 6. REPEATED ROUTING FAILURES accumulate evidence; root work stays blocked (no takeover)
  {
    let firstKind = ""
    let secondKind = ""
    let phase = ""
    let reason: string | null = null
    let blocked = false
    const run = await runScenario(async (ctx) => {
      const { rt } = ctx
      rt.beginDelegation("job", "root", "trace auth", [freeWorker("free-a")])
      rt.attachChildSession("root", "child")
      rt.markRequestStarted("child")
      // A single free worker with no stronger rung: bounded retries then give up.
      const weak: AttemptResult = {
        adequate: false,
        objective: "trace auth middleware",
        status: "partial",
        findings: [],
        confidence: 0.3,
        unresolved: ["where is the token refresh path?"],
      }
      firstKind = rt.recordWorkerResult("job", weak).kind
      secondKind = rt.recordWorkerResult("job", weak).kind
      phase = rt.rootPhase("root")
      reason = rt.rootRepairReason("root")
      blocked = rt.preGruntCheck("root", "bash", { command: "grep -R x ." }).block
    })
    const ok = firstKind === "retry_refined"
      && secondKind === "give_up"
      && phase === "delegation_degraded"
      && reason === "no_sufficient_worker"
      && blocked
      && run.names.includes("delegation_failure_recorded")
      && !run.names.includes("exceptional_root_takeover")
    checks.push(
      ok
        ? { name: "Repeated routing failures keep root blocked", passed: true, failures: [] }
        : { name: "Repeated routing failures keep root blocked", passed: false, failures: [`first=${firstKind} second=${secondKind} phase=${phase} reason=${reason} blocked=${blocked} events=${run.names.join(",")}`] },
    )
    traceDirs.push(run.ctx.auditRoot)
  }

  // 7. MODEL FAILOVER does not degrade the root (free-A disabled -> free-B works)
  {
    let phase = ""
    const run = await runScenario(async (ctx) => {
      const { rt } = ctx
      const sink = {
        relaunch: () => {
          rt.noteReplacementSession("job", "child-b")
          return { kind: "launched" as const, taskID: "bg-2", sessionID: "child-b" }
        },
        cancel: () => Promise.resolve(),
      }
      rt.setRecoverySink(sink)
      rt.retainAssignment(assignment("job", [freeWorker("free-a"), freeWorker("free-b")]), "child-a")
      rt.attachChildSession("root", "child-a")
      rt.markRequestStarted("child-a")
      rt.recordModelUnavailable("child-a", "free-a", "model disabled")
      // failover path: no degradation, still normal worker-first
      rt.attachChildSession("root", "child-b")
      rt.markRequestStarted("child-b")
      phase = rt.rootPhase("root")
    })
    const ok = !run.names.includes("delegation_failure_recorded")
      && run.names.includes("worker_requirement_satisfied")
      && phase === "worker_active"
    checks.push(
      ok
        ? { name: "Model failover doesn't degrade the root", passed: true, failures: [] }
        : { name: "Model failover doesn't degrade the root", passed: false, failures: [`phase=${phase} events=${run.names.join(",")}`] },
    )
    traceDirs.push(run.ctx.auditRoot)
  }

  // 8. PAID-CHILD BOUNDARY remains intact while degraded (cap 1 holds)
  // (two accumulated routing failures cross the evidence threshold, so the
  // phase is deterministically recovery_mode; the paid cap holds in both)
  {
    let phase = ""
    let capsHold = false
    const run = await runScenario(async (ctx) => {
      const { rt } = ctx
      rt.beginDelegation("job", "root", "map auth", [freeWorker("free-a")])
      rt.attachChildSession("root", "child")
      rt.markRequestStarted("child")
      rt.noteChildStartupFailure("root", "child", "EACCES")
      // degradation does NOT lift the paid concurrency cap
      const a = rt.tryAcquirePaidChild()
      const b = rt.tryAcquirePaidChild()
      rt.releasePaidChild()
      // a further routing failure (no relaunch sink) keeps the cap intact
      rt.recordModelUnavailable("child", "free-a", "model disabled")
      const c = rt.tryAcquirePaidChild()
      const d = rt.tryAcquirePaidChild()
      rt.releasePaidChild()
      capsHold = a && !b && c && !d
      phase = rt.rootPhase("root")
    })
    const ok = capsHold && phase === "recovery_mode"
    checks.push(
      ok
        ? { name: "Paid-child boundary remains intact", passed: true, failures: [] }
        : { name: "Paid-child boundary remains intact", passed: false, failures: [`capsHold=${capsHold} phase=${phase}`] },
    )
    traceDirs.push(run.ctx.auditRoot)
  }

  // 9. AUDIT EVENTS emitted exactly once (no double-fire)
  {
    const run = await runScenario(async (ctx) => {
      const { rt } = ctx
      rt.beginDelegation("job", "root", "map auth", [freeWorker("free-a")])
      rt.attachChildSession("root", "child")
      rt.markRequestStarted("child")
      rt.noteChildStartupFailure("root", "child", "EACCES")
    })
    const startupFailures = run.events.filter(
      (e) => e.event === "delegation_failure_recorded" && String(e.kind ?? "") === "child_startup_failure",
    )
    const once = countNamed(run.events, "delegation_failure_recorded") === 1
      && startupFailures.length === 1
      && !run.names.includes("exceptional_root_takeover")
    checks.push(
      once
        ? { name: "Audit events emitted exactly once", passed: true, failures: [] }
        : { name: "Audit events emitted exactly once", passed: false, failures: [`counts recorded=${countNamed(run.events, "delegation_failure_recorded")} events=${run.names.join(",")}`] },
    )
    traceDirs.push(run.ctx.auditRoot)
  }

  return { checks, traceDirs }
}
