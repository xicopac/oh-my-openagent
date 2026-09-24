import { describe, test, expect } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "../../shared/governance-audit"
import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "./runtime"

type GovernanceAuditWriter = ReturnType<typeof createGovernanceAuditWriter>

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

function readAllLines(root: string): string[] {
  const lines: string[] = []
  for (const sessionDir of readdirSync(root)) {
    for (const entry of readdirSync(join(root, sessionDir))) {
      lines.push(...readFileSync(join(root, sessionDir, entry), "utf8").split("\n").filter((l) => l.length > 0))
    }
  }
  return lines
}

function makeRuntime(): {
  rt: DelegationFirstRuntime
  audit: GovernanceAuditWriter
  root: string
  availabilityDir: string
} {
  const root = mkdtempSync(join(tmpdir(), "root-materialization-"))
  const availabilityDir = mkdtempSync(join(tmpdir(), "root-materialization-avail-"))
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

describe("root materialization lane", () => {
  test("1. Normal root source-code implementation write => BLOCKED (no materialization marker)", async () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      const decision = r.rt.preGruntCheck("m", "write", { target: "packages/web/src/app/page.tsx" })
      expect(decision.block).toBe(true)
      expect(decision.steering).toContain("ROOT_DELEGATION_REQUIRED")
    } finally {
      cleanup(r)
    }
  })

  test("2. Root writes already-determined .omo/handoffs/test.md => ALLOWED with materialization", async () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      const decision = r.rt.preGruntCheck("m", "write", {
        target: ".omo/handoffs/test.md",
        materialization: true,
      })
      expect(decision.block).toBe(false)
      expect(decision.materializationAuthorized).toBe(true)
      expect(decision.materializationCategory).toBeDefined()
    } finally {
      cleanup(r)
    }
  })

  test("3. No delegate-task/subagent is spawned for materialization write", async () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      const decision = r.rt.preGruntCheck("m", "write", {
        target: ".omo/handoffs/test.md",
        materialization: true,
      })
      expect(decision.delegated).not.toBe(true)
      expect(r.rt.recoverySnapshot("m").activeProbe).toBeNull()
      await r.audit.flush()
      const events = readEventNames(r.root)
      expect(events).toContain("root_materialization_action")
      expect(events).not.toContain("early_delegation_dispatched")
    } finally {
      cleanup(r)
    }
  })

  test("4. Root trying to label a source-code edit as materialization => BLOCKED", async () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      const decision = r.rt.preGruntCheck("m", "write", {
        target: "packages/web/src/app/page.tsx",
        materialization: true,
      })
      expect(decision.block).toBe(true)
      expect(decision.steering).toContain("ROOT_DELEGATION_REQUIRED")
      const bashDisguise = r.rt.preGruntCheck("m", "bash", {
        command: "bun run build",
        materialization: true,
      } as unknown as Record<string, unknown> & { command: string; materialization: boolean })
      expect(bashDisguise.block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("5. Materialization decision is audit logged and metadata-only", async () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      r.rt.preGruntCheck("m", "write", {
        target: ".omo/handoffs/test.md",
        materialization: true,
      })
      await r.audit.flush()
      const events = readEventNames(r.root)
      expect(events).toContain("root_materialization_action")
      const lines = readAllLines(r.root)
      const matLines = lines.filter((l) => {
        try {
          return (JSON.parse(l) as { event?: string }).event === "root_materialization_action"
        } catch {
          return false
        }
      })
      expect(matLines.length).toBeGreaterThan(0)
      for (const line of matLines) {
        expect(JSON.stringify(line)).not.toContain("test.md")
        const parsed = JSON.parse(line) as Record<string, unknown>
        expect(parsed["content"]).toBeUndefined()
        expect(parsed["text"]).toBeUndefined()
        expect(parsed["output"]).toBeUndefined()
      }
    } finally {
      cleanup(r)
    }
  })

  test("6. Positive verification: read of .omo/handoffs/test.md with materialization allowed", async () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      const readDecision = r.rt.preGruntCheck("m", "read", {
        target: ".omo/handoffs/test.md",
        materialization: true,
      })
      expect(readDecision.block).toBe(false)
      expect(readDecision.materializationAuthorized).toBe(true)
      const bashVerify = r.rt.preGruntCheck("m", "bash", {
        command: "sha256sum .omo/handoffs/test.md",
        materialization: true,
      } as unknown as Record<string, unknown> & { command: string; materialization: boolean })
      expect(bashVerify.block).toBe(false)
      expect(bashVerify.materializationAuthorized).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("7. Negative mechanical-bash: git commit with materialization => blocked", async () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      const decision = r.rt.preGruntCheck("m", "bash", {
        command: "git commit -m test",
        materialization: true,
      } as unknown as Record<string, unknown> & { command: string; materialization: boolean })
      expect(decision.block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("8. terminal phase still BLOCKS materialization (precedence)", async () => {
    const r = makeRuntime()
    try {
      r.rt.beginDelegation("job", "m", "map auth", [{ model_id: "free-1", tier: "free", capability: 1, free: true }])
      r.rt.attachChildSession("m", "child")
      r.rt.markRequestStarted("child")
      r.rt.noteChildStartupFailure("m", "child", "EACCES")
      r.rt.noteEvidencePipelineBroken("m", "child-2", "evidence never advanced")
      r.rt.beginRecoveryProbe("m", "probe-1", "nonce-1")
      r.rt.markRecoveryVerified("m", "probe-1")
      expect(r.rt.rootPhase("m")).toBe("recovery_verified")
      const decision = r.rt.preGruntCheck("m", "write", {
        target: ".omo/handoffs/test.md",
        materialization: true,
      })
      expect(decision.block).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("9. mkdir and mv/cp to materialization path allowed, arbitrary bash blocked", async () => {
    const r = makeRuntime()
    try {
      r.rt.preGruntCheck("m", "bash", { command: "grep -R TODO ." })
      const mkdirDecision = r.rt.preGruntCheck("m", "bash", {
        command: "mkdir -p .omo/handoffs/subdir",
        materialization: true,
      } as unknown as Record<string, unknown> & { command: string; materialization: boolean })
      expect(mkdirDecision.block).toBe(false)
      expect(mkdirDecision.materializationAuthorized).toBe(true)
      const lsDecision = r.rt.preGruntCheck("m", "bash", {
        command: "ls .omo/handoffs/test.md",
        materialization: true,
      } as unknown as Record<string, unknown> & { command: string; materialization: boolean })
      expect(lsDecision.block).toBe(false)
      const curlDecision = r.rt.preGruntCheck("m", "bash", {
        command: "curl https://example.com",
        materialization: true,
      } as unknown as Record<string, unknown> & { command: string; materialization: boolean })
      expect(curlDecision.block).toBe(true)
    } finally {
      cleanup(r)
    }
  })
})
