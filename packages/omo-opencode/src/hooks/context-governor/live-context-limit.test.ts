import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveActualContextLimit } from "@oh-my-opencode/model-core"

import {
  ContextGovernorConfigSchema,
  DEFAULT_CONTEXT_GOVERNOR_CONFIG,
  type ContextGovernorConfig,
} from "../../config/schema/context-governor"
import { createContextGovernorHook } from "./index"
import { resolveEffectiveThresholds } from "./threshold-policy"

const MODEL_PROVIDER = "opencode"
const MODEL_ID = "deepseek-v4.1-flash"
const REAL_WINDOW = 1_000_000

function createMockCtx() {
  return {
    client: {
      session: {
        messages: mock(() => Promise.resolve({ data: [] })),
        summarize: mock(() => Promise.resolve({})),
      },
      tui: { showToast: mock(() => Promise.resolve()) },
    },
    directory: "/tmp/test",
  }
}

function makeCacheState(limit?: number) {
  const modelContextLimitsCache = new Map<string, number>()
  if (limit !== undefined) modelContextLimitsCache.set(`${MODEL_PROVIDER}/${MODEL_ID}`, limit)
  return {
    anthropicContext1MEnabled: false,
    modelContextLimitsCache,
    resolveLiveContextLimit: (providerID: string, modelID: string) =>
      providerID === MODEL_PROVIDER && modelID === MODEL_ID ? REAL_WINDOW : null,
  }
}

async function fireMessage(
  hook: ReturnType<typeof createContextGovernorHook>,
  sessionID: string,
  input: number,
): Promise<void> {
  await hook.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          role: "assistant",
          sessionID,
          providerID: MODEL_PROVIDER,
          modelID: MODEL_ID,
          finish: true,
          tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  })
}

async function fireToolAfter(
  hook: ReturnType<typeof createContextGovernorHook>,
  sessionID: string,
  callID: string,
): Promise<void> {
  await hook["tool.execute.after"](
    { tool: "bash", sessionID, callID },
    { title: "", output: "test", metadata: null },
  )
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-governor-live-limit-"))
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe("live context-limit resolution feeds the governor", () => {
  it("real resolver: a model with only live metadata yields non-null thresholds", () => {
    // given the static cache misses but live metadata knows the window
    const state = makeCacheState()

    // when
    const actualLimit = resolveActualContextLimit(MODEL_PROVIDER, MODEL_ID, state)
    const effective = resolveEffectiveThresholds({
      configured: DEFAULT_CONTEXT_GOVERNOR_CONFIG,
      actualLimit,
    })

    // then the governor is armed with the policy thresholds
    expect(actualLimit).toBe(REAL_WINDOW)
    expect(effective).not.toBeNull()
    expect(effective).toEqual({
      prepareAt: 60_000,
      auditAt: 90_000,
      compactAt: 150_000,
      targetAfter: 15_000,
      providerBinds: false,
    })
  })

  it("governor proceeds to assessment when only live metadata resolves the limit", async () => {
    // given a governor whose static cache is empty but has a live fallback
    const ctx = createMockCtx()
    const wake = mock(() => {})
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: { context_governor: DEFAULT_CONTEXT_GOVERNOR_CONFIG } as never,
      modelCacheState: makeCacheState(),
      directory: () => dir,
      signalBus: { wake },
    })
    const sid = "ses_live_limit"

    // when the measurement crosses the proactive threshold
    await fireMessage(hook, sid, 60_000)
    await fireToolAfter(hook, sid, "c1")

    // then the assessment decision fires instead of an early return
    expect(wake).toHaveBeenLastCalledWith(sid, "maintain")
  })

  it("governor stays inert when nothing resolves the limit (gap regression guard)", async () => {
    // given a governor with no static entry and no live fallback
    const ctx = createMockCtx()
    const wake = mock(() => {})
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: { context_governor: DEFAULT_CONTEXT_GOVERNOR_CONFIG } as never,
      modelCacheState: {
        anthropicContext1MEnabled: false,
        modelContextLimitsCache: new Map(),
        resolveLiveContextLimit: () => null,
      },
      directory: () => dir,
      signalBus: { wake },
    })
    const sid = "ses_unresolved"

    // when / then the same measurement produces no decision
    await fireMessage(hook, sid, 60_000)
    await fireToolAfter(hook, sid, "c1")
    expect(wake).not.toHaveBeenCalled()
  })

  it("known static-cache limits take precedence over the live fallback", async () => {
    // given a static entry that binds the ratio against a wider live window
    const cfg: ContextGovernorConfig = ContextGovernorConfigSchema.parse({
      provider_relative_ratio: 0.5,
    })
    const hook = createContextGovernorHook(createMockCtx() as never, {
      pluginConfig: { context_governor: cfg } as never,
      modelCacheState: makeCacheState(100_000),
      directory: () => dir,
    })
    const sid = "ses_known_limit"

    // when
    await fireMessage(hook, sid, 40_000)

    // then thresholds follow the 100k static entry (compactAt 50k), not 1M
    expect(hook.diagnose(sid).preferred_tokens).toBe(50_000)
  })
})
