import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"

import { ResourceGovernorConfigSchema, type ResourceGovernorConfig } from "../../config/schema/resource-governor"
import {
  createResourceGovernorRuntime,
  type ResourceGovernorRuntime,
} from "../../hooks/resource-governor"
import * as executor from "./executor"
import { __resetModelCache } from "../../shared/model-availability"
import { clearSkillCache } from "../../features/opencode-skill-loader/skill-content"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import * as connectedProvidersCache from "../../shared/connected-providers-cache"

const TEST_CONNECTED_PROVIDERS = ["anthropic", "google", "openai", "kimi-for-coding"]
const TEST_AVAILABLE_MODELS = new Set([
  "anthropic/claude-opus-4-7",
  "kimi-for-coding/kimi-for-coding-highspeed",
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.5",
])

function config(): ResourceGovernorConfig {
  return ResourceGovernorConfigSchema.parse({}) as ResourceGovernorConfig
}

function mockClient() {
  return {
    app: { agents: async () => ({ data: [] }) },
    config: { get: async () => ({}) },
    provider: { list: async () => ({ data: { connected: TEST_CONNECTED_PROVIDERS } }) },
    model: { list: async () => ({ data: [{ provider: "kimi-for-coding", id: "kimi-for-coding-highspeed" }] }) },
    session: {
      create: async () => ({ data: { id: "test-session" } }),
      prompt: async () => ({ data: {} }),
      promptAsync: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
    },
  }
}

const toolContext = {
  sessionID: "parent-session",
  messageID: "parent-message",
  agent: "sisyphus",
  abort: new AbortController().signal,
}

describe("resource governor runtime integration", () => {
  let cacheSpy: ReturnType<typeof spyOn>
  let providerModelsSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    mock.restore()
    __resetModelCache()
    clearSkillCache()
    cacheSpy = spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(TEST_CONNECTED_PROVIDERS)
    providerModelsSpy = spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue({
      models: { "kimi-for-coding": ["kimi-for-coding-highspeed"] },
      connected: TEST_CONNECTED_PROVIDERS,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
  })

  afterEach(() => {
    releaseAllPromptAsyncReservationsForTesting()
    cacheSpy?.mockRestore()
    providerModelsSpy?.mockRestore()
  })

  function exhaustedRuntime(): ResourceGovernorRuntime {
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

  test("a sync dispatch after the hard paid ceiling does not reach child execution", async () => {
    // given the real task tool wired with a governor whose ceiling is reached
    const backgroundSpy = spyOn(executor, "executeBackgroundTask").mockResolvedValue("UNREACHABLE")
    const syncSpy = spyOn(executor, "executeSyncTask").mockResolvedValue("UNREACHABLE")

    const { createDelegateTask } = await import("./tools")
    const tool = createDelegateTask({
      manager: { launch: async () => ({ id: "task-1", status: "pending", sessionID: "s" }) },
      client: mockClient(),
      connectedProvidersOverride: TEST_CONNECTED_PROVIDERS,
      availableModelsOverride: TEST_AVAILABLE_MODELS,
      nativeSkills: { all: async () => [], get: async () => undefined, dirs: async () => [] },
      getLoadedSkills: async () => [],
      resourceGovernorRuntime: exhaustedRuntime(),
      resourceGovernorDefaultChildTokens: 600_000,
    })

    // when a paid child is requested past the ceiling (sync)
    const result = await tool.execute(
      { description: "blocked child", prompt: "inspect the auth flow", category: "quick", run_in_background: false },
      toolContext,
    )

    // then the governor blocks it and no sync child execution path is entered
    expect(result).toContain("RESOURCE_BUDGET_EXHAUSTED")
    expect(syncSpy).not.toHaveBeenCalled()
    expect(backgroundSpy).not.toHaveBeenCalled()
  })

  test("a free child still reaches dispatch", async () => {
    // given a governor with a free model and no ceiling pressure
    const syncSpy = spyOn(executor, "executeSyncTask").mockResolvedValue("DISPATCHED")

    const runtime = createResourceGovernorRuntime({
      config: config(),
      pricing: { "kimi-for-coding/kimi-for-coding-highspeed": { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
    })

    const { createDelegateTask } = await import("./tools")
    const tool = createDelegateTask({
      manager: { launch: async () => ({ id: "task-1", status: "pending", sessionID: "s" }) },
      client: mockClient(),
      connectedProvidersOverride: TEST_CONNECTED_PROVIDERS,
      availableModelsOverride: TEST_AVAILABLE_MODELS,
      nativeSkills: { all: async () => [], get: async () => undefined, dirs: async () => [] },
      getLoadedSkills: async () => [],
      resourceGovernorRuntime: runtime,
      resourceGovernorDefaultChildTokens: 600_000,
    })

    // when a (catalog-free) child is requested
    await tool.execute(
      { description: "free child", prompt: "inspect the auth flow", category: "quick", run_in_background: false },
      toolContext,
    )

    // then sync dispatch is reached
    expect(syncSpy).toHaveBeenCalled()
  })
})
