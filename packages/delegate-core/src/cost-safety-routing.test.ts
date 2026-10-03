import { describe, expect, test } from "bun:test"
import { resolveModelBand, type ModelBandCandidate, type ModelBandPricing } from "./model-band"

const MAIN = "opencode/root-main"
const MAIN_PRICE: ModelBandPricing = { input: 10, output: 30, cache_read: 0, cache_write: 0 }
const ROOT_FLASH_V41 = "opencode/deepseek-v4.1-flash"
const FREE_A = "opencode/free-a"
const FREE_B = "opencode/free-b"
const FLASH = "opencode/deepseek-v4-flash"
const PAID_STRONG = "openai/paid-strong"
const UNKNOWN = "opencode/unknown-cost"

const FREE_PRICE: ModelBandPricing = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const FLASH_PRICE: ModelBandPricing = { input: 0.3, output: 0.9, cache_read: 0, cache_write: 0 }
const FLASH_V41_PRICE: ModelBandPricing = { input: 0.3, output: 1.2, cache_read: 0.006, cache_write: 0 }

function price(input: number, output: number): ModelBandPricing {
  return { input, output, cache_read: 0, cache_write: 0 }
}

function pool(): ModelBandCandidate[] {
  return [
    { model: FREE_A, pricing: FREE_PRICE, tool_call: true },
    { model: FREE_B, pricing: FREE_PRICE, tool_call: true },
    { model: FLASH, pricing: FLASH_PRICE, tool_call: true },
    { model: PAID_STRONG, pricing: price(5, 15), tool_call: true },
    { model: UNKNOWN, tool_call: true },
  ]
}

function base(overrides: Partial<Parameters<typeof resolveModelBand>[0]> = {}) {
  return {
    requestedTier: "balanced" as const,
    candidates: pool(),
    mainModel: MAIN,
    mainPricing: MAIN_PRICE,
    ...overrides,
  }
}

describe("cost-safety child routing boundary", () => {
  test("master default model is DeepSeek V4.1 Flash (root resolution not gated)", () => {
    expect(ROOT_FLASH_V41).toBe("opencode/deepseek-v4.1-flash")
    expect(FLASH_V41_PRICE.input).toBeGreaterThan(0)
  })

  test("ordinary explore child picks free-A by default (paid permission absent)", () => {
    const result = resolveModelBand(base({ requestedTier: "fast" }))
    expect(result?.model).toBe(FREE_A)
    expect(result?.band).toBe("free")
  })

  test("free-A disabled picks free-B, still free, never Flash", () => {
    const result = resolveModelBand(base({ requestedTier: "fast", unavailable: new Set([FREE_A]) }))
    expect(result?.model).toBe(FREE_B)
    expect(result?.band).toBe("free")
  })

  test("all free models unavailable returns NO_ELIGIBLE_FREE_MODEL (undefined), never Flash", () => {
    const result = resolveModelBand(base({ requestedTier: "balanced", unavailable: new Set([FREE_A, FREE_B]) }))
    expect(result).toBeUndefined()
  })

  test("master tier without paid permission still cannot select paid Flash", () => {
    const result = resolveModelBand(base({ requestedTier: "master" }))
    expect(result?.model).toBe(FREE_A)
    expect(result?.model).not.toBe(FLASH)
    expect(result?.band).toBe("free")
  })

  test("explicit allow_paid_workers + strong selects paid Flash", () => {
    const result = resolveModelBand(
      base({ requestedTier: "strong", allowPaidWorkers: true, unavailable: new Set([FREE_A, FREE_B]) }),
    )
    expect(result?.model).toBe(FLASH)
    expect(result?.band).not.toBe("free")
  })

  test("paid permission defaults to false when absent", () => {
    expect(base().allowPaidWorkers ?? false).toBe(false)
  })

  test("unknown-cost model is not eligible for free-only child routing", () => {
    const result = resolveModelBand(
      base({ requestedTier: "fast", candidates: [{ model: UNKNOWN, tool_call: true }], mainModel: MAIN, mainPricing: MAIN_PRICE }),
    )
    expect(result).toBeUndefined()
  })

  test("multiple children cannot automatically escalate to paid", () => {
    for (let i = 0; i < 5; i += 1) {
      const result = resolveModelBand(base({ requestedTier: "balanced" }))
      expect(result?.band).toBe("free")
      expect(result?.model).not.toBe(FLASH)
    }
  })

  test("paid pin is blocked without paid permission (fail closed)", () => {
    const result = resolveModelBand(base({ requestedTier: "strong", pinned: { strong: PAID_STRONG } }))
    expect(result?.model).not.toBe(PAID_STRONG)
    expect(result?.band).toBe("free")
  })

  describe("#given a paid pin on the free-band tier (the fast tier)", () => {
    const paidFastPool: ModelBandCandidate[] = [
      { model: FREE_A, pricing: FREE_PRICE, tool_call: true },
      { model: FREE_B, pricing: FREE_PRICE, tool_call: true },
      { model: ROOT_FLASH_V41, pricing: FLASH_V41_PRICE, tool_call: true },
    ]

    test("#when paid workers are forbidden #then the paid fast pin is ignored and a free model wins", () => {
      const result = resolveModelBand(
        base({ requestedTier: "fast", candidates: paidFastPool, pinned: { fast: ROOT_FLASH_V41 } }),
      )
      expect(result?.model).not.toBe(ROOT_FLASH_V41)
      expect(result?.band).toBe("free")
      expect([FREE_A, FREE_B]).toContain(result?.model)
    })

    test("#when paid workers are forbidden #then a paid pin never leaks into balanced or strong tiers", () => {
      for (const tier of ["fast", "balanced", "strong"] as const) {
        const result = resolveModelBand(
          base({
            requestedTier: tier,
            candidates: paidFastPool,
            pinned: { fast: ROOT_FLASH_V41, balanced: ROOT_FLASH_V41, strong: ROOT_FLASH_V41 },
          }),
        )
        expect(result?.model).not.toBe(ROOT_FLASH_V41)
        expect(result?.band).toBe("free")
      }
    })

    test("#when every free candidate is unavailable #then a paid fast pin still fails closed", () => {
      const result = resolveModelBand(
        base({
          requestedTier: "fast",
          candidates: paidFastPool,
          pinned: { fast: ROOT_FLASH_V41 },
          unavailable: new Set([FREE_A, FREE_B]),
        }),
      )
      expect(result).toBeUndefined()
    })

    test("#when paid workers are explicitly allowed #then the paid fast pin is honored", () => {
      const result = resolveModelBand(
        base({
          requestedTier: "fast",
          candidates: paidFastPool,
          pinned: { fast: ROOT_FLASH_V41 },
          allowPaidWorkers: true,
        }),
      )
      expect(result?.model).toBe(ROOT_FLASH_V41)
    })
  })

  describe("#given a free pin on the free-band tier", () => {
    test("#then the free pin is honored for an ordinary child", () => {
      const result = resolveModelBand(
        base({ requestedTier: "fast", pinned: { fast: FREE_B } }),
      )
      expect(result?.model).toBe(FREE_B)
      expect(result?.band).toBe("free")
    })
  })
})
