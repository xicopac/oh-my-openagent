/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { DelegateTaskArgs } from "./types"
import type { ExecutorContext } from "./executor-types"

type SubagentResolverModule = typeof import("./subagent-resolver")

const logMock = mock((..._args: unknown[]) => {})

const readConnectedProvidersCacheMock = mock((): string[] | null => ["opencode"])
const readProviderModelsCacheMock = mock(
  (): {
    models: Record<string, string[]>
    connected: string[]
    updatedAt: string
  } | null => ({
    models: { opencode: ["gpt-5.6-luna", "deepseek-v4-flash"] },
    connected: ["opencode"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
)

const loadUserAgentsMock = mock((): Record<string, unknown> => ({}))
const loadProjectAgentsMock = mock((): Record<string, unknown> => ({}))

const FREE = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const CHEAP = { input: 0.1, output: 0.2, cache_read: 0, cache_write: 0 }

async function importFreshSubagentResolverModule(): Promise<SubagentResolverModule> {
  return await import(`./subagent-resolver?test=${Date.now()}-${Math.random()}`)
}

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
  let resolveSubagentExecution: SubagentResolverModule["resolveSubagentExecution"]

  beforeEach(async () => {
    mock.restore()
    logMock.mockClear()
    readConnectedProvidersCacheMock.mockReset()
    readProviderModelsCacheMock.mockReset()
    loadUserAgentsMock.mockReset()
    loadProjectAgentsMock.mockReset()
    loadUserAgentsMock.mockImplementation(() => ({}))
    loadProjectAgentsMock.mockImplementation(() => ({}))
    readConnectedProvidersCacheMock.mockReturnValue(["opencode"])
    readProviderModelsCacheMock.mockReturnValue({
      models: { opencode: ["gpt-5.6-luna", "deepseek-v4-flash"] },
      connected: ["opencode"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    mock.module("../../shared/logger", () => ({ log: logMock }))
    mock.module("../../shared/connected-providers-cache", () => ({
      readConnectedProvidersCache: readConnectedProvidersCacheMock,
      readProviderModelsCache: readProviderModelsCacheMock,
      hasConnectedProvidersCache: () => readConnectedProvidersCacheMock() !== null,
      hasProviderModelsCache: () => readProviderModelsCacheMock() !== null,
      _resetMemCacheForTesting: () => {},
    }))
    mock.module("../../features/claude-code-agent-loader/loader", () => ({
      loadUserAgents: loadUserAgentsMock,
      loadProjectAgents: loadProjectAgentsMock,
    }))
    mock.module("../../features/claude-code-agent-loader", () => ({
      loadUserAgents: loadUserAgentsMock,
      loadProjectAgents: loadProjectAgentsMock,
    }))
    ;({ resolveSubagentExecution } = await importFreshSubagentResolverModule())
  })

  afterEach(() => {
    mock.restore()
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

  test("keeps an enabled matched model instead of re-routing through the dynamic resolver", async () => {
    //#given explore is baked with an enabled opencode model (no disabled provider)
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

    //#then the baked model is used directly
    expect(result.error).toBeUndefined()
    expect(result.agentToUse).toBe("explore")
    expect(result.categoryModel).toEqual({ providerID: "opencode", modelID: "gpt-5.6-luna" })
  })
})
