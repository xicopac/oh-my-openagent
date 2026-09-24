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
  const root = mkdtempSync(join(tmpdir(), "root-recovery-"))
  const availabilityDir = mkdtempSync(join(tmpdir(), "root-recovery-avail-"))
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

describe("DELEGATION RECOVERY LIFECYCLE (evidence-gated, watchdog-controlled)", () => {
  test("1. NORMAL WORKER-FIRST does NOT degrade or enter recovery", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.recordWorkerResult("job", adequateResult())
      expect(r.rt.rootPhase("m")).toBe("worker_evidence_available")
      expect(r.rt.rootPhase("m")).not.toBe("delegation_degraded")
      expect(r.rt.rootPhase("m")).not.toBe("recovery_mode")
      await r.audit.flush()
      expect(readEventNames(r.root)).not.toContain("delegation_failure_recorded")
      expect(readEventNames(r.root)).not.toContain("recovery_probe_started")
    } finally {
      cleanup(r)
    }
  })

  test("2. CHILD STARTUP FAILURE records evidence -> delegation_degraded; unrelated work stays blocked", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "0ms child / EACCES")
      expect(r.rt.rootPhase("m")).toBe("delegation_degraded")
      // one failure is not enough authority: unrelated product work still blocked
      expect(r.rt.preGruntCheck("m", "read", { target: "apps/storefront/cart.ts" }).block).toBe(true)
      expect(r.rt.rootRepairReason("m")).toBe("child_startup_failure")
      await r.audit.flush()
      expect(countEvent(r.root, "delegation_failure_recorded")).toBe(1)
    } finally {
      cleanup(r)
    }
  })

  test("3. SECOND DISTINCT FAILURE enters recovery_mode; recovery-scope work allowed, unrelated blocked", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "0ms child / EACCES")
      r.rt.noteEvidencePipelineBroken("m", "child-2", "worker completed but evidence never advanced")
      expect(r.rt.rootPhase("m")).toBe("recovery_mode")
      // recovery-scope path inspection is permitted
      expect(r.rt.preGruntCheck("m", "read", {
        target: "packages/omo-opencode/src/features/delegation-first/runtime.ts",
      }).block).toBe(false)
      // unrelated product work stays blocked even in recovery_mode
      expect(r.rt.preGruntCheck("m", "edit", { target: "packages/web/src/app/page.tsx" }).block).toBe(true)
      expect(r.rt.preGruntCheck("m", "bash", { command: "npm install react" }).block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("4. WATCHDOG-BLOCKED REPAIR is circular-deadlock evidence, not a dead end", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      // the watchdog would block a repair edit under normal enforcement; the
      // recovery scope recognizes this as a circular deadlock and escalates.
      const decision = r.rt.preGruntCheck("m", "edit", {
        target: "packages/omo-opencode/src/features/delegation-first/runtime.ts",
      })
      expect(decision.block).toBe(false)
      expect(r.rt.rootPhase("m")).toBe("recovery_mode")
      const snapshot = r.rt.recoverySnapshot("m")
      expect(snapshot.evidence.map((item) => item.kind)).toContain("circular_deadlock")
    } finally {
      cleanup(r)
    }
  })

  test("5. RECOVERY PROBE lifecycle: verified -> handoff -> halt; terminal phases block everything", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      r.rt.noteEvidencePipelineBroken("m", "child-2", "evidence never advanced")
      expect(r.rt.rootPhase("m")).toBe("recovery_mode")

      // only one probe can start
      expect(r.rt.beginRecoveryProbe("m", "probe-1", "nonce-1")).toBe(true)
      expect(r.rt.beginRecoveryProbe("m", "probe-2", "nonce-2")).toBe(false)
      // a task call during an active probe is treated as the recovery probe
      expect(r.rt.preGruntCheck("m", "task", {}).block).toBe(false)

      expect(r.rt.markRecoveryVerified("m", "probe-1")).toBe(true)
      expect(r.rt.rootPhase("m")).toBe("recovery_verified")
      expect(r.rt.preGruntCheck("m", "read", {
        target: "packages/omo-opencode/src/features/delegation-first/runtime.ts",
      }).block).toBe(true)

      expect(r.rt.markRecoveryHandoff("m", "/project/.omo/handoffs/recovery.md")).toBe(true)
      expect(r.rt.rootPhase("m")).toBe("handoff")
      r.rt.markRecoveryHalted("m")
      expect(r.rt.rootPhase("m")).toBe("halt")
      expect(r.rt.preGruntCheck("m", "task", { recoveryProbe: true }).block).toBe(true)
      expect(r.rt.recoverySnapshot("m")).toMatchObject({
        verified: true,
        handoffPath: "/project/.omo/handoffs/recovery.md",
      })
    } finally {
      cleanup(r)
    }
  })

  test("6. BOUNDED PROBE FAILURE halts without ever marking recovery verified", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      r.rt.noteEvidencePipelineBroken("m", "child-2", "evidence never advanced")
      expect(r.rt.rootPhase("m")).toBe("recovery_mode")

      r.rt.beginRecoveryProbe("m", "probe-1", "nonce-1")
      expect(r.rt.recordRecoveryProbeFailure("m", "probe-1", "wrong result")).toBe("recovery_mode")
      r.rt.beginRecoveryProbe("m", "probe-2", "nonce-2")
      expect(r.rt.recordRecoveryProbeFailure("m", "probe-2", "still wrong")).toBe("halt")
      expect(r.rt.rootPhase("m")).toBe("halt")
      expect(r.rt.recoverySnapshot("m")).toMatchObject({ verified: false, failureReason: "still wrong" })
    } finally {
      cleanup(r)
    }
  })

  test("7. ROUTING EXHAUSTION / give_up records routing evidence instead of takeover", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      expect(r.rt.recordWorkerResult("job", weakResult()).kind).toBe("retry_refined")
      const giveUp = r.rt.recordWorkerResult("job", weakResult())
      expect(giveUp.kind).toBe("give_up")
      // give_up is machine evidence, not an assertion: degraded, never takeover
      expect(r.rt.rootPhase("m")).toBe("delegation_degraded")
      expect(r.rt.rootRepairReason("m")).toBe("no_sufficient_worker")
      expect(r.rt.preGruntCheck("m", "bash", { command: "grep -R x ." }).block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("8. COST SAFETY: recovery does NOT authorize paid children", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      r.rt.noteEvidencePipelineBroken("m", "child-2", "evidence never advanced")
      expect(r.rt.rootPhase("m")).toBe("recovery_mode")
      const gate1 = r.rt.tryAcquirePaidChild()
      expect(gate1).toBe(true)
      const gate2 = r.rt.tryAcquirePaidChild()
      expect(gate2).toBe(false)
      r.rt.releasePaidChild()
    } finally {
      cleanup(r)
    }
  })

  test("9. NESTED CHILD cannot begin a recovery probe", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child-session")
      expect(r.rt.isChildSession("child-session")).toBe(true)
      expect(r.rt.beginRecoveryProbe("child-session", "probe-fake", "nonce")).toBe(false)
      // the true root/master session controls probe entry
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      r.rt.noteEvidencePipelineBroken("m", "child-2", "evidence never advanced")
      expect(r.rt.rootPhase("m")).toBe("recovery_mode")
      expect(r.rt.beginRecoveryProbe("m", "probe-1", "nonce-1")).toBe(true)
      await r.audit.flush()
      expect(readEventNames(r.root)).toContain("nested_child_probe_rejected")
    } finally {
      cleanup(r)
    }
  })

  test("10. AUDIT EVENTS emitted for the recovery lifecycle", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      r.rt.noteEvidencePipelineBroken("m", "child-2", "evidence never advanced")
      r.rt.beginRecoveryProbe("m", "probe-1", "nonce-1")
      r.rt.markRecoveryVerified("m", "probe-1")
      r.rt.markRecoveryHandoff("m", "/project/.omo/handoffs/recovery.md")
      r.rt.markRecoveryHalted("m")
      await r.audit.flush()
      const events = readEventNames(r.root)
      expect(events).toContain("delegation_failure_recorded")
      expect(events).toContain("recovery_probe_started")
      expect(events).toContain("recovery_verified")
      expect(events).toContain("recovery_handoff")
      expect(events).toContain("recovery_halted")
      expect(countEvent(r.root, "delegation_failure_recorded")).toBe(2)
    } finally {
      cleanup(r)
    }
  })
})