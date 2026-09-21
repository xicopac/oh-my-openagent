import { describe, test, expect } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "../../shared/governance-audit"
import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "./runtime"
import { createRootWorkerState } from "./root-worker-state"
import { buildDelegationWorkerCandidates } from "./free-worker-candidates"
import { selectNextEligibleWorker } from "./availability-failover"
import { classifyOperation, classifyShellCommand } from "../grunt-guard"
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

function readAllJournalLines(root: string): string[] {
  const lines: string[] = []
  for (const sessionDir of readdirSync(root)) {
    for (const entry of readdirSync(join(root, sessionDir))) {
      lines.push(...readFileSync(join(root, sessionDir, entry), "utf8").split("\n").filter((l) => l.length > 0))
    }
  }
  return lines
}

describe("classifier (semantic, not just tool name)", () => {
  test("bash git status / log / rev-parse / pwd are metadata", () => {
    expect(classifyShellCommand("git status")).toBe("metadata")
    expect(classifyShellCommand("git log --oneline -5")).toBe("metadata")
    expect(classifyShellCommand("git rev-parse HEAD")).toBe("metadata")
    expect(classifyShellCommand("pwd")).toBe("metadata")
    expect(classifyShellCommand("ls -la")).toBe("metadata")
  })

  test("bash grep -R / find / rg are discovery", () => {
    expect(classifyShellCommand("grep -R TODO .")).toBe("discovery")
    expect(classifyShellCommand("find . -name '*.ts'")).toBe("discovery")
    expect(classifyShellCommand("rg 'function' src/")).toBe("discovery")
    expect(classifyShellCommand("tree")).toBe("discovery")
  })

  test("bash docker inspect / logs are investigation", () => {
    expect(classifyShellCommand("docker inspect mycontainer")).toBe("investigation")
    expect(classifyShellCommand("docker logs myapp")).toBe("investigation")
    expect(classifyShellCommand("kubectl logs pod-1")).toBe("investigation")
  })

  test("bash multi-file cat is discovery, single-file cat is narrow", () => {
    expect(classifyShellCommand("cat a.ts b.ts c.ts")).toBe("discovery")
    expect(classifyShellCommand("cat src/auth.ts")).toBe("narrow_read")
    expect(classifyShellCommand("sed -n '1,40p' src/auth.ts")).toBe("narrow_read")
  })

  test("bash bun test / build are test_build, sed -i is implementation", () => {
    expect(classifyShellCommand("bun test")).toBe("test_build")
    expect(classifyShellCommand("bun run build")).toBe("test_build")
    expect(classifyShellCommand("tsc --noEmit")).toBe("test_build")
    expect(classifyShellCommand("sed -i 's/a/b/' x.ts")).toBe("implementation")
  })
})

