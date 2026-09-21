import { describe, test, expect } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "../../shared/governance-audit"
import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "./runtime"
import { createRootWorkerState, type RootWorkerState } from "./root-worker-state"
import type { AttemptResult, WorkerCandidate } from "../delegation-ladder"

type GovernanceAuditWriter = ReturnType<typeof createGovernanceAuditWriter>

function freeWorker(id: string, tier: WorkerCandidate["tier"] = "free"): WorkerCandidate {
  return { model_id: id, tier, capability: 1, free: true }
}

function paidWorker(id: string): WorkerCandidate {
  return { model_id: id, tier: "cheap_paid", capability: 1, free: false, cost_usd_per_1m_input: 1 }
}

function weakResult(): AttemptResult {
  return {
    adequate: false,
    objective: "map auth middleware",
    status: "partial",
    findings: [],
    confidence: 0.3,
    unresolved: ["where is the token refresh path?"],
  }
}

function adequateResult(anchors: string[] = ["src/auth/refresh.ts:24:rotateToken"]): AttemptResult {
  return {
    adequate: true,
    objective: "map auth middleware",
    status: "complete",
    findings: [{ type: "anchor", summary: "refresh token flow", anchors }],
    confidence: 0.9,
    unresolved: [],
  }
}

function readEventNames(root: string): string[] {
  const out: string[] = []
  for (const sessionDir of readdirSync(root)) {
    for (const entry of readdirSync(join(root, sessionDir))) {
      for (const line of readFileSync(join(root, sessionDir, entry), "utf8").split("\n")) {
        if (line.length === 0) continue
        const parsed = JSON.parse(line) as { event?: string }
        if (typeof parsed.event === "string") out.push(parsed.event)
      }
    }
  }
  return out
}

function makeRuntime(): {
  rt: DelegationFirstRuntime
  audit: GovernanceAuditWriter
  root: string
  availabilityDir: string
} {
  const root = mkdtempSync(join(tmpdir(), "root-repair-"))
  const availabilityDir = mkdtempSync(join(tmpdir(), "root-repair-avail-"))
  const audit = createGovernanceAuditWriter({ root })
  const rt = createDelegationFirstRuntime(audit, {
    modelAvailabilityFilePath: join(availabilityDir, "model-availability.json"),
  })
  return { rt, audit, root, availabilityDir }
}

function cleanup(r: { rt: DelegationFirstRuntime; root: string; availabilityDir: string }): void {
  r.rt.dispose()
  rmSync(r.root, { recursive: true, force: true })
  rmSync(r.availabilityDir, { recursive: true, force: true })
}

function countEvent(root: string, name: string): number {
  return readEventNames(root).filter((e) => e === name).length
}

