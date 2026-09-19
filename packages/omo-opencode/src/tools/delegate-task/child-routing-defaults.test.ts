import { describe, expect, test } from "bun:test"
import {
  AGENT_MODEL_REQUIREMENTS,
  AGENT_ROLE_REQUIREMENTS,
  CATEGORY_MODEL_REQUIREMENTS,
} from "../../shared/model-requirements"
import type { PricingCatalog } from "../../hooks/resource-governor"
import { resolveDynamicWorkerModel } from "./dynamic-model-resolver"
import type { OpencodeClient } from "./types"

const FLASH = "opencode/deepseek-v4-flash"
const GPT_OLD = "openai/gpt-old"
const FALLBACK_1 = "opencode/fallback-1"
const MAIN = "opencode/main-model"
const FREE = "opencode/free-model"
const FREE_ALT = "opencode/free-model-2"

const FLASH_PRICE = { input: 0.3, output: 0.9, cache_read: 0, cache_write: 0 }
const GPT_OLD_PRICE = { input: 2.0, output: 6.0, cache_read: 0, cache_write: 0 }
const FALLBACK_1_PRICE = { input: 0.5, output: 1.5, cache_read: 0, cache_write: 0 }
const MAIN_PRICE = { input: 10, output: 30, cache_read: 0, cache_write: 0 }
const FREE_PRICE = { input: 0, output: 0, cache_read: 0, cache_write: 0 }

const CATALOG = new Set([FLASH, GPT_OLD, FALLBACK_1, FREE])

