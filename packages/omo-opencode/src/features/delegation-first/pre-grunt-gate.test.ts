import { describe, test, expect } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "../../shared/governance-audit"
import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "./runtime"

const PRICING = {
  "kimi-for-coding/kimi-for-coding-highspeed": { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  "anthropic/claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0, cache_write: 0 },
}

function readJournalEvents(root: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const sessionDir of readdirSync(root)) {
    for (const entry of readdirSync(join(root, sessionDir))) {
      for (const line of readFileSync(join(root, sessionDir, entry), "utf8").split("\n")) {
        if (line.length === 0) continue
        out.push(JSON.parse(line))
      }
    }
  }
  return out
}

describe("delegation-first pre-grunt gate (early enforcement)", () => {
  test("blocks broad root exploration, steers to a free worker, and audits the intervention", async () => {
    const root = mkdtempSync(join(tmpdir(), "pre-grunt-gate-"))
    const audit = createGovernanceAuditWriter({ root })
    const rt: DelegationFirstRuntime = createDelegationFirstRuntime(audit, { pricing: PRICING })

    try {
      const parent = "ses-main"

      // given: MAIN begins crawling instead of delegating (grep/read/read/read)
      expect(rt.preGruntCheck(parent, "grep", { target: "src" }).block).toBe(false)
      expect(rt.preGruntCheck(parent, "read", { target: "src/a.ts" }).block).toBe(false)
      expect(rt.preGruntCheck(parent, "read", { target: "src/b.ts" }).block).toBe(false)
      const blocked = rt.preGruntCheck(parent, "read", { target: "src/c.ts" })

      // then: the fourth op is blocked with a steering message and a free-worker hint
      expect(blocked.block).toBe(true)
      expect(blocked.steering).toContain("explore")
      expect(blocked.freeWorkerHint).toBe("kimi-for-coding/kimi-for-coding-highspeed")

      // when: MAIN delegates to the free worker
      const delegated = rt.preGruntCheck(parent, "task", { target: "explore" })

      // then: the gate resets and a dispatch event lands
      expect(delegated.block).toBe(false)
      expect(delegated.delegated).toBe(true)

      await audit.flush()
      const events = readJournalEvents(root).map((e) => e.event)
      expect(events).toContain("root_grunt_pattern_detected")
      expect(events).toContain("early_delegation_required")
      expect(events).toContain("early_delegation_dispatched")

      // metadata only: no target path or steering text reaches the journal
      for (const line of readJournalEvents(root)) {
        expect(JSON.stringify(line)).not.toContain("src/c.ts")
        expect(JSON.stringify(line)).not.toContain("Broad repository exploration")
      }
    } finally {
      rt.dispose()
      await audit.flush()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("allows a single lookup and one anchored verification read, auditing the verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "pre-grunt-verify-"))
    const audit = createGovernanceAuditWriter({ root })
    const rt: DelegationFirstRuntime = createDelegationFirstRuntime(audit, { pricing: PRICING })

    try {
      const parent = "ses-main-2"

      expect(rt.preGruntCheck(parent, "grep", { target: "src/handlers" }).block).toBe(false)
      const verification = rt.preGruntCheck(parent, "read", {
        target: "src/handlers/auth.ts",
        selective: true,
      })

      expect(verification.block).toBe(false)
      expect(verification.selectiveVerification).toBe(true)

      await audit.flush()
      const events = readJournalEvents(root).map((e) => e.event)
      expect(events).toContain("selective_root_verification")
      expect(events).not.toContain("early_delegation_required")
      expect(events).not.toContain("root_grunt_pattern_detected")
    } finally {
      rt.dispose()
      await audit.flush()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("unknown-price models are never hinted as free", async () => {
    const root = mkdtempSync(join(tmpdir(), "pre-grunt-nofree-"))
    const audit = createGovernanceAuditWriter({ root })
    // No $0 model in the catalog: the hint must be null, never a guess.
    const rt: DelegationFirstRuntime = createDelegationFirstRuntime(audit, {
      pricing: { "anthropic/claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0, cache_write: 0 } },
    })

    try {
      const parent = "ses-main-3"
      rt.preGruntCheck(parent, "grep", { target: "src" })
      rt.preGruntCheck(parent, "read", { target: "src/a.ts" })
      rt.preGruntCheck(parent, "read", { target: "src/b.ts" })
      const blocked = rt.preGruntCheck(parent, "read", { target: "src/c.ts" })

      expect(blocked.block).toBe(true)
      expect(blocked.freeWorkerHint).toBeNull()
    } finally {
      rt.dispose()
      await audit.flush()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
