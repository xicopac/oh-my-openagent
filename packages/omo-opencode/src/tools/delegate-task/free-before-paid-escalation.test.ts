// FREE ROUTING BEFORE PAID ESCALATION (OMA_FREE_CHILD_NO_AUTO_PAID_V1)
// Ordinary children are FREE-ONLY. Root/master parent authority must never
// mutate an ordinary child into a paid child; paid execution requires a
// separate explicit MASTER request plus fresh operator consent.
import { describe, expect, test } from "bun:test"
import { resolveModelBand, type ModelBandPricing } from "@oh-my-opencode/delegate-core"
import { classifyPaidStatus, paidBandAllowed } from "./paid-consent"
import { createPaidWorkerGate } from "./paid-worker-gate"
import type { PricingCatalog } from "../../hooks/resource-governor"

const FREE_A = "opencode/free-a"
const FREE_B = "opencode/free-b"
const FLASH = "opencode/deepseek-v4-flash"
const MAIN = "opencode/main-model"
const FREE_PRICE: ModelBandPricing = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const FLASH_PRICE: ModelBandPricing = { input: 0.3, output: 0.9, cache_read: 0, cache_write: 0 }
const MAIN_PRICE: ModelBandPricing = { input: 10, output: 30, cache_read: 0, cache_write: 0 }
const CATALOG = new Set([FREE_A, FREE_B, FLASH])
const PRICING: PricingCatalog = {
  [FREE_A]: FREE_PRICE,
  [FREE_B]: FREE_PRICE,
  [FLASH]: FLASH_PRICE,
  [MAIN]: MAIN_PRICE,
}
describe("FREE ROUTING BEFORE PAID ESCALATION", () => {
  test("explore/fast with a free candidate selects the free candidate", () => {
    const result = resolveModelBand({
      requestedTier: "fast",
      candidates: [
        { model: FREE_A, pricing: FREE_PRICE },
        { model: FREE_B, pricing: FREE_PRICE },
        { model: FLASH, pricing: FLASH_PRICE },
      ],
      mainModel: MAIN,
      mainPricing: MAIN_PRICE,
    })
    expect(result?.band).toBe("free")
    expect(result?.model).not.toBe(FLASH)
  })
  test("master-tier child with a compatible free candidate still selects free", () => {
    const result = resolveModelBand({
      requestedTier: "master",
      candidates: [
        { model: FREE_A, pricing: FREE_PRICE },
        { model: FLASH, pricing: FLASH_PRICE },
      ],
      mainModel: FLASH,
      mainPricing: FLASH_PRICE,
    })
    expect(result?.band).toBe("free")
    expect(result?.model).toBe(FREE_A)
    expect(result?.model).not.toBe(FLASH)
  })
  test("root authority alone never auto-escalates an ordinary child", () => {
    expect(paidBandAllowed(undefined, true)).toBe(true)
    const result = resolveModelBand({
      requestedTier: "balanced",
      candidates: [
        { model: FREE_A, pricing: FREE_PRICE },
        { model: FLASH, pricing: FLASH_PRICE },
      ],
      mainModel: MAIN,
      mainPricing: MAIN_PRICE,
      allowPaidWorkers: false,
    })
    expect(result?.band).toBe("free")
    expect(result?.model).toBe(FREE_A)
  })
  test("free workers never consume a paid concurrency slot", () => {
    const gate = createPaidWorkerGate(1)
    expect(classifyPaidStatus(FREE_A, PRICING)).toBe("free")
    expect(gate.activeCount()).toBe(0)
    expect(gate.tryAcquire()).toBe(false)
    expect(gate.activeCount()).toBe(0)
  })
})

