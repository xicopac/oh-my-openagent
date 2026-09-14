import { describe, expect, test } from "bun:test"
import { ResourceGovernorConfigSchema } from "../../config/schema/resource-governor"
import { createResourceGovernorRuntime } from "./runtime"
import type { ResourceGovernorEvent } from "./events"
import type { PricingCatalog } from "./pricing"
import type { DelegateEnforcementInput } from "./runtime"

const catalog: PricingCatalog = {
  "vendor/free": { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  "vendor/expensive": { input: 5, output: 25, cache_read: 0, cache_write: 0 },
}

function input(overrides: Partial<DelegateEnforcementInput> = {}): DelegateEnforcementInput {
  return {
    sessionID: "session-1",
    role: "explorer",
    subtask: "trace auth",
    resolvedModelID: "vendor/expensive",
    requestedTier: null,
    expectedTokens: 300_000,
    rootModelID: null,
    ...overrides,
  }
}

describe("resource governor events", () => {
  test("emits resource-hard-limit when a paid child is blocked", () => {
    const events: { event: ResourceGovernorEvent; detail?: Record<string, unknown> }[] = []
    const runtime = createResourceGovernorRuntime({
      config: ResourceGovernorConfigSchema.parse({}),
      pricing: catalog,
      onEvent: (_sid, event, detail) => events.push({ event, detail }),
    })
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

    runtime.enforce(input())

    expect(events.some((e) => e.event === "resource-hard-limit")).toBe(true)
  })

  test("emits routing-free-preferred when a free child is approved", () => {
    const events: ResourceGovernorEvent[] = []
    const runtime = createResourceGovernorRuntime({
      config: ResourceGovernorConfigSchema.parse({}),
      pricing: catalog,
      onEvent: (_sid, event) => events.push(event),
    })
    runtime.enforce(input({ resolvedModelID: "vendor/free" }))
    expect(events).toContain("routing-free-preferred")
  })
})
