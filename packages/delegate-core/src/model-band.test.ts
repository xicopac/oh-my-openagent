import { describe, expect, test } from "bun:test"
import {
  MODEL_BANDS,
  MODEL_TIERS,
  resolveModelBand,
  tierToBand,
  type ModelBandCandidate,
  type ModelBandPricing,
} from "./model-band"

const MAIN = "opencode/deepseek-v4-pro"
const MAIN_PRICE: ModelBandPricing = { input: 3.5, output: 10, cache_read: 0, cache_write: 0 }

const FREE_A = "opencode/nemotron-3.5-lightning-free"
const FREE_B = "opencode/mimo-v2.5-free"
const CHEAP_A = "opencode/kimi-k2-lite" // input 0.6
const CHEAP_B = "opencode/glm-4.5" // input 1.5
const STRONG_A = "opencode/gpt-5-sol" // input 2.8, strongest
const STRONG_B = "opencode/qwen3-max" // input 2.0
const EXPENSIVE = "opencode/premium" // input 8 (> MAIN)
const UNKNOWN = "opencode/mystery" // no pricing

function price(input: number, output: number, cache_read = 0, cache_write = 0): ModelBandPricing {
  return { input, output, cache_read, cache_write }
}

function pool(): ModelBandCandidate[] {
  return [
    { model: FREE_A, pricing: price(0, 0), tool_call: true },
    { model: FREE_B, pricing: price(0, 0), tool_call: true },
    { model: CHEAP_A, pricing: price(0.6, 2), tool_call: true },
    { model: CHEAP_B, pricing: price(1.5, 6), tool_call: true },
    { model: STRONG_A, pricing: price(2.8, 9), capability: 0.95, reasoning: true, tool_call: true },
    { model: STRONG_B, pricing: price(2, 8), capability: 0.8, reasoning: true, tool_call: true },
    { model: EXPENSIVE, pricing: price(8, 30), tool_call: true },
    { model: UNKNOWN, reasoning: true, tool_call: true },
  ]
}

function base() {
  return { candidates: pool(), mainModel: MAIN, mainPricing: MAIN_PRICE }
}

