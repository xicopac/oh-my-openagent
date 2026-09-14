import { describe, expect, test } from "bun:test"
import { resolveModelTier, MODEL_TIERS, type ModelTierRoutingConfig } from "./model-tier"

const REGISTRY = new Set<string>([
  "opencode/nemotron-3.5-lightning-free",
  "opencode/mimo-v2.5-free",
  "opencode/deepseek-v4-pro",
])

function config(tiers?: ModelTierRoutingConfig["tiers"], enabled = true): ModelTierRoutingConfig {
  return { enabled, tiers }
}

const FULL = config({
  fast: { model: "opencode/nemotron-3.5-lightning-free" },
  balanced: { model: "opencode/mimo-v2.5-free" },
  strong: { model: "opencode/deepseek-v4-pro" },
  master: { inherit_parent: true },
})

describe("resolveModelTier", () => {
  describe("#given an explicit tier that is configured and available", () => {
    test("#when resolving fast, then it returns the fast model", () => {
      const result = resolveModelTier({ tier: "fast", config: FULL, availableModels: REGISTRY })
      expect(result).not.toBeUndefined()
      expect(result?.model).toBe("opencode/nemotron-3.5-lightning-free")
      expect(result?.tier).toBe("fast")
      expect(result?.escalated).toBe(false)
      expect(result?.usedParentModel).toBe(false)
    })

    test("#when resolving strong, then it returns the strong model", () => {
      const result = resolveModelTier({ tier: "strong", config: FULL, availableModels: REGISTRY })
      expect(result?.model).toBe("opencode/deepseek-v4-pro")
    })
  })

  describe("#given a configured model that is missing from the registry", () => {
    const missingFast = config({
      fast: { model: "opencode/does-not-exist" },
      balanced: { model: "opencode/mimo-v2.5-free" },
      strong: { model: "opencode/deepseek-v4-pro" },
      master: { inherit_parent: true },
    })

    test("#when resolving fast, then it escalates to balanced", () => {
      const result = resolveModelTier({ tier: "fast", config: missingFast, availableModels: REGISTRY })
      expect(result?.tier).toBe("balanced")
      expect(result?.model).toBe("opencode/mimo-v2.5-free")
      expect(result?.escalated).toBe(true)
    })

    test("#when fast and balanced are both missing, then it escalates to strong", () => {
      const cfg = config({
        fast: { model: "opencode/missing-a" },
        balanced: { model: "opencode/missing-b" },
        strong: { model: "opencode/deepseek-v4-pro" },
        master: { inherit_parent: true },
      })
      const result = resolveModelTier({ tier: "fast", config: cfg, availableModels: REGISTRY })
      expect(result?.tier).toBe("strong")
      expect(result?.model).toBe("opencode/deepseek-v4-pro")
    })

    test("#when all lower tiers are missing, then fast escalates to the parent model via master", () => {
      const cfg = config({
        fast: { model: "opencode/missing-a" },
        balanced: { model: "opencode/missing-b" },
        strong: { model: "opencode/missing-c" },
        master: { inherit_parent: true },
      })
      const result = resolveModelTier({
        tier: "fast",
        config: cfg,
        availableModels: REGISTRY,
        parentModel: "opencode/gpt-6-astra",
      })
      expect(result?.tier).toBe("master")
      expect(result?.model).toBe("opencode/gpt-6-astra")
      expect(result?.usedParentModel).toBe(true)
    })
  })

  describe("#given master tier", () => {
    test("#when master inherits and parent model is known, then it returns the parent model", () => {
      const result = resolveModelTier({
        tier: "master",
        config: FULL,
        availableModels: REGISTRY,
        parentModel: "opencode/gpt-6-astra",
      })
      expect(result?.model).toBe("opencode/gpt-6-astra")
      expect(result?.tier).toBe("master")
      expect(result?.usedParentModel).toBe(true)
      // parent model need not be in the registry — it is what the parent already runs
    })

    test("#when master has no parent and no configured model, then it is undefined (falls through to upstream resolution)", () => {
      const result = resolveModelTier({
        tier: "master",
        config: FULL,
        availableModels: REGISTRY,
      })
      expect(result).toBeUndefined()
    })

    test("#when master has an explicit model and no parent, then it uses the configured model", () => {
      const cfg = config({
        fast: { model: "opencode/nemotron-3.5-lightning-free" },
        balanced: { model: "opencode/mimo-v2.5-free" },
        strong: { model: "opencode/deepseek-v4-pro" },
        master: { model: "opencode/deepseek-v4-pro" },
      })
      const result = resolveModelTier({ tier: "master", config: cfg, availableModels: REGISTRY })
      expect(result?.model).toBe("opencode/deepseek-v4-pro")
      expect(result?.usedParentModel).toBe(false)
    })
  })

  describe("#given a disabled or absent routing config", () => {
    test("#when enabled is false, then it returns undefined regardless of tier", () => {
      const result = resolveModelTier({
        tier: "strong",
        config: { ...FULL, enabled: false },
        availableModels: REGISTRY,
      })
      expect(result).toBeUndefined()
    })

    test("#when tiers are absent, then it returns undefined (no tier configured)", () => {
      const result = resolveModelTier({ tier: "fast", config: {}, availableModels: REGISTRY })
      expect(result).toBeUndefined()
    })

    test("#when the requested tier is unconfigured, then it escalates upward", () => {
      const cfg = config({
        balanced: { model: "opencode/mimo-v2.5-free" },
        strong: { model: "opencode/deepseek-v4-pro" },
      })
      const result = resolveModelTier({ tier: "fast", config: cfg, availableModels: REGISTRY })
      expect(result?.tier).toBe("balanced")
      expect(result?.model).toBe("opencode/mimo-v2.5-free")
    })
  })

  describe("#given a cold registry (empty)", () => {
    test("#when resolving a configured tier, then it trusts the exact configured id (never fabricates)", () => {
      const result = resolveModelTier({ tier: "fast", config: FULL, availableModels: new Set() })
      expect(result?.model).toBe("opencode/nemotron-3.5-lightning-free")
    })

    test("#when resolving master with a parent, then it returns the parent", () => {
      const result = resolveModelTier({
        tier: "master",
        config: FULL,
        availableModels: new Set(),
        parentModel: "opencode/gpt-6-astra",
      })
      expect(result?.model).toBe("opencode/gpt-6-astra")
    })
  })

  describe("MODEL_TIERS", () => {
    test("#then the enum lists exactly the four tiers in escalation order", () => {
      expect(MODEL_TIERS).toEqual(["fast", "balanced", "strong", "master"])
    })
  })
})
