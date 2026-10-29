import { describe, test, expect, afterEach, spyOn } from "bun:test"

import { DEFAULT_RESOURCE_GOVERNOR_CONFIG } from "../../config/schema/resource-governor"
import { createResourceGovernorRuntime } from "../../hooks/resource-governor"
import type { PricingCatalog } from "../../hooks/resource-governor/pricing"
import { createDelegateTask } from "./tools"
import * as executor from "./executor"
import * as paidConsent from "./paid-consent"
import { PaidConsentRegistry } from "./paid-consent"

const restorables: Array<{ mockRestore: () => void }> = []

function track<T extends { mockRestore: () => void }>(spy: T): T {
  restorables.push(spy)
  return spy
}

const FREE_MODEL = "opencode/free-a"
const PAID_MODEL = "openai/paid-model"

const PRICING: PricingCatalog = {
  [FREE_MODEL]: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  [PAID_MODEL]: { input: 5, output: 20, cache_read: 0, cache_write: 0 },
}

const GOVERNOR_CONFIG = {
  ...DEFAULT_RESOURCE_GOVERNOR_CONFIG,
  consent: {
    ...DEFAULT_RESOURCE_GOVERNOR_CONFIG.consent,
    require_paid_escalation: false,
  },
}

const ARGS = {
  description: "route a child",
  prompt: "do the work",
  category: "deep",
  run_in_background: false,
  load_skills: [],
}

function makeMockClient(): Record<string, unknown> {
  return {
    app: { agents: async () => ({ data: [] }) },
    config: { get: async () => ({ data: {} }) },
    provider: { list: async () => ({ data: { connected: ["opencode"] } }) },
    model: { list: async () => ({ data: [] }) },
    session: {
      get: async () => ({ data: { directory: "/project" } }),
      abort: async () => ({ data: {} }),
      create: async () => ({ data: { id: "test-session" } }),
      prompt: async () => ({ data: {} }),
      promptAsync: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
    },
  }
}

function makeTool(input: {
  available: Set<string>
  resourceGovernorRuntime: ReturnType<typeof createResourceGovernorRuntime>
  paidConsentRegistry?: PaidConsentRegistry
  nonInteractive?: boolean
}) {
  return createDelegateTask({
    manager: { launch: async () => ({ id: "task-1" }) } as never,
    client: makeMockClient() as never,
    directory: "/project",
    isRootSession: true,
    nonInteractive: input.nonInteractive ?? false,
    availableModelsOverride: input.available,
    pricingCatalog: PRICING,
    resourceGovernorRuntime: input.resourceGovernorRuntime,
    paidConsentRegistry: input.paidConsentRegistry ?? new PaidConsentRegistry(),
    nativeSkills: {
      all: () => [],
      get: () => undefined,
      dirs: () => [],
    },
    getLoadedSkills: async () => [],
  })
}

function makeContext(approvals: string[]) {
  return {
    sessionID: "root-session",
    messageID: "root-message",
    agent: "sisyphus",
    abort: new AbortController().signal,
    ask: async (request: { permission: string }) => {
      approvals.push(request.permission)
    },
    metadata: async () => {},
  }
}

function stubPaidCategory(source: "category-default" | "override" = "category-default") {
  return track(spyOn(executor, "resolveCategoryExecution")).mockResolvedValue({
    agentToUse: "Sisyphus-Junior",
    categoryModel: { providerID: "openai", modelID: "paid-model" },
    categoryPromptAppend: undefined,
    modelInfo: {
      model: PAID_MODEL,
      type: source === "override" ? "user-defined" : "category-default",
      source,
    },
    actualModel: PAID_MODEL,
    isUnstableAgent: false,
  })
}

