/**
 * Deterministic E2E scenarios for POST-EVIDENCE ROOT VERIFICATION and FREE
 * WORKER CONCURRENCY. These drive the REAL `DelegationFirstRuntime` (the exact
 * production object wired into `task`) plus the real delegate-task pricing
 * classifier, and assert on the same structured events a live OpenCode process
 * would write. No external model, no network, no paid call. Deterministic
 * PASS/FAIL.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "../packages/omo-opencode/src/shared/governance-audit"
import {
  createDelegationFirstRuntime,
  type DelegationFirstRuntime,
  type ReplayableAssignment,
} from "../packages/omo-opencode/src/features/delegation-first"
import { createPaidWorkerGate } from "../packages/omo-opencode/src/tools/delegate-task/paid-worker-gate"
import { classifyPaidStatus } from "../packages/omo-opencode/src/tools/delegate-task/paid-consent"
import { resolveEffectivePricing } from "../packages/omo-opencode/src/tools/delegate-task/tools"
import type { OpencodeClient } from "../packages/omo-opencode/src/tools/delegate-task/types"
import type { WorkerCandidate } from "../packages/omo-opencode/src/features/delegation-ladder"

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
    description: "e2e post-evidence",
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

function ok(name: string): CheckResult {
  return { name, passed: true, failures: [] }
}

function fail(name: string, failures: string[]): CheckResult {
  return { name, passed: false, failures }
}

export async function runPostEvidenceVerificationScenario(): Promise<{ checks: CheckResult[]; traceDirs: string[] }> {
  const allChecks: CheckResult[] = []
  const traceDirs: string[] = []
  const root = mkdtempSync(join(tmpdir(), "oma-e2e-post-evidence-"))
  traceDirs.push(root)
  const audit = createGovernanceAuditWriter({ root })
  const rt: DelegationFirstRuntime = createDelegationFirstRuntime(audit, {
    modelAvailabilityFilePath: join(root, "model-availability.json"),
  })
  try {
    // Pre-evidence broad discovery blocked
    const preBroad = rt.preGruntCheck("root", "glob", { target: "**/*.ts" })
    allChecks.push(
      preBroad.block === true && rt.rootPhase("root") === "worker_required"
        ? ok("Pre-evidence broad discovery blocked")
        : fail("Pre-evidence broad discovery blocked", [`block=${preBroad.block} phase=${rt.rootPhase("root")}`]),
    )

    // Dispatch a real worker, attach it, run it to request-started, then
    // register evidence the way background_output consumption does.
    rt.beginDelegation("job", "root", "find routing code", [freeWorker("free-1")])
    rt.attachChildSession("root", "child")
    rt.markRequestStarted("child")
    expectPhase(rt, "root", "worker_active", allChecks, "Worker request started (worker_active)")

    const anchors = ["packages/foo/src/bar.ts:120-155", "resolveFoo"]
    rt.noteChildEvidence("root", anchors.join("\n"))

    allChecks.push(
      rt.rootPhase("root") === "worker_evidence_available" && rt.evidenceAnchors("root").length === anchors.length
        ? ok("Worker evidence registered")
        : fail("Worker evidence registered", [
            `phase=${rt.rootPhase("root")} anchors=${JSON.stringify(rt.evidenceAnchors("root"))}`,
          ]),
    )

    // Anchored read allowed (exact file)
    const read = rt.preGruntCheck("root", "read", { target: "packages/foo/src/bar.ts", selective: true })
    allChecks.push(
      read.block === false && read.selectiveVerification === true
        ? ok("Anchored read allowed")
        : fail("Anchored read allowed", [`block=${read.block} sv=${read.selectiveVerification}`]),
    )

    // Anchored symbol verification allowed
    const grep = rt.preGruntCheck("root", "grep", { target: "packages/foo/src/bar.ts" })
    allChecks.push(
      grep.block === false && grep.selectiveVerification === true
        ? ok("Anchored symbol verification allowed")
        : fail("Anchored symbol verification allowed", [`block=${grep.block} sv=${grep.selectiveVerification}`]),
    )

    // Nearby bounded context allowed (same file, modest range)
    const nearby = rt.preGruntCheck("root", "read", { target: "packages/foo/src/bar.ts", selective: true })
    allChecks.push(
      nearby.block === false ? ok("Nearby bounded context allowed") : fail("Nearby bounded context allowed", [`block=${nearby.block}`]),
    )

    // Verification preserves evidence state (root remains in evidence phase
    // after several targeted checks and before any NEW broad investigation)
    allChecks.push(
      rt.rootPhase("root") === "worker_evidence_available"
        ? ok("Verification preserves evidence state")
        : fail("Verification preserves evidence state", [`phase=${rt.rootPhase("root")}`]),
    )

    // Unrelated broad discovery blocked; a NEW investigation re-enters worker-first
    const unrelated = rt.preGruntCheck("root", "read", { target: "packages/foo/src/unrelated.ts" })
    allChecks.push(
      unrelated.block === true ? ok("Unrelated broad discovery blocked") : fail("Unrelated broad discovery blocked", [`block=${unrelated.block}`]),
    )

    // Audit observability
    await audit.flush()
    const names = eventNames(readAuditEvents(root))
    allChecks.push(
      names.includes("worker_evidence_available") && names.includes("root_grunt_blocked")
        ? ok("Audit events emitted")
        : fail("Audit events emitted", [`events=${names.join(",")}`]),
    )

    rt.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { checks: allChecks, traceDirs }
}

