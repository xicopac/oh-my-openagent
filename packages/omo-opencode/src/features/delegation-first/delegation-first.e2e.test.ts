import { describe, test, expect } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "../../shared/governance-audit"
import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "./runtime"
import type { AttemptResult, WorkerCandidate } from "../delegation-ladder"

function freeWorker(id: string, tier: WorkerCandidate["tier"] = "free"): WorkerCandidate {
  return { model_id: id, tier, capability: 1, free: true }
}

function paidWorker(id: string): WorkerCandidate {
  return { model_id: id, tier: "cheap_paid", capability: 1, free: false, cost_usd_per_1m_input: 1 }
}

function weakResult(fields: Partial<AttemptResult> = {}): AttemptResult {
  return {
    adequate: false,
    objective: "map auth middleware",
    status: "partial",
    findings: [],
    confidence: 0.3,
    unresolved: ["where is the token refresh path?"],
    ...fields,
  }
}

function adequateResult(fields: Partial<AttemptResult> = {}): AttemptResult {
  return {
    adequate: true,
    objective: "map auth middleware",
    status: "complete",
    findings: [{ type: "anchor", summary: "refresh token flow", anchors: ["src/auth/refresh.ts:24:rotateToken"] }],
    confidence: 0.9,
    unresolved: [],
    ...fields,
  }
}

type GovernanceAuditWriter = ReturnType<typeof createGovernanceAuditWriter>

async function runScenario(
  body: (rt: DelegationFirstRuntime, audit: GovernanceAuditWriter, root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "delegation-first-e2e-"))
  const audit = createGovernanceAuditWriter({ root })
  const rt = createDelegationFirstRuntime(audit)
  try {
    await body(rt, audit, root)
  } finally {
    rt.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

function readJournalLines(root: string): string[] {
  const lines: string[] = []
  for (const sessionDir of readdirSync(root)) {
    const dir = join(root, sessionDir)
    for (const entry of readdirSync(dir)) {
      lines.push(...readFileSync(join(dir, entry), "utf8").split("\n").filter((l) => l.length > 0))
    }
  }
  return lines
}

function eventsOf(lines: string[], jobID?: string): string[] {
  return lines
    .map((l) => JSON.parse(l) as { event?: string; job_id?: string })
    .filter((e) => (jobID ? e.job_id === jobID : true))
    .map((e) => e.event)
    .filter((e): e is string => typeof e === "string")
}

describe("delegation-first mocked E2E (deterministic, no paid call)", () => {
  test("delegates to a free worker, refines a weak first result, verifies anchors, and never pays or crawls", async () => {
    await runScenario(async (rt, audit, root) => {
      const parent = "ses-main"
      const workerSession = "ses-worker-discovery"

      // given: MAIN delegates repo discovery to the cheapest sufficient (free) worker.
      rt.beginDelegation("job-discovery", parent, "find auth middleware and token refresh flow", [
        freeWorker("free-explore"),
        paidWorker("cheap-specialist"),
      ])
      rt.attachChildSession(parent, workerSession)

      // the watchdog polls progress counters only (no output, no transcript).
      rt.watchdogActivity(workerSession)
      expect(rt.checkWatchdog(workerSession, 10_000).health).toBe("HEALTHY")

      // the first result is incomplete -> refine the assignment, not root takeover, not paid.
      const first = rt.recordWorkerResult("job-discovery", weakResult())
      expect(first.kind).toBe("retry_refined")
      if (first.kind === "retry_refined") expect(first.sameWorker.free).toBe(true)

      // the unresolved question is preserved so the retry does not restart from zero.
      expect(rt.findings("job-discovery").some((f) => f.type === "unresolved")).toBe(true)

      // the free worker returns useful anchors -> adequate -> done.
      expect(rt.recordWorkerResult("job-discovery", adequateResult()).kind).toBe("done")

      // MAIN verifies the critical anchor with one selective read: not grunt.
      rt.onToolActivity(parent, "read", 1)
      const selective = rt.onToolActivity(parent, "read", 2)
      expect(selective.grunt).toBe(false)

      // a broad search/read crawl WITHOUT delegation IS flagged as root grunt work.
      let broad = rt.onToolActivity(parent, "grep", 3)
      broad = rt.onToolActivity(parent, "read", 4)
      broad = rt.onToolActivity(parent, "grep", 5)
      broad = rt.onToolActivity(parent, "read", 6)
      broad = rt.onToolActivity(parent, "grep", 7)
      expect(broad.grunt).toBe(true)

      await audit.flush()
      const lines = readJournalLines(root)
      const events = eventsOf(lines)

      // audit captured delegation + supervision, metadata only.
      expect(events).toContain("delegation_first_selected")
      expect(events).toContain("worker_attempt_started")
      expect(events).toContain("worker_attempt_inadequate")
      expect(events).toContain("worker_prompt_refined")
      expect(events).toContain("watchdog_progress")
      expect(events).toContain("root_direct_exception")

      // no paid worker was ever selected in the successful path.
      expect(events).not.toContain("worker_model_escalated")

      // no worker output or prompt text ever reached the journal.
      for (const line of lines) {
        expect(line).not.toContain("find auth middleware")
        expect(line).not.toContain("rotateToken")
        expect(line).not.toContain("where is the token refresh path")
      }
    })
  })

  test("repeatedly inadequate free workers escalate the model, never the root", async () => {
    await runScenario(async (rt, audit, root) => {
      const parent = "ses-main-2"
      const workerSession = "ses-worker-2"

      rt.beginDelegation("job-escalate", parent, "trace the auth fallback chain", [
        freeWorker("free-explore"),
        freeWorker("free-explore-stronger", "free_alt"),
        paidWorker("cheap-specialist"),
      ])
      rt.attachChildSession(parent, workerSession)

      // two inadequate attempts against the free worker.
      expect(rt.recordWorkerResult("job-escalate", weakResult()).kind).toBe("retry_refined")
      const escalate = rt.recordWorkerResult("job-escalate", weakResult())

      // after bounded retries the ladder escalates to the NEXT worker model.
      expect(escalate.kind).toBe("escalate")
      if (escalate.kind === "escalate") {
        expect(escalate.worker.model_id).toBe("free-explore-stronger")
        expect(escalate.reason).toBe("attempt_threshold")
      }

      // findings from both free attempts survive the escalation.
      expect(rt.findings("job-escalate").length).toBeGreaterThan(0)

      // the root still has no direct crawl of its own (the ladder owns the decision).
      expect(rt.onToolActivity(parent, "read", 1).grunt).toBe(false)

      await audit.flush()
      const events = eventsOf(readJournalLines(root), "job-escalate")
      expect(events).toContain("worker_model_escalated")
    })
  })

  test("watchdog checkAll sweeps every registered child without reading output", async () => {
    await runScenario(async (rt, audit, root) => {
      rt.beginDelegation("job-a", "parent", "task a", [freeWorker("free-a")])
      rt.beginDelegation("job-b", "parent", "task b", [freeWorker("free-b")])
      rt.attachChildSession("parent", "child-a")
      rt.attachChildSession("parent", "child-b")

      rt.watchdogActivity("child-a")

      const results = rt.checkAllWatchdogs(10_000)
      expect(results.length).toBe(2)
      const byID = new Map(results.map((r) => [r.sessionID, r.result]))
      expect(byID.get("child-a")?.health).toBe("HEALTHY")
      // child-b saw no activity -> still within startup grace -> STARTING.
      expect(["STARTING", "HEALTHY"] as string[]).toContain(byID.get("child-b")?.health)
    })
  })
})