describe("free-first re-selection at the delegate-task dispatch boundary", () => {
  afterEach(() => {
    while (restorables.length > 0) restorables.pop()?.mockRestore()
  })

  test("#given a paid resolved model and an available $0 catalog model #when the task dispatches #then the $0 model runs and the governor authorizes that final model", async () => {
    // given
    stubPaidCategory()
    const syncSpy = track(spyOn(executor, "executeSyncTask")).mockResolvedValue("complete: done")
    const runtime = createResourceGovernorRuntime({
      config: GOVERNOR_CONFIG,
      pricing: PRICING,
    })
    const enforceSpy = track(spyOn(runtime, "enforce"))
    const approvals: string[] = []
    const tool = makeTool({
      available: new Set([FREE_MODEL, PAID_MODEL]),
      resourceGovernorRuntime: runtime,
    })

    // when
    const result = await tool.execute(ARGS, makeContext(approvals))

    // then
    expect(result).toBe("complete: done")
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(syncSpy.mock.calls[0]?.[5]).toMatchObject({ providerID: "opencode", modelID: "free-a" })
    expect(enforceSpy).toHaveBeenCalledTimes(1)
    expect(enforceSpy.mock.calls[0]?.[0].resolvedModelID).toBe(FREE_MODEL)
    expect(approvals).toEqual([])
  })

  test("#given no $0 model is available #when the task dispatches #then the resolved paid model is kept and the paid gate reports free exhaustion", async () => {
    // given
    stubPaidCategory()
    track(spyOn(executor, "executeSyncTask")).mockResolvedValue("complete: paid")
    const paidGateSpy = track(spyOn(paidConsent, "enforcePaidWorkerLaunch"))
    const runtime = createResourceGovernorRuntime({
      config: GOVERNOR_CONFIG,
      pricing: PRICING,
    })
    const approvals: string[] = []
    const tool = makeTool({
      available: new Set([PAID_MODEL]),
      resourceGovernorRuntime: runtime,
    })

    // when
    const result = await tool.execute(ARGS, makeContext(approvals))

    // then
    expect(result).toBe("complete: paid")
    expect(paidGateSpy.mock.calls.length).toBeGreaterThan(0)
    for (const call of paidGateSpy.mock.calls) {
      expect(call[0].freeCandidatesExhausted).toBe(true)
      expect(call[0].resolvedModelKey).toBe(PAID_MODEL)
    }
    expect(approvals.length).toBeGreaterThan(0)
  })

  test("#given no $0 model and a non-interactive host #when the task dispatches #then the paid launch fails closed even if ask resolves", async () => {
    // given
    stubPaidCategory()
    const syncSpy = track(spyOn(executor, "executeSyncTask")).mockResolvedValue("complete: paid")
    const runtime = createResourceGovernorRuntime({
      config: GOVERNOR_CONFIG,
      pricing: PRICING,
    })
    const approvals: string[] = []
    const tool = makeTool({
      available: new Set([PAID_MODEL]),
      resourceGovernorRuntime: runtime,
      nonInteractive: true,
    })

    // when
    const result = await tool.execute(ARGS, makeContext(approvals))

    // then
    expect(result).toContain("PAID_WORKER_CONSENT_UNAVAILABLE")
    expect(syncSpy).not.toHaveBeenCalled()
    expect(approvals).toEqual([])
  })

  test("#given a caller-pinned paid model and an available $0 model #when the task dispatches #then the pinned model is kept and no re-selection happens", async () => {
    // given
    stubPaidCategory("override")
    const syncSpy = track(spyOn(executor, "executeSyncTask")).mockResolvedValue("complete: pinned")
    const runtime = createResourceGovernorRuntime({
      config: GOVERNOR_CONFIG,
      pricing: PRICING,
    })
    const enforceSpy = track(spyOn(runtime, "enforce"))
    const approvals: string[] = []
    const tool = makeTool({
      available: new Set([FREE_MODEL, PAID_MODEL]),
      resourceGovernorRuntime: runtime,
    })

    // when
    const result = await tool.execute(ARGS, makeContext(approvals))

    // then
    expect(result).toBe("complete: pinned")
    expect(syncSpy.mock.calls[0]?.[5]).toMatchObject({ providerID: "openai", modelID: "paid-model" })
    expect(enforceSpy.mock.calls[0]?.[0].resolvedModelID).toBe(PAID_MODEL)
  })
})
