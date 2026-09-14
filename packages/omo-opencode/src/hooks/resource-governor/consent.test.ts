import { describe, expect, test } from "bun:test"
import { ResourceGovernorConfigSchema, type ResourceGovernorConfig } from "../../config/schema/resource-governor"
import { createResourceGovernorRuntime, authorizeChildDispatch, blockMessage } from "./index"
import type { ModelPricing, PricingCatalog } from "./pricing"
import type { DelegateEnforcementInput } from "./runtime"

const CHEAP: ModelPricing = { input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 }
const EXPENSIVE: ModelPricing = { input: 5, output: 25, cache_read: 0, cache_write: 0 }
const catalog: PricingCatalog = { "vendor/cheap": CHEAP, "vendor/expensive": EXPENSIVE }

function config(): ResourceGovernorConfig {
  return ResourceGovernorConfigSchema.parse({}) as ResourceGovernorConfig
}

function input(overrides: Partial<DelegateEnforcementInput> = {}): DelegateEnforcementInput {
  return {
    sessionID: "session-1",
    role: "explorer",
    subtask: "trace auth",
    resolvedModelID: "vendor/expensive",
    requestedTier: null,
    expectedTokens: 300_000,
    rootModelID: "vendor/cheap",
    ...overrides,
  }
}

describe("consent path", () => {
  test("the model cannot self-approve an escalation; only approveEscalation can", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })

    // a paid child more expensive than the root requires consent
    expect(runtime.enforce(input())?.kind).toBe("consent_required")
    // retrying does not auto-approve
    expect(runtime.enforce(input())?.kind).toBe("consent_required")

    // a human approves the bounded escalation
    runtime.approveEscalation("session-1")
    expect(runtime.enforce(input())?.kind).toBe("approved")
  })

  test("increaseBudget raises the hard paid ceiling past a block", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    runtime.recordRootUsage("session-1", {
      model_id: "vendor/expensive",
      provider_id: "vendor",
      tier: "master",
      free: false,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      cost_usd: 3.0,
      cost_estimated: true,
      context_tokens: 0,
      retries: 0,
      status: "active",
      avoidable_tokens: 0,
    })

    expect(runtime.enforce(input())?.kind).toBe("blocked")

    runtime.increaseBudget("session-1", { hard_usd: 10 })
    expect(runtime.enforce(input())?.kind).not.toBe("blocked")
  })

  test("consent_required surfaces a clear message via authorizeChildDispatch", () => {
    const runtime = createResourceGovernorRuntime({ config: config(), pricing: catalog })
    const result = authorizeChildDispatch(runtime, input())
    expect(result.verdict).toBe("REQUIRE_CONSENT")
    expect(blockMessage(result)).toContain("consent required")
  })
})
