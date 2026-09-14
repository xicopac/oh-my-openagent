import { describe, test, expect, mock } from "bun:test"
import { createCallOmoAgent } from "./tools"
import { clearCallableAgentsCache } from "./agent-resolver"
import { ResourceGovernorConfigSchema } from "../../config/schema/resource-governor"
import { createResourceGovernorRuntime } from "../../hooks/resource-governor"

function exhaustedRuntime() {
  const runtime = createResourceGovernorRuntime({
    config: ResourceGovernorConfigSchema.parse({}),
    pricing: {},
  })
  runtime.recordRootUsage("test", {
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

describe("call_omo_agent sync enforcement", () => {
  test("blocks a paid child past the hard ceiling before reserving a spawn slot", async () => {
    clearCallableAgentsCache()
    const reserveSubagentSpawn = mock(async () => ({
      spawnContext: { rootSessionID: "root", parentDepth: 0, childDepth: 1 },
      descendantCount: 1,
      commit: () => 1,
      rollback: () => {},
    }))
    const ctx = {
      client: {
        app: { agents: async () => ({ data: [{ name: "explore", mode: "subagent" }] }) },
      } as never,
      directory: "/test",
    }
    const backgroundManager = {
      reserveSubagentSpawn,
      launch: async () => ({ id: "t", status: "pending" }),
    } as never

    const tool = createCallOmoAgent(
      ctx as never,
      backgroundManager,
      [],
      { explore: { model: "openai/gpt-5.6-sol" } },
      undefined,
      undefined,
      exhaustedRuntime(),
    )

    const result = await tool.execute(
      { description: "blocked", prompt: "trace login", subagent_type: "explore", run_in_background: false },
      { sessionID: "test", messageID: "msg", agent: "sisyphus", abort: new AbortController().signal },
    )

    expect(result).toContain("RESOURCE_BUDGET_EXHAUSTED")
    expect(reserveSubagentSpawn).not.toHaveBeenCalled()
  })
})
