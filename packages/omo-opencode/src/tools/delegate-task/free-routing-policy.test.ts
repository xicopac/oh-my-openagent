import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createModelAvailabilityCache } from "../../features/delegation-first/model-availability-cache"
import { loadPersistentAvailability } from "../../features/delegation-first/persistent-model-availability"
import type { PricingCatalog } from "../../hooks/resource-governor"
import { resolveDynamicWorkerModel } from "./dynamic-model-resolver"
import type { OpencodeClient } from "./types"

const FREE_A = "opencode/free-a"
const FREE_B = "opencode/free-b"
const FLASH = "opencode/deepseek-v4-flash"
const MAIN = "opencode/main-model"

const FREE_PRICE = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const FLASH_PRICE = { input: 0.3, output: 0.9, cache_read: 0, cache_write: 0 }
const MAIN_PRICE = { input: 10, output: 30, cache_read: 0, cache_write: 0 }

const CATALOG = new Set([FREE_A, FREE_B, FLASH])

const PRICING: PricingCatalog = {
  [FREE_A]: FREE_PRICE,
  [FREE_B]: FREE_PRICE,
  [FLASH]: FLASH_PRICE,
  [MAIN]: MAIN_PRICE,
}

// Fixed deterministic clock: availability TTL math never reads Date.now.
const NOW = 1_700_000_000_000
const DISABLED = "Model is disabled"

const tempDir = mkdtempSync(join(tmpdir(), "free-routing-policy-"))

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function clientWithConfig(config: Record<string, unknown>): OpencodeClient {
  return {
    app: { agents: async () => ({}) },
    config: { get: async () => ({ data: config }) },
  } as unknown as OpencodeClient
}

async function resolveBalanced(extraUnavailable: Iterable<string>, allowPaidWorkers = false) {
  const result = await resolveDynamicWorkerModel({
    client: clientWithConfig({}),
    tier: "balanced",
    mainModel: MAIN,
    availableModelsOverride: CATALOG,
    pricingCatalog: PRICING,
    extraUnavailable,
    allowPaidWorkers,
  })
  return result
}

/**
 * Free-first routing with a persistent disabled-model quarantine, told as three
 * processes sharing one on-disk availability store:
 *  - PROCESS A marks free-a disabled; the quarantine is written through to disk
 *    and balanced routing picks free-b, never paid Flash.
 *  - FRESH PROCESS B hydrates the quarantine from the same file at construction
 *    (no new mark call) and routes straight to free-b.
 *  - PROCESS C quarantines the whole free pool; only then does balanced
 *    escalate to paid Flash.
 */
describe("free-first routing policy with persistent quarantine", () => {
  test("PROCESS A persists the disabled free model and balanced resolves to the remaining free model", async () => {
    // given - a process-A availability cache backed by a temp persistence file
    const fileA = join(tempDir, "process-a.json")
    const cacheA = createModelAvailabilityCache({ persistentFilePath: fileA, nowMs: () => NOW })

    // when - free-a fails with a disabled-model error
    cacheA.markUnavailable(FREE_A, DISABLED, NOW)

    // then - the quarantine is in-memory and written through to disk as disabled
    expect(cacheA.isUnavailable(FREE_A, NOW)).toBe(true)
    const persisted = loadPersistentAvailability(fileA)
    expect(persisted.entries[FREE_A]?.classification).toBe("disabled")
    expect(persisted.entries[FREE_A]?.reason).toBe(DISABLED)

    // and when - an ordinary balanced child resolves with the quarantined free-a excluded
    const resolved = await resolveBalanced(cacheA.unavailableKeys(NOW))

    // then - the remaining free model wins; paid Flash is not touched
    expect(resolved.model).toBe(FREE_B)
    expect(resolved.model).not.toBe(FLASH)
    expect(resolved.band).toBe("free")
    expect(resolved.escalated).toBe(false)
  })

  test("FRESH PROCESS B hydrates the quarantine from disk and never selects the disabled free model", async () => {
    // given - process A already quarantined free-a into the shared file
    const fileB = join(tempDir, "process-b.json")
    createModelAvailabilityCache({ persistentFilePath: fileB, nowMs: () => NOW }).markUnavailable(
      FREE_A,
      DISABLED,
      NOW,
    )

    // when - a brand-new process-B cache is constructed on the SAME file (no new mark call)
    const cacheB = createModelAvailabilityCache({ persistentFilePath: fileB, nowMs: () => NOW })

    // then - free-a is unavailable purely from disk hydration
    expect(cacheB.isUnavailable(FREE_A, NOW)).toBe(true)
    expect(cacheB.unavailableKeys(NOW)).toContain(FREE_A)

    // and when - an ordinary balanced child resolves with the hydrated quarantine
    const resolved = await resolveBalanced(cacheB.unavailableKeys(NOW))

    // then - free-b is picked directly; free-a is never selected and Flash stays untouched
    expect(resolved.model).toBe(FREE_B)
    expect(resolved.model).not.toBe(FREE_A)
    expect(resolved.model).not.toBe(FLASH)
    expect(resolved.band).toBe("free")
  })

  test("PROCESS C blocks paid escalation for a free-only child after the entire free pool is quarantined", async () => {
    // given - process A/B quarantined free-a and free-b into the shared file
    const fileC = join(tempDir, "process-c.json")
    const seed = createModelAvailabilityCache({ persistentFilePath: fileC, nowMs: () => NOW })
    seed.markUnavailable(FREE_A, DISABLED, NOW)
    seed.markUnavailable(FREE_B, DISABLED, NOW)

    // and - a fresh process-C cache hydrating BOTH quarantines from disk
    const cacheC = createModelAvailabilityCache({ persistentFilePath: fileC, nowMs: () => NOW })
    expect(cacheC.unavailableKeys(NOW).sort()).toEqual([FREE_A, FREE_B].sort())

    // when - an ordinary balanced child resolves with every free candidate unavailable
    const resolved = await resolveBalanced(cacheC.unavailableKeys(NOW))

    // then - COST-SAFETY: a free-only child returns NO_ELIGIBLE_FREE_MODEL; the
    // paid Flash rung is NOT selected without explicit paid permission
    expect(resolved.kind).toBe("no-eligible-candidate")

    // and - explicit paid permission still allows Flash after exhaustion
    const paid = await resolveBalanced(cacheC.unavailableKeys(NOW), true)
    expect(paid.kind).toBe("resolved")
    if (paid.kind === "resolved") {
      expect(paid.model).toBe(FLASH)
      expect(paid.escalated).toBe(true)
    }
  })
})