describe("ROOT_REPAIR_MODE + EXCEPTIONAL_ROOT_TAKEOVER (break-glass)", () => {
  test("1. NORMAL WORKER-FIRST does NOT enter repair", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.recordWorkerResult("job", adequateResult())
      expect(r.rt.rootPhase("m")).toBe("worker_evidence_available")
      expect(r.rt.rootPhase("m")).not.toBe("root_repair")
      expect(r.rt.rootPhase("m")).not.toBe("exceptional_takeover")
      await r.audit.flush()
      expect(readEventNames(r.root)).not.toContain("root_repair_mode_entered")
    } finally {
      cleanup(r)
    }
  })

  test("2. CHILD STARTUP FAILURE enters ROOT_REPAIR_MODE; root work allowed; logical task active", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "0ms child / EACCES")
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      // root repo operations allowed during repair (read/grep/bash/edit)
      expect(r.rt.preGruntCheck("m", "read", { target: "src/a.ts" }).block).toBe(false)
      expect(r.rt.preGruntCheck("m", "bash", { command: "grep -R x src/" }).block).toBe(false)
      expect(r.rt.preGruntCheck("m", "edit", { target: "src/a.ts" }).block).toBe(false)
      expect(r.rt.rootRepairReason("m")).toBe("child_startup_failure")
      // no premature complete/failed/allComplete: task stays logically active
      expect(r.rt.rootPhase("m")).not.toBe("exceptional_takeover")
      await r.audit.flush()
      expect(countEvent(r.root, "root_repair_mode_entered")).toBe(1)
    } finally {
      cleanup(r)
    }
  })

  test("3. CHILD 0MS FAILURE enters ROOT_REPAIR_MODE", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.noteChildStartupFailure("m", null, "0ms child before session")
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      expect(r.rt.rootRepairReason("m")).toBe("child_startup_failure")
      expect(r.rt.preGruntCheck("m", "bash", { command: "cat src/const.ts" }).block).toBe(false)
    } finally {
      cleanup(r)
    }
  })

  test("4. PERMISSION FAILURE (EACCES) enters ROOT_REPAIR_MODE and root may inspect permissions", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES: permission denied")
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      // root can inspect/fix permission-related code/config directly
      expect(r.rt.preGruntCheck("m", "read", { target: ".env" }).block).toBe(false)
      expect(r.rt.preGruntCheck("m", "bash", { command: "ls -la" }).block).toBe(false)
    } finally {
      cleanup(r)
    }
  })

  test("5. WORKER STALL beyond watchdog enters ROOT_REPAIR_MODE (no hang)", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      // simulate stall reclaimed without a retained assignment -> repair becomes available
      r.rt.unregisterWorker("child")
      r.rt.enterRootRepair("m", "worker_stall_exhausted")
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      expect(r.rt.preGruntCheck("m", "bash", { command: "grep -R stall src/" }).block).toBe(false)
      await r.audit.flush()
      expect(readEventNames(r.root)).toContain("root_repair_mode_entered")
    } finally {
      cleanup(r)
    }
  })

  test("6. EVIDENCE PIPELINE FAILURE allows root to inspect/fix lifecycle code", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteEvidencePipelineBroken("m", "child", "worker completed but evidence never advanced")
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      expect(r.rt.rootRepairReason("m")).toBe("evidence_pipeline_broken")
      expect(r.rt.preGruntCheck("m", "read", { target: "src/features/delegation-first/runtime.ts" }).block).toBe(false)
    } finally {
      cleanup(r)
    }
  })

  test("7. BROKEN ROUTING (no eligible worker) enters ROOT_REPAIR_MODE", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.recordModelUnavailable("child", "free-1", "model disabled")
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      expect(r.rt.preGruntCheck("m", "bash", { command: "cat src/routing.ts" }).block).toBe(false)
    } finally {
      cleanup(r)
    }
  })

  test("8. ORDINARY MODEL FAILOVER does NOT enter repair (free-A -> free-B)", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1"), freeWorker("free-2", "free_alt")])
      r.rt.attachChildSession("m", "child-1")
      r.rt.markRequestStarted("child-1")
      // free-1 unavailable, auto re-dispatch to free-2 via retained assignment + sink
      const sink = {
        relaunches: [] as string[],
        relaunch: () => {
          r.rt.noteReplacementSession("job", "child-2")
          return { kind: "launched" as const, taskID: "bg-2", sessionID: "child-2" }
        },
        cancel: () => Promise.resolve(),
      }
      r.rt.setRecoverySink(sink)
      r.rt.retainAssignment({
        assignment_id: "job",
        root_session_id: "m",
        parent_session_id: "m",
        parent_message_id: "msg",
        prompt: "map auth",
        description: "map auth",
        agent: "explore",
        category: "explore",
        parent_model: { providerID: "test", modelID: "root" },
        workers: [freeWorker("free-1"), freeWorker("free-2", "free_alt")],
      }, "child-1")
      r.rt.recordModelUnavailable("child-1", "free-1", "model disabled")
      // failover keeps working; no repair
      expect(r.rt.rootPhase("m")).not.toBe("root_repair")
      expect(r.rt.rootPhase("m")).not.toBe("exceptional_takeover")
    } finally {
      cleanup(r)
    }
  })

  test("9. REPAIR SUCCESS: one worker retry succeeds -> exit repair -> worker-first resumes", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      expect(r.rt.rootPhase("m")).toBe("root_repair")

      // root repairs, then ONE delegation retry reaches request-started
      r.rt.beginDelegation("job2", "m", "map auth (retry)", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child-retry")
      r.rt.markRequestStarted("child-retry")
      expect(r.rt.rootPhase("m")).toBe("worker_active")

      r.rt.recordWorkerResult("job2", adequateResult())
      expect(r.rt.rootPhase("m")).toBe("worker_evidence_available")
      await r.audit.flush()
      const events = readEventNames(r.root)
      expect(events).toContain("root_repair_mode_entered")
      expect(events).toContain("delegation_retry_succeeded")
      expect(events).toContain("root_repair_mode_exited")
      expect(events).not.toContain("exceptional_root_takeover")
    } finally {
      cleanup(r)
    }
  })

  test("10. REPAIR FAILURE / TAKEOVER: persistent failure -> exceptional root takeover -> root works", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      expect(r.rt.rootPhase("m")).toBe("root_repair")

      // root attempts repair, but delegation remains unavailable
      r.rt.noteDelegationRetryFailed("m", "still broken")
      expect(r.rt.rootPhase("m")).toBe("root_repair")

      // exceptional takeover: root may complete the original task itself
      r.rt.enterExceptionalTakeover("m", "delegation remains unusable after repair")
      expect(r.rt.rootPhase("m")).toBe("exceptional_takeover")
      expect(r.rt.preGruntCheck("m", "bash", { command: "grep -R x src/" }).block).toBe(false)
      expect(r.rt.preGruntCheck("m", "edit", { target: "src/a.ts" }).block).toBe(false)

      await r.audit.flush()
      const events = readEventNames(r.root)
      expect(events).toContain("root_repair_mode_entered")
      expect(events).toContain("delegation_retry_failed")
      expect(events).toContain("exceptional_root_takeover")
    } finally {
      cleanup(r)
    }
  })

  test("11. TASK STATE: logical task stays active throughout repair (no premature complete/fail)", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      // repair mode does NOT set allComplete / failed / completed on the logical task
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      r.rt.noteDelegationRetryFailed("m", "still broken")
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      r.rt.enterExceptionalTakeover("m", "give up after repair")
      expect(r.rt.rootPhase("m")).toBe("exceptional_takeover")
    } finally {
      cleanup(r)
    }
  })

  test("12. COST SAFETY: repair/takeover does NOT authorize paid children", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      // even at cap=1 with repair active, no paid child is auto-authorized by repair
      const gate1 = r.rt.tryAcquirePaidChild()
      expect(gate1).toBe(true)
      const gate2 = r.rt.tryAcquirePaidChild()
      expect(gate2).toBe(false)
      r.rt.releasePaidChild()
    } finally {
      cleanup(r)
    }
  })

  test("13. NESTED CHILD cannot grant itself root-repair authority", async () => {
    const r = makeRuntime()
    try {
      // register a child session: it is a worker child of the master session
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child-session")
      expect(r.rt.isChildSession("child-session")).toBe(true)

      // a nested child cannot acquire root-repair authority via the runtime
      r.rt.enterRootRepair("child-session", "fake")
      expect(r.rt.rootPhase("child-session")).not.toBe("root_repair")

      // the true root/master session controls repair entry
      r.rt.enterRootRepair("m", "routing_no_eligible_worker")
      expect(r.rt.rootPhase("m")).toBe("root_repair")

      await r.audit.flush()
      expect(readEventNames(r.root)).toContain("nested_child_repair_rejected")
    } finally {
      cleanup(r)
    }
  })

  test("14. AUDIT EVENTS emitted exactly once", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      r.rt.enterExceptionalTakeover("m", "give up")
      await r.audit.flush()
      expect(countEvent(r.root, "root_repair_mode_entered")).toBe(1)
      expect(countEvent(r.root, "exceptional_root_takeover")).toBe(1)
    } finally {
      cleanup(r)
    }
  })
})
