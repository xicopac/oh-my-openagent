import { describe, test, expect } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "../../shared/governance-audit"
import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "../../features/delegation-first"
import { createPaidWorkerGate } from "./paid-worker-gate"
import { classifyPaidStatus, type PaidModelStatus } from "./paid-consent"
import { resolveEffectivePricing } from "./tools"

const FREE_MODEL = "opencode/muse-spark-1.2-contributor-free"
const PAID_MODEL = "opencode/deepseek-v4-pro"
const STATIC_ONLY = "opencode/static-only-model"

const STATIC_PRICING = {
  [PAID_MODEL]: { input: 0.4, output: 0.8, cache_read: 0, cache_write: 0 },
  [FREE_MODEL]: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
}

function liveClient(models: Array<[string, unknown]>): unknown {
  const rows = models.map(([key, cost]) => {
    const [provider, id] = key.split("/")
    return { provider, id, cost }
  })
  return {
    model: { list: async () => ({ data: rows }) },
    provider: { list: async () => ({ data: { connected: ["opencode"] } }) },
  }
}

function makeOptions(models: Array<[string, unknown]>): Parameters<typeof resolveEffectivePricing>[0] {
  return {
    client: liveClient(models),
    pricingCatalog: STATIC_PRICING,
  } as Parameters<typeof resolveEffectivePricing>[0]
}

describe("FREE WORKERS MUST NOT TOUCH THE PAID SEMAPHORE", () => {
  test("live free model absent from static catalog is classified free with effective pricing", async () => {
    // given - the live catalog marks the model $0, the static catalog lacks it entirely
    const opts = makeOptions([[FREE_MODEL, { input: 0, output: 0 }]])
    const effective = await resolveEffectivePricing(opts)
    // when - the child is classified with the effective (merged) pricing
    const status: PaidModelStatus = classifyPaidStatus(FREE_MODEL, effective)
    // then - it is FREE, never a paid candidate
    expect(status).toBe("free")
  })

  test("static paid model stays paid under effective pricing", async () => {
    const opts = makeOptions([[PAID_MODEL, { input: 0.4, output: 0.8 }]])
    const effective = await resolveEffectivePricing(opts)
    expect(classifyPaidStatus(PAID_MODEL, effective)).toBe("paid")
  })

  test("3 free explore children consume zero paid slots", async () => {
    const auditRoot = mkdtempSync(join(tmpdir(), "free-concurrency-"))
    const audit = createGovernanceAuditWriter({ root: auditRoot })
    const rt: DelegationFirstRuntime = createDelegationFirstRuntime(audit, {
      modelAvailabilityFilePath: join(auditRoot, "model-availability.json"),
    })
    const gate = createPaidWorkerGate(1)
    try {
      const before = gate.activeCount()
      // Three ordinary FREE explore children: paid classification is free, so
      // no paid slot is acquired and no PAID_WORKER_CONCURRENCY_LIMIT can occur.
      for (let i = 0; i < 3; i++) {
        const opts = makeOptions([[FREE_MODEL, { input: 0, output: 0 }]])
        const effective = await resolveEffectivePricing(opts)
        const key = FREE_MODEL
        const status = classifyPaidStatus(key, effective)
        expect(status).toBe("free")
        let slotAcquired = false
        if (status !== "free") {
          slotAcquired = gate.tryAcquire()
        }
        expect(slotAcquired).toBe(false)
      }
      expect(gate.activeCount()).toBe(before)
      expect(gate.activeCount()).toBe(0)
    } finally {
      rt.dispose()
      rmSync(auditRoot, { recursive: true, force: true })
    }
  })

  test("mixed case: free A+B consume no slots, paid C consumes exactly one, paid D blocked, free E still allowed", async () => {
    const auditRoot = mkdtempSync(join(tmpdir(), "free-concurrency-mixed-"))
    const audit = createGovernanceAuditWriter({ root: auditRoot })
    const rt: DelegationFirstRuntime = createDelegationFirstRuntime(audit, {
      modelAvailabilityFilePath: join(auditRoot, "model-availability.json"),
    })
    const gate = createPaidWorkerGate(1)
    try {
      // A and B: free
      for (const model of [FREE_MODEL, FREE_MODEL]) {
        const opts = makeOptions([[model, { input: 0, output: 0 }]])
        const effective = await resolveEffectivePricing(opts)
        expect(classifyPaidStatus(model, effective)).toBe("free")
      }
      expect(gate.activeCount()).toBe(0)

      // C: separately authorized paid child acquires exactly one paid slot
      const cOpts = makeOptions([[PAID_MODEL, { input: 0.4, output: 0.8 }]])
      const cEffective = await resolveEffectivePricing(cOpts)
      expect(classifyPaidStatus(PAID_MODEL, cEffective)).toBe("paid")
      expect(gate.tryAcquire()).toBe(true)
      expect(gate.activeCount()).toBe(1)

      // D: second paid child blocked while C runs
      expect(gate.tryAcquire()).toBe(false)

      // E: a third FREE child still allowed according to normal free capacity
      const eOpts = makeOptions([[FREE_MODEL, { input: 0, output: 0 }]])
      const eEffective = await resolveEffectivePricing(eOpts)
      expect(classifyPaidStatus(FREE_MODEL, eEffective)).toBe("free")
      let eSlot = false
      if (classifyPaidStatus(FREE_MODEL, eEffective) !== "free") {
        eSlot = gate.tryAcquire()
      }
      expect(eSlot).toBe(false)

      gate.release()
      expect(gate.activeCount()).toBe(0)
    } finally {
      rt.dispose()
      rmSync(auditRoot, { recursive: true, force: true })
    }
  })
})