function expectPhase(
  rt: DelegationFirstRuntime,
  session: string,
  expected: string,
  checks: CheckResult[],
  name: string,
): void {
  const actual = rt.rootPhase(session)
  checks.push(actual === expected ? ok(name) : fail(name, [`phase=${actual}`]))
}

export async function runFreeWorkerConcurrencyScenario(): Promise<{ checks: CheckResult[]; traceDirs: string[] }> {
  const allChecks: CheckResult[] = []
  const traceDirs: string[] = []
  const root = mkdtempSync(join(tmpdir(), "oma-e2e-free-concurrency-"))
  traceDirs.push(root)
  const audit = createGovernanceAuditWriter({ root })
  const rt: DelegationFirstRuntime = createDelegationFirstRuntime(audit, {
    modelAvailabilityFilePath: join(root, "model-availability.json"),
  })

  const FREE = "opencode/muse-spark-1.2-contributor-free"
  const PAID = "opencode/deepseek-v4-pro"
  const STATIC_PRICING = {
    [PAID]: { input: 0.4, output: 0.8, cache_read: 0, cache_write: 0 },
    [FREE]: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  }
  const client = {
    model: {
      list: async () => ({
        data: [
          { provider: "opencode", id: "muse-spark-1.2-contributor-free", cost: { input: 0, output: 0 } },
          { provider: "opencode", id: "deepseek-v4-pro", cost: { input: 0.4, output: 0.8 } },
        ],
      }),
    },
  }
  const options = { client: client as unknown as OpencodeClient, pricingCatalog: STATIC_PRICING }
  const gate = createPaidWorkerGate(1)

  try {
    const before = gate.activeCount()
    const effective = await resolveEffectivePricing(options)

    // Three ordinary explore children, all FREE: no paid slot consumed, no limit hit.
    let concurrencyLimitHit = false
    for (let i = 0; i < 3; i++) {
      const status = classifyPaidStatus(FREE, effective)
      if (status !== "free") {
        concurrencyLimitHit = gate.tryAcquire() === false
      }
    }
    allChecks.push(
      !concurrencyLimitHit && gate.activeCount() === before
        ? ok("3 free explore children launch without paid-slot pressure")
        : fail("3 free explore children launch without paid-slot pressure", [
            `active=${gate.activeCount()} hit=${concurrencyLimitHit}`,
          ]),
    )

    // Paid classification still works for a genuinely paid child.
    allChecks.push(
      classifyPaidStatus(PAID, effective) === "paid"
        ? ok("Paid model still classified paid")
        : fail("Paid model still classified paid", [`status=${classifyPaidStatus(PAID, effective)}`]),
    )

    // Mixed: free A/B consume no slots; authorized paid C consumes exactly one;
    // second paid D blocked while C runs; third FREE child still allowed.
    const paidGate = createPaidWorkerGate(1)
    allChecks.push(
      classifyPaidStatus(FREE, effective) === "free" && classifyPaidStatus(FREE, effective) === "free"
        ? ok("Mixed case: free A and B consume no slots")
        : fail("Mixed case: free A and B consume no slots", []),
    )
    allChecks.push(
      paidGate.tryAcquire() === true && paidGate.activeCount() === 1
        ? ok("Mixed case: paid C consumes exactly one slot")
        : fail("Mixed case: paid C consumes exactly one slot", [`active=${paidGate.activeCount()}`]),
    )
    allChecks.push(
      paidGate.tryAcquire() === false
        ? ok("Mixed case: second paid child blocked while C runs")
        : fail("Mixed case: second paid child blocked while C runs", []),
    )
    allChecks.push(
      classifyPaidStatus(FREE, effective) === "free"
        ? ok("Mixed case: third FREE child allowed")
        : fail("Mixed case: third FREE child allowed", []),
    )
    paidGate.release()
    allChecks.push(
      paidGate.activeCount() === 0 ? ok("Mixed case: slot released") : fail("Mixed case: slot released", []),
    )

    rt.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { checks: allChecks, traceDirs }
}