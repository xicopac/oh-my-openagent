// LIVE-CONFIG PAID-GATE REGRESSION (stacked on fix/wave4-delegation)
// The runtime paid-window gate used to be built once from STARTUP config while
// the rejection message read a FRESH config: a max 1 -> 3 edit made the gate
// enforce 1 and the message claim 3. These tests pin the tools.ts reconcile
// step: the gate must follow the live config before reserving, and the message
// must report the cap the gate actually enforces.
declare const require: NodeJS.Require
const { describe, expect, test, spyOn, mock, beforeEach } = require("bun:test")
import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "../../features/delegation-first"
import type { OhMyOpenCodeConfig } from "../../config"
import { PaidConsentRegistry } from "./paid-consent"
import * as executor from "./executor"

const runtimeRequire = require as NodeJS.Require & { cache?: Record<string, unknown> }

function clearRequireCache(modulePath: string): void {
  const resolvedPath = runtimeRequire.resolve(modulePath)
  if (runtimeRequire.cache?.[resolvedPath]) {
    delete runtimeRequire.cache[resolvedPath]
  }
}

const PAID_MODEL = "openai/gpt-5.6-sol"
const PAID_PRICING = { [PAID_MODEL]: { input: 10, output: 30, cache_read: 0, cache_write: 0 } }

type CurrentModelConfig = Pick<OhMyOpenCodeConfig, "agents" | "categories" | "model_routing">

function freshRouting(maxConcurrent: number): CurrentModelConfig {
  return {
    agents: {},
    categories: {},
    model_routing: { paid_workers: { max_concurrent: maxConcurrent } },
  }
}

function makeToolContext(): Record<string, unknown> {
  return {
    sessionID: "root-session",
    messageID: "root-message",
    agent: "sisyphus",
    abort: new AbortController().signal,
    ask: async (): Promise<void> => {},
    metadata: async () => {},
  }
}

function makeMockClient(): Record<string, unknown> {
  return {
    app: { agents: async () => ({ data: [] }) },
    config: { get: async () => ({ data: { model: "anthropic/claude-sonnet-4-6" } }) },
    provider: { list: async () => ({ data: { connected: ["openai"] } }) },
    model: { list: async () => ({ data: [{ provider: "openai", id: "gpt-5.6-sol" }] }) },
    session: {
      get: async () => ({ data: { directory: "/project" } }),
      create: async () => ({ data: { id: "test-session" } }),
      prompt: async () => ({ data: {} }),
      promptAsync: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
    },
  }
}

function makeTool(
  rt: DelegationFirstRuntime,
  loadCurrentModelConfig: () => CurrentModelConfig,
): { execute: (args: unknown, ctx: unknown) => Promise<unknown> } {
  const { createDelegateTask } = require("./tools")
  return createDelegateTask({
    paidConsentRegistry: new PaidConsentRegistry(),
    isRootSession: true,
    manager: { launch: async () => ({}) },
    client: makeMockClient(),
    delegationFirstRuntime: rt,
    pricingCatalog: PAID_PRICING,
    loadCurrentModelConfig,
  })
}

function stubPaidCategory(): ReturnType<typeof spyOn> {
  return spyOn(executor, "resolveCategoryExecution").mockResolvedValue({
    agentToUse: "Sisyphus-Junior",
    categoryModel: { providerID: "openai", modelID: "gpt-5.6-sol" },
    categoryPromptAppend: undefined,
    modelInfo: { model: PAID_MODEL, type: "user-defined", source: "override" },
    actualModel: PAID_MODEL,
    isUnstableAgent: false,
  })
}

const PAID_ARGS = { description: "paid child", prompt: "do it", category: "deep", run_in_background: false, load_skills: [] }

describe("live model_routing edits drive both the paid gate and its message", () => {
  beforeEach(() => {
    mock.restore()
    clearRequireCache("./tools")
  })

  test("raising max_concurrent from 1 to 3 is enforced immediately and the rejection message reports 3", async () => {
    // given - a runtime built from STARTUP config with a cap of 1 and one paid
    // child already holding that stale slot
    const rt = createDelegationFirstRuntime(undefined)
    expect(rt.paidChildConcurrencyMax()).toBe(1)
    expect(rt.tryAcquirePaidChild()).toBe(true)

    const resolveSpy = stubPaidCategory()
    const syncSpy = spyOn(executor, "executeSyncTask").mockResolvedValue("complete: done")
    const tool = makeTool(rt, () => freshRouting(3))
    try {
      // when - a paid dispatch arrives after the live edit 1 -> 3
      const first = await tool.execute(PAID_ARGS, makeToolContext())

      // then - the gate followed the live config instead of the stale cap:
      // the dispatch is not rejected at slot exhaustion and the enforced cap is 3
      expect(String(first)).not.toContain("PAID_WORKER_CONCURRENCY_LIMIT")
      expect(rt.paidChildConcurrencyMax()).toBe(3)

      // when - three paid children are genuinely active (the stale cap of 1
      // would have rejected the second) and another dispatch arrives
      expect(rt.tryAcquirePaidChild()).toBe(true)
      expect(rt.tryAcquirePaidChild()).toBe(true)
      const second = await tool.execute(PAID_ARGS, makeToolContext())

      // then - the rejection reports exactly the cap that rejected it
      expect(String(second)).toContain("PAID_WORKER_CONCURRENCY_LIMIT: maximum 3 concurrent paid child request(s) reached.")
      expect(rt.paidChildConcurrencyMax()).toBe(3)
    } finally {
      resolveSpy.mockRestore()
      syncSpy.mockRestore()
      await rt.dispose()
    }
  })
})
