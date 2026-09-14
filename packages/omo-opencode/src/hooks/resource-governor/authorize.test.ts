import { describe, test, expect } from "bun:test"
import { ResourceGovernorConfigSchema } from "../../config/schema/resource-governor"
import {
  authorizeChildDispatch,
  blockMessage,
  createResourceGovernorRuntime,
  ResourceGovernorRejectedError,
} from "./index"

function config() {
  return ResourceGovernorConfigSchema.parse({})
}

function exhaustedRuntime() {
  const runtime = createResourceGovernorRuntime({ config: config(), pricing: {} })
  runtime.recordRootUsage("parent-session", {
    model_id: "deepseek/deepseek-v4-pro",
    provider_id: "deepseek",
    tier: "master",
    free: false,
    input_tokens: 1_000_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: 3.5,
    cost_estimated: true,
    context_tokens: 1_000_000,
    retries: 0,
    status: "active",
    avoidable_tokens: 0,
  })
  return runtime
}

describe("authorizeChildDispatch", () => {
  test("maps a hard paid ceiling to BLOCK with a message", () => {
    const result = authorizeChildDispatch(exhaustedRuntime(), {
      sessionID: "parent-session",
      role: "explore",
      subtask: "trace the login path",
      resolvedModelID: "openai/gpt-5.6-sol",
      requestedTier: null,
      expectedTokens: 600_000,
      rootModelID: null,
    })

    expect(result.verdict).toBe("BLOCK")
    expect(blockMessage(result)).toContain("RESOURCE_BUDGET_EXHAUSTED")
  })

  test("returns ALLOW when no model is resolved (cannot enforce)", () => {
    const result = authorizeChildDispatch(exhaustedRuntime(), {
      sessionID: "parent-session",
      role: "explore",
      subtask: "trace",
      resolvedModelID: null,
      requestedTier: null,
      expectedTokens: 600_000,
      rootModelID: null,
    })

    expect(result.verdict).toBe("ALLOW")
    expect(blockMessage(result)).toBeNull()
  })

  test("ResourceGovernorRejectedError names and carries the message", () => {
    const error = new ResourceGovernorRejectedError("blocked")
    expect(error.name).toBe("ResourceGovernorRejectedError")
    expect(error.message).toBe("blocked")
  })
})
