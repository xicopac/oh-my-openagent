import { describe, expect, test } from "bun:test"
import { resolveModelPipeline } from "@oh-my-opencode/model-core"
import {
  AGENT_MODEL_REQUIREMENTS,
  CATEGORY_MODEL_REQUIREMENTS,
} from "../../shared/model-requirements"
import type { PricingCatalog } from "../../hooks/resource-governor"
import { resolveDynamicWorkerModel } from "./dynamic-model-resolver"
import type { OpencodeClient } from "./types"

const FLASH = "opencode/deepseek-v4-flash"
const GPT_OLD = "openai/gpt-old"
const FALLBACK_1 = "opencode/fallback-1"
const MAIN = "opencode/main-model"

const FLASH_PRICE = { input: 0.3, output: 0.9, cache_read: 0, cache_write: 0 }
const GPT_OLD_PRICE = { input: 2.0, output: 6.0, cache_read: 0, cache_write: 0 }
const FALLBACK_1_PRICE = { input: 0.5, output: 1.5, cache_read: 0, cache_write: 0 }
const MAIN_PRICE = { input: 10, output: 30, cache_read: 0, cache_write: 0 }

const CATALOG = new Set([FLASH, GPT_OLD, FALLBACK_1])

const PRICING: PricingCatalog = {
  [FLASH]: FLASH_PRICE,
  [GPT_OLD]: GPT_OLD_PRICE,
  [FALLBACK_1]: FALLBACK_1_PRICE,
  [MAIN]: MAIN_PRICE,
}

function clientWithConfig(config: Record<string, unknown>): OpencodeClient {
  return {
    app: { agents: async () => ({}) },
    config: { get: async () => ({ data: config }) },
  } as unknown as OpencodeClient
}

async function resolveTier(tier: "fast" | "balanced" | "strong" | "master", extraUnavailable?: string[]) {
  const result = await resolveDynamicWorkerModel({
    client: clientWithConfig({}),
    tier,
    mainModel: MAIN,
    availableModelsOverride: CATALOG,
    pricingCatalog: PRICING,
    extraUnavailable,
  })
  expect(result.kind).toBe("resolved")
  if (result.kind !== "resolved") throw new Error("Expected resolved")
  return result.model
}

/**
 * Routing-default contract for child agents and tiers.
 *
 * Plain DeepSeek V4 Flash (`deepseek-v4-flash` in chains, `opencode/deepseek-v4-flash` as the
 * concrete registered key) is the preferred default for delegated children and the
 * balanced/strong/master tiers. This is a two-part contract:
 *  - The legacy chain first rungs lead with Flash for explore, librarian, sisyphus-junior and the
 *    high-capability categories (ultrabrain, deep, unspecified-high, unspecified-low).
 *  - The dynamic band resolver selects Flash from a controlled enabled pool unless it is disabled,
 *    in which case the next legitimate candidate wins and a disabled GPT-old model is never picked.
 */
