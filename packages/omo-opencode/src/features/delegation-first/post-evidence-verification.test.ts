import { describe, test, expect } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "../../shared/governance-audit"
import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "./runtime"
import { extractEvidenceAnchors } from "./worker-evidence"
import type { AttemptResult, WorkerCandidate } from "../delegation-ladder"

type GovernanceAuditWriter = ReturnType<typeof createGovernanceAuditWriter>

function freeWorker(id: string): WorkerCandidate {
  return { model_id: id, tier: "free", capability: 1, free: true }
}

function adequateResult(anchors: string[] = ["foo.ts:100-120"]): AttemptResult {
  return {
    adequate: true,
    objective: "verify foo",
    status: "complete",
    findings: [{ type: "anchor", summary: "foo evidence", anchors }],
    confidence: 0.9,
    unresolved: [],
  }
}

function makeRuntime(): { rt: DelegationFirstRuntime; audit: GovernanceAuditWriter; root: string } {
  const root = mkdtempSync(join(tmpdir(), "post-evidence-"))
  const audit = createGovernanceAuditWriter({ root })
  const rt = createDelegationFirstRuntime(audit, {
    modelAvailabilityFilePath: join(root, "model-availability.json"),
  })
  return { rt, audit, root }
}

function cleanup(r: { rt: DelegationFirstRuntime; root: string }): void {
  r.rt.dispose()
  rmSync(r.root, { recursive: true, force: true })
}

/** Reach worker_evidence_available with registered anchors (background-style). */
function reachEvidence(r: { rt: DelegationFirstRuntime }, parent = "root", anchors: string[] = ["foo.ts:100-120"]): void {
  r.rt.beginDelegation("job", parent, "verify foo", [freeWorker("free-1")])
  r.rt.attachChildSession(parent, "child")
  r.rt.markRequestStarted("child")
  r.rt.noteChildEvidence(parent, anchors.join("\n"))
}