const PRICING: PricingCatalog = {
  [FLASH]: FLASH_PRICE,
  [GPT_OLD]: GPT_OLD_PRICE,
  [FALLBACK_1]: FALLBACK_1_PRICE,
  [MAIN]: MAIN_PRICE,
  [FREE]: FREE_PRICE,
  [FREE_ALT]: FREE_PRICE,
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
 * Ordinary child workers (explore, librarian, sisyphus-junior and the balanced tier) are
 * FREE-FIRST: they prefer the best-eligible free model and escalate to paid bands only after
 * the free pool is exhausted. Plain DeepSeek V4 Flash (`opencode/deepseek-v4-flash`) remains a
 * paid strong-tier candidate and the master-tier parent inheritance, but it must never lead a
 * legacy child chain nor preempt the free pool. This is a two-part contract:
 *  - The legacy chain first rungs lead with their pre-Flash models (gpt-5.6-luna-fast for
 *    explore/librarian, claude-sonnet-5 for sisyphus-junior, gpt-6-astra for the high-capability
 *    categories, grok-4.6 for unspecified-low), and the sisyphus-junior chain carries no Flash
 *    rung at all.
 *  - The dynamic band resolver picks a free model for balanced, keeps strong on paid Flash,
 *    fails over between free models when one is disabled, and only escalates balanced to paid
 *    Flash once every free candidate is unavailable.
 */
describe("child routing defaults prefer best-eligible free models", () => {
  test("legacy chain first rungs are NOT Flash-first for child agents and high-capability categories", () => {
    // given - the hardcoded agent/category fallback chains

    // when / then - ordinary child agents lead with their pre-Flash first rungs
    expect(AGENT_MODEL_REQUIREMENTS.explore.fallbackChain[0]).toEqual({
      providers: ["openai", "openai-codex"],
      model: "gpt-5.6-luna-fast",
      variant: "low",
    })
    expect(AGENT_MODEL_REQUIREMENTS.librarian.fallbackChain[0]).toEqual({
      providers: ["openai", "openai-codex"],
      model: "gpt-5.6-luna-fast",
      variant: "low",
    })
    expect(AGENT_MODEL_REQUIREMENTS["sisyphus-junior"].fallbackChain[0]).toEqual({
      providers: ["anthropic", "github-copilot", "opencode"],
      model: "claude-sonnet-5",
    })
    expect(
      AGENT_MODEL_REQUIREMENTS["sisyphus-junior"].fallbackChain.some(
        (rung) => rung.model === "deepseek-v4-flash",
      ),
    ).toBe(false)

    // and the high-capability categories lead with their pre-Flash first rungs
    expect(CATEGORY_MODEL_REQUIREMENTS.ultrabrain.fallbackChain[0]).toEqual({
      providers: ["openai", "openai-codex"],
      model: "gpt-6-astra",
      variant: "max",
    })
    expect(CATEGORY_MODEL_REQUIREMENTS.deep.fallbackChain[0]).toEqual({
      providers: ["openai", "openai-codex", "github-copilot", "opencode"],
      model: "gpt-6-astra",
      variant: "high",
    })
    expect(CATEGORY_MODEL_REQUIREMENTS["unspecified-high"].fallbackChain[0]).toEqual({
      providers: ["openai", "openai-codex", "github-copilot", "opencode"],
      model: "gpt-6-astra",
      variant: "high",
    })
    expect(CATEGORY_MODEL_REQUIREMENTS["unspecified-low"].fallbackChain[0]).toEqual({
      providers: ["xai", "github-copilot", "opencode"],
      model: "grok-4.6",
      variant: "xhigh",
    })
  })

  test("balanced tier resolves to a free model while strong stays free without paid permission", async () => {
    // given - a controlled enabled pool: one free model plus paid Flash, GPT-old, and fallback-1

    // when / then - balanced and strong are both free-first under the cost-safety default
    expect(await resolveTier("balanced")).toBe(FREE)
    expect(await resolveTier("strong")).toBe(FREE)
  })

  test("a disabled free model falls back to another free model, not Flash", async () => {
    // given - a second free model in the pool, and the first free model unavailable
    const catalog = new Set([...CATALOG, FREE_ALT])

    // when
    const result = await resolveDynamicWorkerModel({
      client: clientWithConfig({}),
      tier: "balanced",
      mainModel: MAIN,
      availableModelsOverride: catalog,
      pricingCatalog: PRICING,
      extraUnavailable: [FREE],
    })

    // then - the second free model wins; paid Flash is only an escalation rung
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.model).toBe(FREE_ALT)
      expect(result.model).not.toBe(FLASH)
    }
  })

  test("master tier without paid permission resolves to a free model, never Flash", async () => {
    // given - the parent runs plain Flash, but the child has no paid permission

    // when
    const result = await resolveDynamicWorkerModel({
      client: clientWithConfig({}),
      tier: "master",
      mainModel: FLASH,
      availableModelsOverride: CATALOG,
      pricingCatalog: PRICING,
    })

    // then - COST-SAFETY: master tier does not imply paid permission
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.model).toBe(FREE)
      expect(result.model).not.toBe(FLASH)
      expect(result.usedMainModel).toBe(false)
    }
  })

  test("a disabled model is never selected, even when pinned", async () => {
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

    // then - GPT-old never wins; the free pool serves both the plain and the pinned request
    expect(balanced.kind).toBe("resolved")
    if (balanced.kind === "resolved") expect(balanced.model).not.toBe(GPT_OLD)
    expect(pinned.kind).toBe("resolved")
    if (pinned.kind === "resolved") {
      expect(pinned.model).not.toBe(GPT_OLD)
      expect(pinned.model).toBe(FREE)
    }
  })

  test("free-pool exhaustion escalates balanced to a paid model only after every free candidate is unavailable", async () => {
    // given - every free candidate in the pool is quarantined
    const exhausted = new Set([FREE])

    // when
    const balanced = await resolveDynamicWorkerModel({
      client: clientWithConfig({}),
      tier: "balanced",
      mainModel: MAIN,
      availableModelsOverride: CATALOG,
      pricingCatalog: PRICING,
      extraUnavailable: exhausted,
    })

    // then - COST-SAFETY: a free-only child returns NO_ELIGIBLE_FREE_MODEL; no
    // automatic paid escalation without explicit allow_paid_workers.
    expect(balanced.kind).toBe("no-eligible-candidate")

    // and when paid permission is explicitly granted, balanced may escalate to Flash
    const paid = await resolveDynamicWorkerModel({
      client: clientWithConfig({}),
      tier: "balanced",
      mainModel: MAIN,
      availableModelsOverride: CATALOG,
      pricingCatalog: PRICING,
      extraUnavailable: exhausted,
      allowPaidWorkers: true,
    })
    expect(paid.kind).toBe("resolved")
    if (paid.kind === "resolved") {
      expect(paid.model).toBe(FLASH)
      expect(paid.escalated).toBe(true)
    }
  })
})

const FREE_FAST_1 = "opencode/free-fast-1"
const FREE_GENERAL_1 = "opencode/free-general-1"
const FREE_GENERAL_2 = "opencode/free-general-2"
const GPT_PAID = "openai/gpt-paid"
const GPT_PAID_PRICE = { input: 2.0, output: 6.0, cache_read: 0, cache_write: 0 }

const MATRIX_CATALOG = new Set([FREE_FAST_1, FREE_GENERAL_1, FREE_GENERAL_2, FLASH, GPT_PAID])
const MATRIX_PRICING: PricingCatalog = {
  ...PRICING,
  [FREE_FAST_1]: FREE_PRICE,
  [FREE_GENERAL_1]: FREE_PRICE,
  [FREE_GENERAL_2]: FREE_PRICE,
  [GPT_PAID]: GPT_PAID_PRICE,
}
const MATRIX_FREE_POOL = new Set([FREE_FAST_1, FREE_GENERAL_1, FREE_GENERAL_2])

type MatrixTier = "fast" | "balanced" | "strong" | "master"