describe("child routing defaults prefer plain DeepSeek V4 Flash", () => {
  test("legacy chain first rungs lead with plain Flash for child agents and high-capability categories", () => {
    // given
    const agentNames = ["explore", "librarian", "sisyphus-junior"] as const
    const categoryNames = ["ultrabrain", "deep", "unspecified-high", "unspecified-low"] as const

    // when / then - every child first rung is plain deepseek-v4-flash at max
    for (const name of agentNames) {
      expect(AGENT_MODEL_REQUIREMENTS[name].fallbackChain[0]).toEqual({
        providers: ["deepseek"],
        model: "deepseek-v4-flash",
        variant: "max",
      })
    }
    for (const name of categoryNames) {
      expect(CATEGORY_MODEL_REQUIREMENTS[name].fallbackChain[0]).toEqual({
        providers: ["deepseek", "opencode-go"],
        model: "deepseek-v4-flash",
        variant: "max",
      })
    }
  })

  test("balanced and strong tiers resolve to Flash from a controlled enabled catalog", async () => {
    // given - nothing quarantined: Flash, GPT-old, and fallback-1 are all enabled and paid

    // when / then - cheapest paid and strongest paid both land on Flash
    expect(await resolveTier("balanced")).toBe(FLASH)
    expect(await resolveTier("strong")).toBe(FLASH)
  })

  test("master tier resolves to Flash when the parent/main model is Flash", async () => {
    // given
    const result = await resolveDynamicWorkerModel({
      client: clientWithConfig({}),
      tier: "master",
      mainModel: FLASH,
      availableModelsOverride: CATALOG,
      pricingCatalog: PRICING,
    })

    // when / then - main_equiv inherits the parent model
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.model).toBe(FLASH)
      expect(result.usedMainModel).toBe(true)
    }
  })

  test("a disabled GPT-old model is never selected, even when pinned", async () => {
    // given - GPT-old quarantined via the runtime unavailable set
    const disabled = new Set([GPT_OLD])

    // when
    const balanced = await resolveDynamicWorkerModel({
      client: clientWithConfig({}),
      tier: "balanced",
      mainModel: MAIN,
      availableModelsOverride: CATALOG,
      pricingCatalog: PRICING,
      extraUnavailable: disabled,
    })
    const pinned = await resolveDynamicWorkerModel({
      client: clientWithConfig({}),
      tier: "fast",
      pinned: { fast: GPT_OLD },
      mainModel: MAIN,
      availableModelsOverride: CATALOG,
      pricingCatalog: PRICING,
      extraUnavailable: disabled,
    })

    // then - GPT-old never wins; Flash is the next legitimate candidate
    expect(balanced.kind).toBe("resolved")
    if (balanced.kind === "resolved") expect(balanced.model).not.toBe(GPT_OLD)
    expect(pinned.kind).toBe("resolved")
    if (pinned.kind === "resolved") {
      expect(pinned.model).not.toBe(GPT_OLD)
      expect(pinned.model).toBe(FLASH)
    }
  })

  test("a disabled Flash falls back to the next legitimate candidate, not Flash again", async () => {
    // given - Flash quarantined
    const disabled = new Set([FLASH])

    // when
    const balanced = await resolveDynamicWorkerModel({
      client: clientWithConfig({}),
      tier: "balanced",
      mainModel: MAIN,
      availableModelsOverride: CATALOG,
      pricingCatalog: PRICING,
      extraUnavailable: disabled,
    })

    // then - cheapest remaining paid model wins instead
    expect(balanced.kind).toBe("resolved")
    if (balanced.kind === "resolved") {
      expect(balanced.model).not.toBe(FLASH)
      expect(balanced.model).toBe(FALLBACK_1)
    }
  })

  test("legacy chain failover skips an unavailable Flash rung and picks the next rung", () => {
    // given - Flash absent from the availability set
    const sisyphusJunior = resolveModelPipeline({
      intent: {},
      constraints: { availableModels: new Set(["anthropic/claude-sonnet-5"]) },
      policy: { fallbackChain: AGENT_MODEL_REQUIREMENTS["sisyphus-junior"].fallbackChain },
    })

    // then - the next rung (claude-sonnet-5) is selected, never Flash
    expect(sisyphusJunior?.model).toBe("anthropic/claude-sonnet-5")
    expect(sisyphusJunior?.provenance).toBe("provider-fallback")

    // given - explore chain with Luna available but Flash absent
    const explore = resolveModelPipeline({
      intent: {},
      constraints: { availableModels: new Set(["openai/gpt-5.6-luna-fast"]) },
      policy: { fallbackChain: AGENT_MODEL_REQUIREMENTS["explore"].fallbackChain },
    })

    // then - the Luna rung is the failover
    expect(explore?.model).toBe("openai/gpt-5.6-luna-fast")
  })
})