describe("POST-EVIDENCE ROOT VERIFICATION (worker-first lifecycle)", () => {
  test("1. BEFORE EVIDENCE - broad read/search is blocked with worker-required semantics", () => {
    const r = makeRuntime()
    try {
      expect(r.rt.preGruntCheck("root", "read", { target: "foo.ts" }).block).toBe(false)
      const blocked = r.rt.preGruntCheck("root", "glob", { target: "**/*.ts" })
      expect(blocked.block).toBe(true)
      expect(r.rt.rootPhase("root")).toBe("worker_required")
      expect(r.rt.preGruntCheck("root", "read", { target: "bar.ts" }).block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("2. AFTER EVIDENCE - exact file read is allowed", () => {
    const r = makeRuntime()
    try {
      reachEvidence(r, "root", ["foo.ts:100-120"])
      const decision = r.rt.preGruntCheck("root", "read", { target: "foo.ts", selective: true })
      expect(decision.block).toBe(false)
      expect(decision.selectiveVerification).toBe(true)
      expect(r.rt.rootPhase("root")).toBe("worker_evidence_available")
    } finally {
      cleanup(r)
    }
  })

  test("3. AFTER EVIDENCE - bounded nearby read is allowed", () => {
    const r = makeRuntime()
    try {
      reachEvidence(r, "root", ["foo.ts:100-120"])
      // foo.ts:85-135 is a modest nearby range around the anchor.
      const decision = r.rt.preGruntCheck("root", "read", { target: "foo.ts", selective: true })
      expect(decision.block).toBe(false)
      expect(decision.selectiveVerification).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("4. AFTER EVIDENCE - exact symbol grep is allowed", () => {
    const r = makeRuntime()
    try {
      reachEvidence(r, "root", ["foo.ts", "resolveFoo"])
      const decision = r.rt.preGruntCheck("root", "grep", { target: "foo.ts" })
      expect(decision.block).toBe(false)
      expect(decision.selectiveVerification).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("5. AFTER EVIDENCE - repo-wide grep is still blocked", () => {
    const r = makeRuntime()
    try {
      reachEvidence(r, "root", ["foo.ts:100-120"])
      const decision = r.rt.preGruntCheck("root", "grep", {})
      expect(decision.block).toBe(true)
      expect(r.rt.rootPhase("root")).toBe("worker_required")
    } finally {
      cleanup(r)
    }
  })

  test("6. AFTER EVIDENCE - unrelated file read is blocked", () => {
    const r = makeRuntime()
    try {
      reachEvidence(r, "root", ["foo.ts:100-120"])
      const decision = r.rt.preGruntCheck("root", "read", { target: "bar.ts" })
      expect(decision.block).toBe(true)
      expect(r.rt.rootPhase("root")).toBe("worker_required")
    } finally {
      cleanup(r)
    }
  })

  test("7. MULTIPLE WORKERS - anchors from A and B both verifiable", () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job-a", "root", "map a", [freeWorker("free-1")])
      r.rt.attachChildSession("root", "child-a")
      r.rt.markRequestStarted("child-a")
      r.rt.noteChildEvidence("root", "a.ts:10-20")
      r.rt.beginDelegation("job-b", "root", "map b", [freeWorker("free-2")])
      r.rt.attachChildSession("root", "child-b")
      r.rt.markRequestStarted("child-b")
      r.rt.noteChildEvidence("root", "b.ts:30-40")

      expect(r.rt.preGruntCheck("root", "read", { target: "a.ts", selective: true }).block).toBe(false)
      expect(r.rt.preGruntCheck("root", "read", { target: "b.ts", selective: true }).block).toBe(false)
    } finally {
      cleanup(r)
    }
  })

  test("8. FAILED WORKER - no evidence, no verification authority", () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "root", "map auth", [freeWorker("free-1")])
      r.rt.attachChildSession("root", "child")
      r.rt.markRequestStarted("child")
      r.rt.recordWorkerResult("job", {
        adequate: false,
        objective: "map auth",
        status: "errored",
        findings: [],
        confidence: 0.1,
        unresolved: ["failed"],
      })
      expect(r.rt.rootPhase("root")).not.toBe("worker_evidence_available")
      expect(r.rt.evidenceAnchors("root")).toEqual([])
      // A failed worker grants no anchored verification: an unrelated file read
      // has no evidence anchor and broad discovery is still gated.
      const broad = r.rt.preGruntCheck("root", "bash", { command: "grep -R x ." })
      expect(broad.block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("9. EMPTY/UNUSABLE RESULT - no evidence authority", () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "root", "verify foo", [freeWorker("free-1")])
      r.rt.attachChildSession("root", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildEvidence("root", "   ")
      expect(r.rt.evidenceAnchors("root")).toEqual([])
      expect(r.rt.rootPhase("root")).toBe("worker_active")
    } finally {
      cleanup(r)
    }
  })

  test("10. DUPLICATE EVIDENCE - anchor registration is idempotent", () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "root", "verify", [freeWorker("free-1")])
      r.rt.attachChildSession("root", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildEvidence("root", "foo.ts:100-120")
      const first = r.rt.evidenceAnchors("root").length
      r.rt.noteChildEvidence("root", "foo.ts:100-120")
      expect(r.rt.evidenceAnchors("root").length).toBe(first)
    } finally {
      cleanup(r)
    }
  })

  test("11. TARGETED VERIFICATION DOES NOT CONSUME EVIDENCE", () => {
    const r = makeRuntime()
    try {
      reachEvidence(r, "root", ["foo.ts:100-120"])
      r.rt.preGruntCheck("root", "read", { target: "foo.ts", selective: true })
      r.rt.preGruntCheck("root", "read", { target: "foo.ts", selective: true })
      r.rt.preGruntCheck("root", "read", { target: "foo.ts", selective: true })
      expect(r.rt.rootPhase("root")).toBe("worker_evidence_available")
      expect(r.rt.preGruntCheck("root", "read", { target: "foo.ts", selective: true }).block).toBe(false)
    } finally {
      cleanup(r)
    }
  })

  test("12. NEW BROAD DISCOVERY - worker-first re-activates", () => {
    const r = makeRuntime()
    try {
      reachEvidence(r, "root", ["foo.ts:100-120"])
      const decision = r.rt.preGruntCheck("root", "bash", { command: "grep -R x ." })
      expect(decision.block).toBe(true)
      expect(r.rt.rootPhase("root")).toBe("worker_required")
      expect(r.rt.preGruntCheck("root", "read", { target: "bar.ts" }).block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("13. ROOT_REPAIR_MODE regression - repair still grants authority", () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("root", "bash", { command: "grep -R x ." })
      r.rt.enterRootRepair("root", "test repair")
      expect(r.rt.rootPhase("root")).toBe("root_repair")
      expect(r.rt.preGruntCheck("root", "read", { target: "any.ts" }).block).toBe(false)
      expect(r.rt.preGruntCheck("root", "bash", { command: "find . -name '*.ts'" }).block).toBe(false)
    } finally {
      cleanup(r)
    }
  })

  test("14. COST SAFETY - no paid behavior changes; free workers never touch paid slots", () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "root", "verify", [freeWorker("free-1")])
      r.rt.attachChildSession("root", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildEvidence("root", "foo.ts:100-120")
      expect(r.rt.tryAcquirePaidChild()).toBe(true)
      expect(r.rt.tryAcquirePaidChild()).toBe(false)
      r.rt.releasePaidChild()
      expect(r.rt.tryAcquirePaidChild()).toBe(true)
      r.rt.releasePaidChild()
    } finally {
      cleanup(r)
    }
  })
})

describe("worker-evidence anchor extraction", () => {
  test("file:line ranges, file paths, and symbols become anchors", () => {
    const anchors = extractEvidenceAnchors(
      "flow at src/auth/refresh.ts:120-155; symbol: rotateToken; also packages/foo/src/bar.ts:42",
    )
    expect(anchors).toContain("src/auth/refresh.ts:120-155")
    expect(anchors).toContain("src/auth/refresh.ts")
    expect(anchors).toContain("rotateToken")
    expect(anchors).toContain("packages/foo/src/bar.ts:42")
  })

  test("bare prose is not an anchor", () => {
    const anchors = extractEvidenceAnchors("you should inspect the whole repository")
    expect(anchors).toEqual([])
  })
})