describe("resolveModelBand", () => {
  describe("constants + mapping", () => {
    test("#then tiers and bands enumerate in escalation order", () => {
      expect(MODEL_TIERS).toEqual(["fast", "balanced", "strong", "master"])
      expect(MODEL_BANDS).toEqual(["free", "cheap_paid", "strong_paid", "main_equiv"])
    })

    test("#then tierToBand maps each tier to its economic band", () => {
      expect(tierToBand("fast")).toBe("free")
      expect(tierToBand("balanced")).toBe("free")
      expect(tierToBand("strong")).toBe("strong_paid")
      expect(tierToBand("master")).toBe("main_equiv")
    })
  })

  describe("#given a free request", () => {
    test("#then it returns only a genuinely $0 model", () => {
      const result = resolveModelBand({ requestedTier: "fast", ...base() })
      expect(result?.band).toBe("free")
      expect(result?.model === FREE_A || result?.model === FREE_B).toBe(true)
      expect(result?.usedMainModel).toBe(false)
    })

    test("#then an unknown-price model is never selected as free", () => {
      const result = resolveModelBand({
        requestedTier: "fast",
        candidates: [{ model: UNKNOWN, tool_call: true }],
        mainModel: MAIN,
        mainPricing: MAIN_PRICE,
      })
      expect(result?.band).not.toBe("free")
      expect(result?.band).toBe("strong_paid")
      expect(result?.escalated).toBe(true)
    })
  })

  describe("#given a balanced free-first request", () => {
    test("#then it prefers a genuinely $0 model over every paid model", () => {
      const result = resolveModelBand({ requestedTier: "balanced", ...base() })
      expect(result?.band).toBe("free")
      expect(result?.model === FREE_A || result?.model === FREE_B).toBe(true)
      expect(result?.usedMainModel).toBe(false)
    })

    test("#then it escalates to the lowest expected-cost paid model only when the free pool is exhausted", () => {
      const result = resolveModelBand({
        requestedTier: "balanced",
        ...base(),
        unavailable: new Set([FREE_A, FREE_B]),
      })
      expect(result?.band).toBe("cheap_paid")
      expect(result?.model).toBe(CHEAP_A)
      expect(result?.model).not.toBe(EXPENSIVE)
      expect(result?.escalated).toBe(true)
    })
  })

  describe("#given the balanced free-first escalation ladder", () => {
    const FLASH = "deepseek/deepseek-v4-flash"
    const PAID_STRONG = "openai/paid-strong"
    const BALANCED_MAIN = "opencode/main"
    const BALANCED_MAIN_PRICE: ModelBandPricing = { input: 10, output: 30, cache_read: 0, cache_write: 0 }

    function balancedPool(): ModelBandCandidate[] {
      return [
        { model: "opencode/free-a", pricing: price(0, 0), capability: 0.7, tool_call: true },
        { model: "opencode/free-b", pricing: price(0, 0), capability: 0.6, tool_call: true },
        { model: FLASH, pricing: price(0.5, 2), capability: 0.9, reasoning: true, tool_call: true },
        { model: PAID_STRONG, pricing: price(5, 15), capability: 0.95, reasoning: true, tool_call: true },
      ]
    }

    test("#then it returns a $0 free model in the free band", () => {
      const result = resolveModelBand({
        requestedTier: "balanced",
        candidates: balancedPool(),
        mainModel: BALANCED_MAIN,
        mainPricing: BALANCED_MAIN_PRICE,
      })
      expect(result?.band).toBe("free")
      expect(result?.requestedBand).toBe("free")
      expect(result?.model).toBe("opencode/free-a")
      expect(result?.escalated).toBe(false)
    })

    test("#then with free-a unavailable it returns free-b (still free, never Flash)", () => {
      const result = resolveModelBand({
        requestedTier: "balanced",
        candidates: balancedPool(),
        mainModel: BALANCED_MAIN,
        mainPricing: BALANCED_MAIN_PRICE,
        unavailable: new Set(["opencode/free-a"]),
      })
      expect(result?.band).toBe("free")
      expect(result?.model).toBe("opencode/free-b")
      expect(result?.model).not.toBe(FLASH)
    })

    test("#then with every free model unavailable it escalates to a paid band and returns Flash", () => {
      const result = resolveModelBand({
        requestedTier: "balanced",
        candidates: balancedPool(),
        mainModel: BALANCED_MAIN,
        mainPricing: BALANCED_MAIN_PRICE,
        unavailable: new Set(["opencode/free-a", "opencode/free-b"]),
      })
      expect(result?.band === "cheap_paid" || result?.band === "strong_paid").toBe(true)
      expect(result?.escalated).toBe(true)
      expect(result?.model === FLASH || result?.model === PAID_STRONG).toBe(true)
      expect(result?.model).toBe(FLASH)
    })
  })

  describe("#given a strong_paid request", () => {
    test("#then it selects a strong paid model instead of jumping straight to MAIN", () => {
      const result = resolveModelBand({ requestedTier: "strong", ...base() })
      expect(result?.band).toBe("strong_paid")
      expect(result?.model).toBe(STRONG_A)
      expect(result?.model).not.toBe(MAIN)
      expect(result?.usedMainModel).toBe(false)
    })

    test("#then a known-price strong model beats an unknown-price model", () => {
      const result = resolveModelBand({
        requestedTier: "strong",
        candidates: [
          { model: STRONG_A, pricing: price(2.8, 9), capability: 0.9, tool_call: true },
          { model: UNKNOWN, reasoning: true, tool_call: true },
        ],
        mainModel: MAIN,
        mainPricing: MAIN_PRICE,
      })
      expect(result?.model).toBe(STRONG_A)
    })
  })

  describe("#given a main_equiv request", () => {
    test("#then it inherits MAIN's concrete model as a child", () => {
      const result = resolveModelBand({ requestedTier: "master", ...base() })
      expect(result?.model).toBe(MAIN)
      expect(result?.band).toBe("main_equiv")
      expect(result?.usedMainModel).toBe(true)
      expect(result?.escalated).toBe(false)
    })
  })

  describe("#given capability requirements", () => {
    test("#then capability filtering happens before price preference", () => {
      // A $0 free model lacking vision must not beat a paid vision model.
      const result = resolveModelBand({
        requestedTier: "fast",
        candidates: [
          { model: "catalog/text-free", pricing: price(0, 0), tool_call: true, vision: false },
          { model: "catalog/vision-paid", pricing: price(2, 6), tool_call: true, vision: true },
        ],
        mainModel: MAIN,
        mainPricing: MAIN_PRICE,
        required: { vision: true },
      })
      expect(result?.model).toBe("catalog/vision-paid")
      expect(result?.band).toBe("cheap_paid")
      expect(result?.escalated).toBe(true)
    })
  })

  describe("#given disabled/negative-cached models", () => {
    test("#then an unavailable free model never wins", () => {
      const result = resolveModelBand({
        requestedTier: "fast",
        ...base(),
        unavailable: new Set([FREE_A]),
      })
      expect(result?.model).toBe(FREE_B)
    })

    test("#then an unavailable explicit pin never wins", () => {
      const result = resolveModelBand({
        requestedTier: "fast",
        ...base(),
        pinned: { fast: "opencode/disabled-pin" },
        unavailable: new Set(["opencode/disabled-pin", FREE_A]),
      })
      expect(result?.model).toBe(FREE_B)
    })
  })

  describe("#given escalation", () => {
    test("#then a missing free/cheap band escalates to strong_paid", () => {
      const result = resolveModelBand({
        requestedTier: "fast",
        candidates: [{ model: "opencode/equal", pricing: price(3.5, 10), tool_call: true }],
        mainModel: MAIN,
        mainPricing: MAIN_PRICE,
      })
      expect(result?.band).toBe("strong_paid")
      expect(result?.escalated).toBe(true)
    })

    test("#then an empty pool escalates to MAIN", () => {
      const result = resolveModelBand({
        requestedTier: "fast",
        candidates: [],
        mainModel: MAIN,
        mainPricing: MAIN_PRICE,
      })
      expect(result?.model).toBe(MAIN)
      expect(result?.band).toBe("main_equiv")
      expect(result?.usedMainModel).toBe(true)
      expect(result?.escalated).toBe(true)
    })
  })

  describe("#given the full enabled catalog", () => {
    test("#then it participates (no hardcoded shortlist): strongest of many arbitrary free models wins", () => {
      const manyFree = Array.from({ length: 10 }, (_, i) => ({
        model: `catalog/free-${i}`,
        pricing: price(0, 0),
        capability: 0.5 + i * 0.02,
        tool_call: true,
      }))
      const result = resolveModelBand({
        requestedTier: "fast",
        candidates: manyFree,
        mainModel: MAIN,
        mainPricing: MAIN_PRICE,
      })
      expect(result?.model).toBe("catalog/free-9")
    })
  })

  describe("#given an explicit pin override", () => {
    test("#then the pinned model wins for its tier", () => {
      const result = resolveModelBand({
        requestedTier: "fast",
        ...base(),
        pinned: { fast: "opencode/pinned-fast" },
      })
      expect(result?.model).toBe("opencode/pinned-fast")
      expect(result?.escalated).toBe(false)
    })
  })
})
