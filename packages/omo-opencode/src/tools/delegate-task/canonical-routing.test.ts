import { describe, test, expect } from "bun:test"
import { resolveDynamicWorkerModel, buildModelRoutingPins } from "./dynamic-model-resolver"
import type { OpencodeClient } from "./types"
import type { ModelPricing, PricingCatalog } from "../../hooks/resource-governor"

const FREE: ModelPricing = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const CHEAP: ModelPricing = { input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 }
const EXPENSIVE: ModelPricing = { input: 20, output: 60, cache_read: 0, cache_write: 0 }

function clientWithConfig(config: Record<string, unknown>): OpencodeClient {
  return {
    app: { agents: async () => ({}) },
    config: { get: async () => ({ data: config }) },
  } as unknown as OpencodeClient
}

describe("resolveDynamicWorkerModel - canonical dynamic routing", () => {
  test("resolves a free gateway model from the live enabled pool (no static fallback)", async () => {
    const client = clientWithConfig({})
    const pricing: PricingCatalog = { "opencode/gpt-5.6-luna-fast": FREE }
    const result = await resolveDynamicWorkerModel({
      client,
      tier: "fast",
      availableModelsOverride: new Set(["opencode/gpt-5.6-luna-fast", "openai/gpt-5.6-luna-fast"]),
      pricingCatalog: pricing,
    })
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.model).toBe("opencode/gpt-5.6-luna-fast")
      expect(result.band).toBe("free")
    }
  })

  test("never selects a provider disabled via disabled_providers (#5)", async () => {
    const client = clientWithConfig({ disabled_providers: ["openai"] })
    const pricing: PricingCatalog = {
      "openai/gpt-5.6-luna-fast": FREE,
      "opencode/gpt-5.6-luna-fast": FREE,
    }
    const result = await resolveDynamicWorkerModel({
      client,
      tier: "fast",
      availableModelsOverride: new Set(["openai/gpt-5.6-luna-fast", "opencode/gpt-5.6-luna-fast"]),
      pricingCatalog: pricing,
    })
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.model).not.toContain("openai/")
      expect(result.model).toBe("opencode/gpt-5.6-luna-fast")
    }
  })

  test("excludes anthropic and openai when both are disabled (#4)", async () => {
    const client = clientWithConfig({ disabled_providers: ["openai", "anthropic"] })
    const pricing: PricingCatalog = {
      "openai/gpt-5.6-luna-fast": FREE,
      "anthropic/claude-haiku-4-5": FREE,
      "opencode/gpt-5.6-luna-fast": FREE,
    }
    const result = await resolveDynamicWorkerModel({
      client,
      tier: "fast",
      availableModelsOverride: new Set([
        "openai/gpt-5.6-luna-fast",
        "anthropic/claude-haiku-4-5",
        "opencode/gpt-5.6-luna-fast",
      ]),
      pricingCatalog: pricing,
    })
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.model).toBe("opencode/gpt-5.6-luna-fast")
    }
  })

  test("escalates FREE -> CHEAP_PAID -> STRONG_PAID -> MAIN_EQUIV (#10)", async () => {
    const client = clientWithConfig({})
    const pricing: PricingCatalog = {
      "main/model": EXPENSIVE,
      "provider/cheap-paid": CHEAP,
      "provider/strong-paid": EXPENSIVE,
    }
    const result = await resolveDynamicWorkerModel({
      client,
      tier: "fast",
      mainModel: "main/model",
      availableModelsOverride: new Set(["provider/cheap-paid", "provider/strong-paid"]),
      pricingCatalog: pricing,
    })
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.model).toBe("provider/cheap-paid")
      expect(result.escalated).toBe(true)
    }
  })

  test("falls back to MAIN's model when no cheaper candidate exists (#10 MAIN_EQUIV)", async () => {
    const client = clientWithConfig({})
    const pricing: PricingCatalog = { "main/model": EXPENSIVE }
    const result = await resolveDynamicWorkerModel({
      client,
      tier: "fast",
      mainModel: "main/model",
      availableModelsOverride: new Set(["main/model"]),
      pricingCatalog: pricing,
    })
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.model).toBe("main/model")
      expect(result.usedMainModel).toBe(true)
    }
  })

  test("honors an explicit pin for the requested tier (#8)", async () => {
    const client = clientWithConfig({})
    const pricing: PricingCatalog = { "provider/pinned": FREE }
    const result = await resolveDynamicWorkerModel({
      client,
      tier: "fast",
      pinned: { fast: "provider/pinned" },
      availableModelsOverride: new Set(["provider/pinned"]),
      pricingCatalog: pricing,
    })
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.model).toBe("provider/pinned")
    }
  })

  test("ignores an explicit pin to a disabled model (#9)", async () => {
    const client = clientWithConfig({ disabled_providers: ["openai"] })
    const pricing: PricingCatalog = { "opencode/alt": FREE }
    const result = await resolveDynamicWorkerModel({
      client,
      tier: "fast",
      pinned: { fast: "openai/gpt-5.6-luna-fast" },
      availableModelsOverride: new Set(["openai/gpt-5.6-luna-fast", "opencode/alt"]),
      pricingCatalog: pricing,
    })
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.model).not.toBe("openai/gpt-5.6-luna-fast")
    }
  })

  test("reports no-eligible-candidate with an empty live pool (#11)", async () => {
    const client = clientWithConfig({ disabled_providers: ["openai"] })
    const result = await resolveDynamicWorkerModel({
      client,
      tier: "strong",
      availableModelsOverride: new Set(["openai/gpt-6-astra"]),
      pricingCatalog: { "openai/gpt-6-astra": EXPENSIVE },
    })
    expect(result.kind).toBe("no-eligible-candidate")
    if (result.kind === "no-eligible-candidate") {
      expect(result.livePoolEmpty).toBe(true)
    }
  })
})

describe("buildModelRoutingPins", () => {
  test("derives explicit pins only from model_routing.tiers.*.model", () => {
    expect(buildModelRoutingPins(undefined)).toEqual({})
    expect(buildModelRoutingPins({ tiers: { fast: { model: "provider/fast" }, master: { model: "provider/master", inherit_parent: false } } }))
      .toEqual({ fast: "provider/fast", master: "provider/master" })
    expect(buildModelRoutingPins({ tiers: { master: { model: "provider/master" } } })).toEqual({})
  })
})