describe("worker-first hard gate (runtime preGruntCheck)", () => {
  function makeRuntime(): { rt: DelegationFirstRuntime; audit: GovernanceAuditWriter; root: string } {
    const root = mkdtempSync(join(tmpdir(), "worker-first-"))
    const audit = createGovernanceAuditWriter({ root })
    // Quarantines go to a temp store inside the audit root (cleaned with it) so
    // recordModelUnavailable never touches the real ~/.omo/model-availability.json.
    const rt = createDelegationFirstRuntime(audit, {
      modelAvailabilityFilePath: join(root, "model-availability.json"),
    })
    return { rt, audit, root }
  }

  function cleanup(r: { rt: DelegationFirstRuntime; root: string }): void {
    r.rt.dispose()
    rmSync(r.root, { recursive: true, force: true })
  }

  test("1. trivial one-file task proceeds without delegation", () => {
    const r = makeRuntime()
    try {
      expect(r.rt.preGruntCheck("m", "read", { target: "src/const.ts" }).block).toBe(false)
      expect(r.rt.preGruntCheck("m", "edit", { target: "src/const.ts" }).block).toBe(false)
      expect(r.rt.rootPhase("m")).toBe("bootstrap")
    } finally {
      cleanup(r)
    }
  })

  test("2. git-status/bootstrap metadata is allowed", () => {
    const r = makeRuntime()
    try {
      expect(r.rt.preGruntCheck("m", "bash", { command: "git status" }).block).toBe(false)
      expect(r.rt.preGruntCheck("m", "bash", { command: "pwd" }).block).toBe(false)
      expect(r.rt.preGruntCheck("m", "bash", { command: "git log --oneline -3" }).block).toBe(false)
      expect(r.rt.preGruntCheck("m", "session_list", {}).block).toBe(false)
    } finally {
      cleanup(r)
    }
  })

  test("3. first small lookup can be allowed", () => {
    const r = makeRuntime()
    try {
      expect(r.rt.preGruntCheck("m", "grep", { target: "src/auth" }).block).toBe(false)
      const v = r.rt.preGruntCheck("m", "read", { target: "src/auth.ts", selective: true })
      expect(v.block).toBe(false)
      expect(v.selectiveVerification).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("4. broad read/search sequence before delegation is blocked", () => {
    const r = makeRuntime()
    try {
      expect(r.rt.preGruntCheck("m", "grep", { target: "src" }).block).toBe(false)
      expect(r.rt.preGruntCheck("m", "read", { target: "src/a.ts" }).block).toBe(false)
      expect(r.rt.preGruntCheck("m", "read", { target: "src/b.ts" }).block).toBe(false)
      const blocked = r.rt.preGruntCheck("m", "read", { target: "src/c.ts" })
      expect(blocked.block).toBe(true)
      expect(blocked.steering).toContain("ROOT_DELEGATION_REQUIRED")
      expect(blocked.steering).toContain("explore")
    } finally {
      cleanup(r)
    }
  })

  test("5. grep/find discovery through Bash is blocked", () => {
    const r = makeRuntime()
    try {
      const grep = r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      expect(grep.block).toBe(true)
      expect(r.rt.preGruntCheck("m", "bash", { command: "find . -name '*.ts'" }).block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("6. cat/sed multi-file exploration is blocked, single-file narrow read allowed", () => {
    const r = makeRuntime()
    try {
      expect(r.rt.preGruntCheck("m", "bash", { command: "cat a.ts b.ts c.ts" }).block).toBe(true)
      const single = makeRuntime()
      try {
        expect(single.rt.preGruntCheck("m", "bash", { command: "cat src/a.ts" }).block).toBe(false)
      } finally {
        cleanup(single)
      }
    } finally {
      cleanup(r)
    }
  })

  test("7. Docker/debug exploration is blocked", () => {
    const r = makeRuntime()
    try {
      expect(r.rt.preGruntCheck("m", "bash", { command: "docker inspect c1" }).block).toBe(true)
      expect(r.rt.preGruntCheck("m", "bash", { command: "docker logs myapp" }).block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("8. merely calling delegation does not unlock root", () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      expect(r.rt.rootPhase("m")).toBe("worker_required")

      const delegated = r.rt.preGruntCheck("m", "task", {})
      expect(delegated.block).toBe(false)
      expect(delegated.delegated).toBe(true)

      // Still locked: no real worker reached request-started.
      expect(r.rt.rootPhase("m")).toBe("worker_required")
      expect(r.rt.preGruntCheck("m", "bash", { command: "find . -name '*.ts'" }).block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("12. worker result enables selective anchor verification", () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.recordWorkerResult("job", adequateResult())
      expect(r.rt.rootPhase("m")).toBe("worker_evidence_available")

      const verify = r.rt.preGruntCheck("m", "read", { target: "src/auth/refresh.ts", selective: true })
      expect(verify.block).toBe(false)
      expect(verify.selectiveVerification).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("13. renewed broad investigation requires another delegation", () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.recordWorkerResult("job", adequateResult())

      const renewed = r.rt.preGruntCheck("m", "bash", { command: "grep -R x ." })
      expect(renewed.block).toBe(true)
      expect(renewed.steering).toContain("ROOT_ADDITIONAL_DELEGATION_REQUIRED")
      expect(r.rt.rootPhase("m")).toBe("worker_required")
    } finally {
      cleanup(r)
    }
  })

  test("18. delegation/control tools never deadlock the root", () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      for (const tool of ["task", "call_omo_agent", "background_output", "background_cancel", "session_read", "session_list", "skill", "question"]) {
        expect(r.rt.preGruntCheck("m", tool, {}).block).toBe(false)
      }
      expect(r.rt.preGruntCheck("m", "bash", { command: "git status" }).block).toBe(false)
    } finally {
      cleanup(r)
    }
  })
})

describe("worker lifecycle (successful dispatch requirement)", () => {
  function makeRuntime(): {
    rt: DelegationFirstRuntime
    audit: GovernanceAuditWriter
    root: string
    availabilityDir: string
  } {
    const root = mkdtempSync(join(tmpdir(), "worker-lifecycle-"))
    // Quarantines live in a separate temp dir so recordModelUnavailable never
    // touches the real ~/.omo/model-availability.json and never pollutes the
    // audit journal root scanned by readEventNames.
    const availabilityDir = mkdtempSync(join(tmpdir(), "worker-lifecycle-availability-"))
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

  test("9. successful child launch (request-started) satisfies the requirement", () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      expect(r.rt.rootPhase("m")).toBe("worker_required")

      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      expect(r.rt.rootPhase("m")).toBe("worker_required")

      r.rt.markRequestStarted("child")
      expect(r.rt.rootPhase("m")).toBe("worker_active")
    } finally {
      cleanup(r)
    }
  })

  test("10. failed child (never reached request-started) does not satisfy it", () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      // child fails/deleted before its provider request ever started
      r.rt.detachChildSession("child")

      expect(r.rt.rootPhase("m")).toBe("worker_required")
      expect(r.rt.preGruntCheck("m", "bash", { command: "find . -name '*.ts'" }).block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("11. automatic replacement child can satisfy it", () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1"), freeWorker("free-2", "free_alt")])
      r.rt.attachChildSession("m", "child-1")
      r.rt.detachChildSession("child-1")

      expect(r.rt.rootPhase("m")).toBe("worker_required")

      r.rt.attachChildSession("m", "child-2")
      r.rt.markRequestStarted("child-2")
      expect(r.rt.rootPhase("m")).toBe("worker_active")

      r.rt.recordWorkerResult("job", adequateResult())
      expect(r.rt.rootPhase("m")).toBe("worker_evidence_available")
    } finally {
      cleanup(r)
    }
  })

  test("14. weak worker result escalates rather than taking over the root", () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "trace auth", [freeWorker("free-1"), paidWorker("cheap-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")

      const first = r.rt.recordWorkerResult("job", weakResult())
      expect(first.kind).toBe("retry_refined")
      expect(r.rt.rootPhase("m")).not.toBe("exceptional_takeover")
      expect(r.rt.preGruntCheck("m", "bash", { command: "grep -R x ." }).block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("15. MAIN-equivalent (expert) child is a valid escalation rung", () => {
    const candidates = buildDelegationWorkerCandidates({
      pricing: { "free/model": { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
      available: new Set(["free/model"]),
      resolvedModelID: null,
      mainModel: "opengateway/gpt-5",
    })
    expect(candidates.some((c) => c.tier === "expert" && c.model_id === "opengateway/gpt-5")).toBe(true)

    const r = makeRuntime()
    try {
      const delegated = r.rt.preGruntCheck("m", "task", { target: "opengateway/gpt-5" })
      expect(delegated.block).toBe(false)
      expect(delegated.delegated).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("16. exhausted / no-eligible worker enters ROOT_REPAIR_MODE (routing failure)", async () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      r.rt.beginDelegation("job", "m", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      // No recovery sink is configured, so a disabled-model failure hard-fails the child.
      r.rt.recordModelUnavailable("child", "free-1", "model disabled")

      // Routing failure: the root enters ROOT_REPAIR_MODE (NOT exceptional takeover)
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      // During repair the root may investigate and fix the routing machinery directly.
      expect(r.rt.preGruntCheck("m", "bash", { command: "find . -name *.ts" }).block).toBe(false)
      // The logical task stays active: repair does not complete/fail the task.
      expect(r.rt.rootRepairReason("m")).toBe("routing_no_relaunch_sink")

      await r.audit.flush()
      expect(readEventNames(r.root)).toContain("retry_chain_exhausted")
      expect(readEventNames(r.root)).toContain("root_repair_mode_entered")
    } finally {
      cleanup(r)
    }
  })

  test("17. give_up enters ROOT_REPAIR_MODE; exceptional takeover is explicit and audited", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "trace auth", [freeWorker("free-1")])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")

      // A single free worker with no stronger rung: bounded retries then give up.
      expect(r.rt.recordWorkerResult("job", weakResult()).kind).toBe("retry_refined")
      const giveUp = r.rt.recordWorkerResult("job", weakResult())
      expect(giveUp.kind).toBe("give_up")

      // Repeated worker failure enters ROOT_REPAIR_MODE first.
      expect(r.rt.rootPhase("m")).toBe("root_repair")
      expect(r.rt.rootRepairReason("m")).toBe("retry_chain_exhausted")
      // During repair the root may perform repository work directly.
      expect(r.rt.preGruntCheck("m", "bash", { command: "grep -R x ." }).block).toBe(false)

      // Exceptional takeover is the explicit final state after repair cannot restore delegation.
      r.rt.enterExceptionalTakeover("m", "repair could not restore delegation")
      expect(r.rt.rootPhase("m")).toBe("exceptional_takeover")
      expect(r.rt.preGruntCheck("m", "bash", { command: "grep -R x ." }).block).toBe(false)

      await r.audit.flush()
      expect(readEventNames(r.root)).toContain("root_repair_mode_entered")
      expect(readEventNames(r.root)).toContain("exceptional_root_takeover")
    } finally {
      cleanup(r)
    }
  })
})

describe("audit observability (zero-token worker-first events)", () => {
  test("worker-first lifecycle events land without prompts or source", async () => {
    const root = mkdtempSync(join(tmpdir(), "worker-audit-"))
    const audit = createGovernanceAuditWriter({ root })
    const rt = createDelegationFirstRuntime(audit)
    try {
      const m = "ses-audit"
      rt.preGruntCheck(m, "read", { target: "src/a.ts" })
      rt.preGruntCheck(m, "bash", { command: "grep -R secret ." })
      rt.beginDelegation("job", m, "find the secret handling", [freeWorker("free-1")])
      rt.attachChildSession(m, "child")
      rt.markRequestStarted("child")
      rt.recordWorkerResult("job", adequateResult(["src/secret.ts:10:encrypt"]))

      await audit.flush()
      const events = readEventNames(root)
      expect(events).toContain("root_bootstrap_allowed")
      expect(events).toContain("root_grunt_blocked")
      expect(events).toContain("root_worker_required")
      expect(events).toContain("worker_requirement_satisfied")
      expect(events).toContain("worker_evidence_available")

      for (const line of readAllJournalLines(root)) {
        expect(line).not.toContain("find the secret handling")
        expect(line).not.toContain("encrypt")
        expect(line).not.toContain("secret handling")
      }
    } finally {
      rt.dispose()
      await audit.flush()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("root-worker-state (pure state machine)", () => {
  test("delegation and control are never blocked across every phase", () => {
    const state = createRootWorkerState()
    const s = "s"
    state.decide(s, "bash", { command: "grep -R x ." })
    expect(state.phase(s)).toBe("worker_required")
    for (const tool of ["task", "call_omo_agent", "background_output", "session_read", "skill"]) {
      expect(state.decide(s, tool, {}).block).toBe(false)
    }
    state.noteWorkerRunning(s)
    expect(state.phase(s)).toBe("worker_active")
    expect(state.decide(s, "background_output", {}).block).toBe(false)
    state.noteEscalationExhausted(s)
    expect(state.phase(s)).toBe("exceptional_takeover")
  })

  test("selectNextEligibleWorker reports no eligible worker rather than falling back to root", () => {
    const workers = [freeWorker("free-1"), paidWorker("cheap-1")]
    expect(selectNextEligibleWorker(workers, 0, new Set(["free-1", "cheap-1"])).kind).toBe("no_eligible_worker")
  })

  test("classifyOperation maps delegation vs broad control deterministically", () => {
    expect(classifyOperation("task", {})).toBe("delegation")
    expect(classifyOperation("call_omo_agent", {})).toBe("delegation")
    expect(classifyOperation("glob", { pattern: "**/*.ts" })).toBe("broad")
    expect(classifyOperation("grep", { pattern: "x" })).toBe("broad")
    expect(classifyOperation("grep", { target: "src" })).toBe("narrow")
    expect(classifyOperation("bash", { command: "git status" })).toBe("metadata")
  })
})
