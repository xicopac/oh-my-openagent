/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { DelegateTaskArgs } from "./types"
import type { ExecutorContext } from "./executor-types"
import { resolveSubagentExecution } from "./subagent-resolver"
import * as connectedProvidersCache from "../../shared/connected-providers-cache"
import * as loggerModule from "../../shared/logger"
import * as claudeAgentLoader from "../../features/claude-code-agent-loader"

const FREE = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const CHEAP = { input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 }

function createBaseArgs(): DelegateTaskArgs {
  return {
    description: "Explore codebase",
    prompt: "Find the auth implementation",
    run_in_background: false,
    load_skills: [],
    subagent_type: "explore",
  }
}

function createExecutorContext(
  agentsFn: () => Promise<unknown>,
  overrides?: Partial<ExecutorContext>,
): ExecutorContext {
  const client = {
    app: { agents: agentsFn },
    config: { get: async () => ({ data: { disabled_providers: ["openai"] } }) },
  } as ExecutorContext["client"]

  return {
    client,
    manager: {} as ExecutorContext["manager"],
    directory: "/tmp/test",
    ...overrides,
  }
}

describe("resolveSubagentExecution - disabled-provider baked model", () => {
  let logSpy: ReturnType<typeof spyOn>
  let readConnectedProvidersCacheSpy: ReturnType<typeof spyOn>
  let readProviderModelsCacheSpy: ReturnType<typeof spyOn>
  let loadUserAgentsSpy: ReturnType<typeof spyOn>
  let loadProjectAgentsSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    logSpy = spyOn(loggerModule, "log").mockImplementation(() => {})
    readConnectedProvidersCacheSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(["opencode"])
    readProviderModelsCacheSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
      models: { opencode: ["gpt-5.6-luna", "deepseek-v4-flash"] },
      connected: ["opencode"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    loadUserAgentsSpy = spyOn(claudeAgentLoader, "loadUserAgents").mockReturnValue({})
    loadProjectAgentsSpy = spyOn(claudeAgentLoader, "loadProjectAgents").mockReturnValue({})
  })

  afterEach(() => {
    logSpy.mockRestore()
    readConnectedProvidersCacheSpy.mockRestore()
    readProviderModelsCacheSpy.mockRestore()
    loadUserAgentsSpy.mockRestore()
    loadProjectAgentsSpy.mockRestore()
  })

  test("resolves a disabled-provider baked model through the dynamic resolver", async () => {
    //#given explore is baked with a disabled openai default, and only opencode is enabled
    const args = createBaseArgs()
    const executorCtx = createExecutorContext(
      async () => [{ name: "explore", mode: "subagent", model: "openai/gpt-5.6-luna-fast" }],
      {
        availableModelsOverride: new Set(["opencode/gpt-5.6-luna", "opencode/deepseek-v4-flash"]),
        pricingCatalog: {
          "opencode/gpt-5.6-luna": FREE,
          "opencode/deepseek-v4-flash": CHEAP,
        },
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then the stale openai model is not resurrected; an enabled opencode model wins
    expect(result.error).toBeUndefined()
    expect(result.agentToUse).toBe("explore")
    expect(result.categoryModel).toBeDefined()
    expect(result.categoryModel?.providerID).toBe("opencode")
    expect(result.categoryModel?.modelID).not.toContain("openai")
  })

  test("an enabled matched model is still reached through the dynamic resolver when it is the free-band winner", async () => {
    //#given explore is baked with an enabled opencode model that is also the free-band winner
    const args = createBaseArgs()
    const executorCtx = createExecutorContext(
      async () => [{ name: "explore", mode: "subagent", model: "opencode/gpt-5.6-luna" }],
      {
        availableModelsOverride: new Set(["opencode/gpt-5.6-luna", "opencode/deepseek-v4-flash"]),
        pricingCatalog: {
          "opencode/gpt-5.6-luna": FREE,
          "opencode/deepseek-v4-flash": CHEAP,
        },
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then the dynamic resolver lands on the same free model
    expect(result.error).toBeUndefined()
    expect(result.agentToUse).toBe("explore")
    expect(result.categoryModel).toEqual({ providerID: "opencode", modelID: "gpt-5.6-luna" })
  })

  test("free-first: a usable PAID matched model loses to the dynamic free band", async () => {
    //#given explore is baked with a usable PAID model, and a free model exists in the pool
    const args = createBaseArgs()
    const executorCtx = createExecutorContext(
      async () => [{ name: "explore", mode: "subagent", model: "opencode/deepseek-v4-flash" }],
      {
        availableModelsOverride: new Set(["opencode/gpt-5.6-luna", "opencode/deepseek-v4-flash"]),
        pricingCatalog: {
          "opencode/gpt-5.6-luna": FREE,
          "opencode/deepseek-v4-flash": CHEAP,
        },
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then the dynamic free-band resolver wins over the static paid model
    expect(result.error).toBeUndefined()
    expect(result.agentToUse).toBe("explore")
    expect(result.categoryModel).toEqual({ providerID: "opencode", modelID: "gpt-5.6-luna" })
    expect(logSpy).toHaveBeenCalledWith(
      "[delegate-task] resolved subagent model dynamically",
      expect.objectContaining({ agent: "explore", band: "free", model: "opencode/gpt-5.6-luna" }),
    )
  })

  test("an explicit agent override model still wins over the dynamic free band", async () => {
    //#given explore is pinned by the user to a paid model while a free model exists
    const args = createBaseArgs()
    const executorCtx = createExecutorContext(
      async () => [{ name: "explore", mode: "subagent", model: "opencode/gpt-5.6-luna-fast" }],
      {
        availableModelsOverride: new Set(["opencode/gpt-5.6-luna", "opencode/deepseek-v4-flash"]),
        pricingCatalog: {
          "opencode/gpt-5.6-luna": FREE,
          "opencode/deepseek-v4-flash": CHEAP,
        },
        agentOverrides: { explore: { model: "opencode/deepseek-v4-flash" } },
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then the explicit user pin is honored; the free band is not consulted
    expect(result.error).toBeUndefined()
    expect(result.agentToUse).toBe("explore")
    expect(result.categoryModel).toEqual({ providerID: "opencode", modelID: "deepseek-v4-flash" })
    expect(logSpy).not.toHaveBeenCalledWith(
      "[delegate-task] resolved subagent model dynamically",
      expect.anything(),
    )
  })

  test("no free worker: a paid-only pool fails explicitly instead of using the static paid default", async () => {
    //#given the live pool holds only the paid DeepSeek V4 Flash and no free model
    const args = createBaseArgs()
    const executorCtx = createExecutorContext(
      async () => [{ name: "explore", mode: "subagent", model: "opencode/deepseek-v4-flash" }],
      {
        availableModelsOverride: new Set(["opencode/deepseek-v4-flash"]),
        pricingCatalog: { "opencode/deepseek-v4-flash": CHEAP },
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then the launch fails actionably; the paid static default is never used
    expect(result.categoryModel).toBeUndefined()
    expect(result.error).toContain("PAID_ESCALATION_REQUIRED")
    expect(result.error).toContain("free_pool_exhausted")
  })

  test("ordinary children stay FREE even when paid tier pins are configured", async () => {
    //#given free and paid candidates plus the production paid pin shape
    const args = createBaseArgs()
    const executorCtx = createExecutorContext(
      async () => [{ name: "explore", mode: "subagent", model: "opencode/deepseek-v4-flash" }],
      {
        availableModelsOverride: new Set(["opencode/gpt-5.6-luna", "opencode/deepseek-v4-flash"]),
        pricingCatalog: {
          "opencode/gpt-5.6-luna": FREE,
          "opencode/deepseek-v4-flash": CHEAP,
        },
        modelRouting: {
          enabled: true,
          tiers: {
            fast: { model: "opencode/deepseek-v4-flash" },
            balanced: { model: "opencode/deepseek-v4-flash" },
            strong: { model: "opencode/deepseek-v4-flash" },
            master: { model: "opencode/deepseek-v4-flash", inherit_parent: false },
          },
        },
      },
    )

    //#when
    const result = await resolveSubagentExecution(args, executorCtx, "sisyphus", "deep")

    //#then the paid pins are ignored and the free model wins
    expect(result.error).toBeUndefined()
    expect(result.categoryModel).toEqual({ providerID: "opencode", modelID: "gpt-5.6-luna" })
  })
})
