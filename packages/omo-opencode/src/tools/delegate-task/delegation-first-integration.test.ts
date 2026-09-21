import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "../../shared/governance-audit"
import { createDelegationFirstRuntime } from "../../features/delegation-first"
import * as executor from "./executor"
import { __resetModelCache } from "../../shared/model-availability"
import { clearSkillCache } from "../../features/opencode-skill-loader/skill-content"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import * as connectedProvidersCache from "../../shared/connected-providers-cache"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"

const TEST_CONNECTED_PROVIDERS = ["anthropic", "kimi-for-coding"]
const TEST_AVAILABLE_MODELS = new Set([
  "kimi-for-coding/kimi-for-coding-highspeed",
  "anthropic/claude-sonnet-4-6",
])

function pricingCatalog() {
  return {
    "kimi-for-coding/kimi-for-coding-highspeed": { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    "anthropic/claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0, cache_write: 0 },
  }
}

function mockClient() {
  return {
    app: { agents: async () => ({ data: [] }) },
    config: { get: async () => ({ data: { model: "anthropic/claude-sonnet-4-6" } }) },
    model: { list: async () => ({ data: [{ provider: "kimi-for-coding", id: "kimi-for-coding-highspeed" }] }) },
    session: {
      create: async () => ({ data: { id: "test-session" } }),
      prompt: async () => ({ data: {} }),
      promptAsync: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      status: async () => ({ data: { time: { updated: Date.now() } } }),
      abort: async () => ({ data: {} }),
      delete: async () => ({ data: {} }),
    },
  }
}

const toolContext = {
  sessionID: "parent-session",
  messageID: "parent-message",
  agent: "sisyphus",
  abort: new AbortController().signal,
}

function readJournalEvents(root: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const sessionDir of readdirSync(root)) {
    for (const entry of readdirSync(join(root, sessionDir))) {
      for (const line of readFileSync(join(root, sessionDir, entry), "utf8").split("\n")) {
        if (line.length === 0) continue
        out.push(JSON.parse(line))
      }
    }
  }
  return out
}

describe("delegation-first live wiring through the real task tool", () => {
  let cacheSpy: ReturnType<typeof spyOn>
  let providerModelsSpy: ReturnType<typeof spyOn>
  let root: string
  let auditWriter: ReturnType<typeof createGovernanceAuditWriter>

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
    root = mkdtempSync(join(tmpdir(), "delegation-first-integration-"))
    auditWriter = createGovernanceAuditWriter({ root })
  })

  afterEach(() => {
    releaseAllPromptAsyncReservationsForTesting()
    cacheSpy?.mockRestore()
    providerModelsSpy?.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  function weakThenEscalateThenDone(): ReturnType<typeof spyOn> {
    let calls = 0
    return spyOn(executor, "executeSyncTask").mockImplementation(async () => {
      calls += 1
      if (calls === 1) return "error: could not locate the token refresh flow"
      if (calls === 2) return "error: still unable to trace the fallback chain"
      return "complete: refresh flow found at src/auth/refresh.ts"
    })
  }

  test("real delegable task reaches delegation-first, refines a weak result, escalates the model, and preserves findings", async () => {
    // given the real task tool wired with a delegation-first runtime + pricing
    const syncSpy = weakThenEscalateThenDone()
    const delegationFirstRuntime = createDelegationFirstRuntime(auditWriter)

    const { createDelegateTask } = await import("./tools")
    const tool = createDelegateTask({
      manager: { launch: async () => ({ id: "task-1", status: "pending", sessionID: "s" }) },
      client: mockClient(),
      connectedProvidersOverride: TEST_CONNECTED_PROVIDERS,
      availableModelsOverride: TEST_AVAILABLE_MODELS,
      nativeSkills: { all: async () => [], get: async () => undefined, dirs: async () => [] },
      getLoadedSkills: async () => [],
      delegationFirstRuntime,
      pricingCatalog: pricingCatalog(),
    })

    // when a sync delegable task is dispatched
    const result = (await tool.execute(
      { description: "trace auth", prompt: "find the token refresh flow", category: "quick", run_in_background: false },
      toolContext,
    )) as string

    // then three attempts ran (refine, refine->escalate, done)
    expect(syncSpy).toHaveBeenCalledTimes(3)
    expect(result).toContain("complete")

    const calls = syncSpy.mock.calls.map((c) => ({
      prompt: (c[0] as { prompt: string }).prompt,
      model: c[5] as DelegatedModelConfig | undefined,
    }))

    // attempt 1: original prompt on the free resolved model
    expect(calls[0].prompt).toBe("find the token refresh flow")
    expect(calls[0].model?.modelID).toBe("kimi-for-coding-highspeed")

    // attempt 2: refined assignment, same free model (retry)
    expect(calls[1].prompt).toContain("Refined assignment")
    expect(calls[1].prompt).toContain("unresolved")
    expect(calls[1].model?.modelID).toBe("kimi-for-coding-highspeed")

    // attempt 3: escalated to the paid model, refined prompt preserving findings
    expect(calls[2].model?.modelID).toBe("claude-sonnet-4-6")
    expect(calls[2].prompt).toContain("Refined assignment")

    await delegationFirstRuntime.dispose()
    await auditWriter.flush()

    const events = readJournalEvents(root).map((e) => e.event)
    expect(events).toContain("delegation_first_selected")
    expect(events).toContain("worker_attempt_inadequate")
    expect(events).toContain("worker_prompt_refined")
    expect(events).toContain("worker_model_escalated")

    // metadata only: no worker prompt text or output reached the journal
    const raw = readFileSync(join(root, readdirSync(root)[0], readdirSync(join(root, readdirSync(root)[0]))[0]), "utf8")
    expect(raw).not.toContain("token refresh flow")
    expect(raw).not.toContain("refresh.ts")
  })

  test("a single weak result refines in place without escalating the model", async () => {
    // given a worker that errs once then succeeds
    let calls = 0
    const syncSpy = spyOn(executor, "executeSyncTask").mockImplementation(async () => {
      calls += 1
      return calls === 1 ? "error: transient failure" : "ok: resolved"
    })
    const delegationFirstRuntime = createDelegationFirstRuntime(auditWriter)

    const { createDelegateTask } = await import("./tools")
    const tool = createDelegateTask({
      manager: { launch: async () => ({ id: "task-1", status: "pending", sessionID: "s" }) },
      client: mockClient(),
      connectedProvidersOverride: TEST_CONNECTED_PROVIDERS,
      availableModelsOverride: TEST_AVAILABLE_MODELS,
      nativeSkills: { all: async () => [], get: async () => undefined, dirs: async () => [] },
      getLoadedSkills: async () => [],
      delegationFirstRuntime,
      pricingCatalog: pricingCatalog(),
    })

    await tool.execute(
      { description: "trace auth", prompt: "find the token refresh flow", category: "quick", run_in_background: false },
      toolContext,
    )

    // then only one refinement retry happened, same free model throughout
    expect(syncSpy).toHaveBeenCalledTimes(2)
    const model0 = (syncSpy.mock.calls[0][5] as DelegatedModelConfig | undefined)?.modelID
    const model1 = (syncSpy.mock.calls[1][5] as DelegatedModelConfig | undefined)?.modelID
    expect(model0).toBe("kimi-for-coding-highspeed")
    expect(model1).toBe("kimi-for-coding-highspeed")

    await delegationFirstRuntime.dispose()
    await auditWriter.flush()
    const events = readJournalEvents(root).map((e) => e.event)
    expect(events).toContain("worker_prompt_refined")
    expect(events).not.toContain("worker_model_escalated")
  })
})
