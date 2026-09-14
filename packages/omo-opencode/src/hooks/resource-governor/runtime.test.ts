import { describe, expect, test } from "bun:test"

import { ResourceGovernorConfigSchema, type ResourceGovernorConfig } from "../../config/schema/resource-governor"
import type { ModelPricing, PricingCatalog } from "./pricing"
import {
  createResourceGovernorRuntime,
  enforcementError,
  loadPricingCatalog,
  type DelegateEnforcementInput,
} from "./runtime"

const FREE: ModelPricing = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const CHEAP: ModelPricing = { input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 }
const EXPENSIVE: ModelPricing = { input: 5, output: 25, cache_read: 0, cache_write: 0 }

const catalog: PricingCatalog = {
  "vendor/free": FREE,
  "vendor/cheap": CHEAP,
  "vendor/expensive": EXPENSIVE,
}

function config(overrides: Partial<ResourceGovernorConfig> = {}): ResourceGovernorConfig {
  return { ...ResourceGovernorConfigSchema.parse({}), ...overrides } as ResourceGovernorConfig
}

function enforcementInput(overrides: Partial<DelegateEnforcementInput> = {}): DelegateEnforcementInput {
  return {
    sessionID: "session-1",
    role: "explorer",
    subtask: "map the repository layout",
    resolvedModelID: "vendor/expensive",
    requestedTier: null,
    expectedTokens: 300_000,
    rootModelID: "vendor/cheap",
    ...overrides,
  }
}

describe("loadPricingCatalog", () => {
  test("loads bundled OpenGateway cost metadata into a PricingCatalog", () => {
    const pricing = loadPricingCatalog()
    // The catalog has dozens of entries with real USD/M cost values.
    expect(Object.keys(pricing).length).toBeGreaterThan(20)
    expect(pricing["deepseek/deepseek-v4-pro"]).toBeDefined()
    const deepseek = pricing["deepseek/deepseek-v4-pro"]
    expect(deepseek.input).toBeGreaterThan(0)
    expect(deepseek.output).toBeGreaterThan(0)
  })
})