async function resolveMatrixRow(tier: MatrixTier, mainModel: string, allowPaidWorkers = false) {
  const result = await resolveDynamicWorkerModel({
    client: clientWithConfig({}),
    tier,
    mainModel,
    availableModelsOverride: MATRIX_CATALOG,
    pricingCatalog: MATRIX_PRICING,
    allowPaidWorkers,
  })
  expect(result.kind).toBe("resolved")
  if (result.kind !== "resolved") throw new Error("Expected resolved")
  return result
}

/**
 * Routing cost matrix over a controlled catalog with three free models
 * (free-fast-1, free-general-1, free-general-2) and two paid models
 * (deepseek-v4-flash, gpt-paid). Ordinary child roles (explore, librarian,
 * general, sisyphus-junior, the balanced tier) are free-first and must land in
 * the "free" band; the root, strong, master, and strongest rows must stay on
 * paid models (Flash / gpt-paid) in the strong_paid or main_equiv bands.
 */
describe("routing cost matrix", () => {
  test("ordinary children resolve free while root, strong, and master stay paid", async () => {
    // given - the role-declared default tiers for the named agents
    expect(AGENT_ROLE_REQUIREMENTS.sisyphus.defaultTier).toBe("strong")
    expect(AGENT_ROLE_REQUIREMENTS.explore.defaultTier).toBe("fast")
    expect(AGENT_ROLE_REQUIREMENTS.librarian.defaultTier).toBe("fast")
    expect(AGENT_ROLE_REQUIREMENTS.general.defaultTier).toBe("balanced")
    expect(AGENT_ROLE_REQUIREMENTS["sisyphus-junior"].defaultTier).toBe("balanced")
    // and the legacy explore chain still leads with gpt-5.6-luna-fast low
    expect(AGENT_MODEL_REQUIREMENTS.explore.fallbackChain[0]).toEqual({
      providers: ["openai", "openai-codex"],
      model: "gpt-5.6-luna-fast",
      variant: "low",
    })

    // when - every row of the matrix is resolved against the controlled catalog
    const rows: Array<{ label: string; tier: MatrixTier; mainModel: string }> = [
      { label: "root sisyphus", tier: AGENT_ROLE_REQUIREMENTS.sisyphus.defaultTier, mainModel: FLASH },
      { label: "explore", tier: AGENT_ROLE_REQUIREMENTS.explore.defaultTier, mainModel: MAIN },
      { label: "librarian", tier: AGENT_ROLE_REQUIREMENTS.librarian.defaultTier, mainModel: MAIN },
      { label: "general", tier: AGENT_ROLE_REQUIREMENTS.general.defaultTier, mainModel: MAIN },
      { label: "sisyphus-junior", tier: AGENT_ROLE_REQUIREMENTS["sisyphus-junior"].defaultTier, mainModel: MAIN },
      { label: "balanced", tier: "balanced", mainModel: MAIN },
      { label: "master", tier: "master", mainModel: FLASH },
      { label: "strong", tier: "strong", mainModel: MAIN },
      { label: "strongest", tier: "master", mainModel: GPT_PAID },
    ]
    const resolvedRows = new Map<string, Awaited<ReturnType<typeof resolveMatrixRow>>>()
    for (const row of rows) {
      const allowPaid = row.label === "root sisyphus" || row.label === "master" || row.label === "strong" || row.label === "strongest"
      const resolved = await resolveMatrixRow(row.tier, row.mainModel, allowPaid)
      resolvedRows.set(row.label, resolved)
      console.log(`matrix ${row.label}: tier=${row.tier} main=${row.mainModel} -> model=${resolved.model} band=${resolved.band}`)
    }
    const row = (label: string) => {
      const resolved = resolvedRows.get(label)
      if (!resolved) throw new Error(`missing matrix row ${label}`)
      return resolved
    }

    // then - ordinary child rows are free-band and never consume paid Flash
    for (const label of ["explore", "librarian", "general", "sisyphus-junior", "balanced"]) {
      expect(row(label).band).toBe("free")
      expect(MATRIX_FREE_POOL.has(row(label).model)).toBe(true)
      expect(row(label).model).not.toBe(FLASH)
      expect(row(label).model).not.toBe(GPT_PAID)
    }

    // and the root stays on paid Flash (strong request escalates to its own main equivalence)
    expect(row("root sisyphus").model === FLASH || row("root sisyphus").model === GPT_PAID).toBe(true)
    expect(row("root sisyphus").band).not.toBe("free")

    // and master inherits the parent Flash via main_equiv
    expect(row("master").model).toBe(FLASH)
    expect(row("master").band).toBe("main_equiv")
    expect(row("master").usedMainModel).toBe(true)

    // and strong resolves to the cheapest paid strong model (Flash)
    expect(row("strong").model).toBe(FLASH)
    expect(row("strong").band).toBe("strong_paid")

    // and the strongest row (master tier over a strong paid parent) inherits that paid parent
    expect(row("strongest").model).toBe(GPT_PAID)
    expect(row("strongest").band).toBe("main_equiv")
    expect(row("strongest").usedMainModel).toBe(true)
  })
})