describe("runtime enforcement", () => {
  test("blocks a paid child once the hard paid ceiling is reached", () => {
    const runtime = createResourceGovernorRuntime({
      config: config({ require_paid_escalation: false } as Partial<ResourceGovernorConfig> as ResourceGovernorConfig),
      pricing: catalog,
    })
    runtime.recordRootUsage("session-1", rootUsageRecord(3.0, 12_000_000))
    const decision = runtime.enforce(enforcementInput({ resolvedModelID: "vendor/expensive" }))
    expect(decision?.kind).toBe("blocked")
    if (decision?.kind === "blocked") expect(decision.condition).toBe("RESOURCE_BUDGET_EXHAUSTED")
  })

  test("blocks a paid child once the hard token ceiling is reached", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    runtime.recordRootUsage("session-1", rootUsageRecord(0, 12_000_000))
    const decision = runtime.enforce(enforcementInput({ resolvedModelID: "vendor/expensive" }))
    expect(decision?.kind).toBe("blocked")
    if (decision?.kind === "blocked") expect(decision.condition).toBe("TOKEN_BUDGET_EXHAUSTED")
  })

  test("approves a paid child within budget when no escalation is required", () => {
    const runtime = createResourceGovernorRuntime({ config: config({ paid: config().paid }), pricing: catalog })
    // require_paid_escalation defaults true; a child cheaper than root needs no consent.
    const decision = runtime.enforce(enforcementInput({ resolvedModelID: "vendor/cheap", rootModelID: "vendor/expensive" }))
    expect(decision?.kind).toBe("approved")
  })

  test("requires consent when a paid child escalates past the root model", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    const decision = runtime.enforce(
      enforcementInput({ resolvedModelID: "vendor/expensive", rootModelID: "vendor/cheap" }),
    )
    expect(decision?.kind).toBe("consent_required")
  })

  test("allows a free child regardless of ceiling pressure", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    runtime.recordRootUsage("session-1", rootUsageRecord(3.0, 12_000_000))
    const decision = runtime.enforce(enforcementInput({ resolvedModelID: "vendor/free" }))
    expect(decision?.kind).toBe("approved")
    if (decision?.kind === "approved") expect(decision.free).toBe(true)
  })

  test("prevents duplicate work across dispatches in one session", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    runtime.enforce(enforcementInput({ resolvedModelID: "vendor/cheap", rootModelID: "vendor/expensive" }))
    const second = runtime.enforce(enforcementInput({ resolvedModelID: "vendor/cheap", rootModelID: "vendor/expensive" }))
    expect(second?.kind).toBe("duplicate")
  })

  test("passes through when no model is resolved", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    expect(runtime.enforce(enforcementInput({ resolvedModelID: null }))).toBeNull()
  })

  test("settles a child and drops the ledger active_child_count", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    const decision = runtime.enforce(enforcementInput({ resolvedModelID: "vendor/cheap", rootModelID: "vendor/expensive" }))
    expect(decision?.kind).toBe("approved")
    if (decision?.kind === "approved") {
      expect(runtime.totals("session-1").active_child_count).toBe(1)
      runtime.settleChild("session-1", decision.seed.escrow_id, "completed")
      expect(runtime.totals("session-1").active_child_count).toBe(0)
    }
  })

  test("uses the live active child count for the concurrency gate", () => {
    const runtime = createResourceGovernorRuntime({
      config: config(),
      pricing: catalog,
      activeChildCount: () => 4,
    })
    const decision = runtime.enforce(enforcementInput({ resolvedModelID: "vendor/cheap", rootModelID: "vendor/expensive" }))
    expect(decision?.kind).toBe("declined")
    if (decision?.kind === "declined") expect(decision.reason).toBe("max_children")
  })

  test("exposes a task-start plan and forecast-vs-actual variance", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    const plan = runtime.plan("session-1", "medium")
    expect(plan.difficulty).toBe("medium")
    expect(plan.hard_paid_ceiling_usd).toBeGreaterThan(0)

    runtime.recordRootUsage("session-1", rootUsageRecord(0, 2_000_000))
    const variance = runtime.variance("session-1")
    expect(variance).not.toBeNull()
    expect(variance?.expected_paid_usd).toBeGreaterThan(0)
  })

  test("planFromDelegation derives difficulty once and keeps the first plan", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })

    const first = runtime.planFromDelegation("session-1", 300_000)
    expect(first.difficulty).toBe("low")

    const second = runtime.planFromDelegation("session-1", 10_000_000)
    expect(second.difficulty).toBe("low")
  })

  test("a forecast plan does not override the per-child expected tokens", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    runtime.planFromDelegation("session-1", 300_000)

    const decision = runtime.enforce(
      enforcementInput({
        resolvedModelID: "vendor/cheap",
        rootModelID: "vendor/expensive",
        expectedTokens: 55_000,
      }),
    )
    expect(decision?.kind).toBe("approved")
    if (decision?.kind === "approved") {
      expect(decision.seed.expected_total_tokens).toBe(55_000)
    }
  })

  test("aggregates root and child usage in one shared ledger", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    runtime.recordRootUsage("session-1", rootUsageRecord(0, 100_000))
    const decision = runtime.enforce(enforcementInput({ resolvedModelID: "vendor/cheap", rootModelID: "vendor/expensive" }))
    expect(decision?.kind).toBe("approved")
    if (decision?.kind === "approved") {
      runtime.recordChildUsage("session-1", decision.seed.escrow_id, { tokens: 50_000, cost_usd: 0.05 })
      runtime.settleChild("session-1", decision.seed.escrow_id, "completed")
    }
    const totals = runtime.totals("session-1")
    expect(totals.total_root_tokens).toBe(100_000)
    expect(totals.child_count).toBe(1)
    expect(totals.total_tokens).toBeGreaterThan(100_000)
  })
})

describe("enforcementError", () => {
  test("returns null for a null decision", () => {
    expect(enforcementError(null)).toBeNull()
  })

  test("returns a block reason for an exhausted budget", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    runtime.recordRootUsage("session-1", rootUsageRecord(3.0, 0))
    const decision = runtime.enforce(enforcementInput({ resolvedModelID: "vendor/expensive" }))
    const error = enforcementError(decision)
    expect(error).toContain("RESOURCE_BUDGET_EXHAUSTED")
  })
})

function rootUsageRecord(costUsd: number, tokens: number) {
  return {
    model_id: "vendor/expensive",
    provider_id: "vendor",
    tier: "master",
    free: false,
    input_tokens: tokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: costUsd,
    cost_estimated: true,
    context_tokens: tokens,
    retries: 0,
    status: "active" as const,
    avoidable_tokens: 0,
  }
}
