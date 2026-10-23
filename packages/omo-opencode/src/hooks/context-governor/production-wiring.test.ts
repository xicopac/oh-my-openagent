import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ContextGovernorConfigSchema,
  DEFAULT_CONTEXT_GOVERNOR_CONFIG,
  type ContextGovernorConfig,
} from "../../config/schema/context-governor"
import * as dynamicTruncator from "../../shared/dynamic-truncator"
import { createToolOutputTruncatorHook } from "../tool-output-truncator"
import {
  MANDATORY_COMPACTION_TOKENS,
  POST_COMPACTION_MAX_TOKENS,
  POST_COMPACTION_MIN_TOKENS,
  POST_COMPACTION_TARGET_TOKENS,
  PRE_DISPATCH_CEILING_TOKENS,
  PROACTIVE_COMPACTION_TOKENS,
} from "./budget-policy"
import { createContextGovernorHook, encodeSessionId } from "./index"
import { resolveEffectiveThresholds, type EffectiveThresholds } from "./threshold-policy"
import type { VerifierVerdict } from "./verdict"

const SAFE_VERDICT: VerifierVerdict = {
  verdict: "SAFE_TO_COMPACT",
  capsule_revision: 3,
  capsule_hash: "aaaa",
  cursor_covered: 42,
  anchor_count: 1,
  required_state_checks: [],
  missing_critical_state: false,
}

function createMockCtx() {
  return {
    client: {
      session: {
        messages: mock(() => Promise.resolve({ data: [] })),
        summarize: mock(() => Promise.resolve({})),
      },
      tui: {
        showToast: mock(() => Promise.resolve()),
      },
    },
    directory: "/tmp/test",
  }
}

function makeCacheStateWithLimit(limit: number) {
  const cache = new Map<string, number>()
  cache.set("opencode/tiny-model", limit)
  return { anthropicContext1MEnabled: false, modelContextLimitsCache: cache }
}

// 200k window -> policy ceiling pinpoints at the fixed 150k and the policy
// thresholds are exactly 60k/90k/150k/15k (bindingLimit "none").
const LARGE_LIMIT = 200_000

async function fireMessage(
  hook: ReturnType<typeof createContextGovernorHook>,
  args: {
    sessionID: string
    role?: string
    id?: string
    input?: number
    finish?: boolean
    parts?: Array<{ type: string; text: string }>
  },
): Promise<void> {
  await hook.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          role: args.role ?? "assistant",
          sessionID: args.sessionID,
          id: args.id,
          providerID: "opencode",
          modelID: "tiny-model",
          finish: args.finish ?? true,
          tokens: {
            input: args.input ?? 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          parts: args.parts,
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

function makeGovernor(
  ctx: ReturnType<typeof createMockCtx>,
  dir: string,
  options?: {
    config?: ContextGovernorConfig
    limit?: number
    wake?: ReturnType<typeof mock>
  },
): ReturnType<typeof createContextGovernorHook> {
  const wake = options?.wake
  return createContextGovernorHook(ctx as never, {
    pluginConfig: {
      context_governor: options?.config ?? DEFAULT_CONTEXT_GOVERNOR_CONFIG,
    } as never,
    modelCacheState: makeCacheStateWithLimit(options?.limit ?? LARGE_LIMIT),
    directory: () => dir,
    ...(wake ? { signalBus: { wake } } : {}),
  })
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-governor-wiring-"))
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe("production budget policy wiring", () => {
  it("config schema defaults are sourced from the budget policy", () => {
    const cfg = ContextGovernorConfigSchema.parse({})
    expect(cfg.prepare_at_tokens).toBe(PROACTIVE_COMPACTION_TOKENS)
    expect(cfg.audit_at_tokens).toBe(MANDATORY_COMPACTION_TOKENS)
    expect(cfg.normal_limit_tokens).toBe(PRE_DISPATCH_CEILING_TOKENS)
    expect(cfg.target_after_compaction_tokens).toBe(POST_COMPACTION_TARGET_TOKENS)
  })

  it("real resolver: default config yields policy 60k/90k/150k/15k", () => {
    const t = resolveEffectiveThresholds({
      configured: DEFAULT_CONTEXT_GOVERNOR_CONFIG,
      actualLimit: 1_000_000,
    })
    expect(t).toEqual<EffectiveThresholds>({
      prepareAt: 60_000,
      auditAt: 90_000,
      compactAt: 150_000,
      targetAfter: 15_000,
      providerBinds: false,
    })
    expect(t!.prepareAt).toBe(PROACTIVE_COMPACTION_TOKENS)
    expect(t!.auditAt).toBe(MANDATORY_COMPACTION_TOKENS)
    expect(t!.compactAt).toBe(PRE_DISPATCH_CEILING_TOKENS)
    expect(t!.targetAfter).toBe(POST_COMPACTION_TARGET_TOKENS)
  })

  it("real resolver: post-compaction target lands inside the accepted 10k-20k band", () => {
    for (const window of [200_000, 400_000, 1_000_000]) {
      const t = resolveEffectiveThresholds({
        configured: DEFAULT_CONTEXT_GOVERNOR_CONFIG,
        actualLimit: window,
      })
      expect(t!.targetAfter).toBeGreaterThanOrEqual(POST_COMPACTION_MIN_TOKENS)
      expect(t!.targetAfter).toBeLessThanOrEqual(POST_COMPACTION_MAX_TOKENS)
    }
  })

  it("real resolver: config overrides may lower the policy thresholds (QA)", () => {
    const cfg = ContextGovernorConfigSchema.parse({
      prepare_at_tokens: 1000,
      audit_at_tokens: 2000,
      normal_limit_tokens: 3000,
      target_after_compaction_tokens: 500,
      provider_relative_ratio: 0.1,
    })
    const t = resolveEffectiveThresholds({ configured: cfg, actualLimit: 1_000_000 })
    expect(t).toEqual<EffectiveThresholds>({
      prepareAt: 1000,
      auditAt: 2000,
      compactAt: 3000,
      targetAfter: 500,
      providerBinds: false,
    })
  })

  it("real governor: compaction decisions fire at the policy 60k/90k/150k boundaries", async () => {
    const ctx = createMockCtx()
    const wake = mock(() => {})
    const hook = makeGovernor(ctx, dir, { wake })
    const sid = "ses_boundaries"

    // below proactive -> none
    await fireMessage(hook, { sessionID: sid, input: 59_999 })
    await fireToolAfter(hook, sid, "c1")
    expect(wake).not.toHaveBeenCalled()

    // at proactive -> prepare (maintain wake)
    await fireMessage(hook, { sessionID: sid, input: 60_000 })
    await fireToolAfter(hook, sid, "c2")
    expect(wake).toHaveBeenLastCalledWith(sid, "maintain")

    // at mandatory -> audit (validate wake)
    await fireMessage(hook, { sessionID: sid, input: 90_000 })
    await fireToolAfter(hook, sid, "c3")
    expect(wake).toHaveBeenLastCalledWith(sid, "validate")

    // at ceiling with SAFE verdict -> compaction
    await fireMessage(hook, { sessionID: sid, input: 150_000 })
    hook.ingestVerdict(sid, SAFE_VERDICT)
    await fireToolAfter(hook, sid, "c4")
    expect(ctx.client.session.summarize).toHaveBeenCalled()
  })
})

describe("pre-dispatch ceiling (chat.params seam)", () => {
  it("measuring 160k forces compaction and blocks; 100k and 150k do not", async () => {
    const ctx = createMockCtx()
    const hook = makeGovernor(ctx, dir)

    const over = "ses_over"
    await fireMessage(hook, { sessionID: over, input: 160_000 })
    const overResult = await hook.preDispatchCeiling(over)
    expect(overResult.ceiling).toBe(150_000)
    expect(overResult.boundary).toBe("over_ceiling")
    expect(overResult.mustCompact).toBe(true)
    expect(overResult.blocked).toBe(true)
    expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)
    const call = ctx.client.session.summarize.mock.calls[0]?.[0]
    expect(call?.path?.id).toBe(over)

    const under = "ses_under"
    await fireMessage(hook, { sessionID: under, input: 100_000 })
    const underResult = await hook.preDispatchCeiling(under)
    expect(underResult.boundary).toBe("under_ceiling")
    expect(underResult.blocked).toBe(false)
    expect(underResult.mustCompact).toBe(false)

    const at = "ses_at"
    await fireMessage(hook, { sessionID: at, input: 150_000 })
    const atResult = await hook.preDispatchCeiling(at)
    expect(atResult.boundary).toBe("at_ceiling")
    expect(atResult.blocked).toBe(false)

    // No extra compactions were forced for the non-over sessions.
    expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)
  })
})

describe("working document on the compaction path", () => {
  it("builds a bounded document with a history reference, persists it, and survives compaction", async () => {
    const ctx = createMockCtx()
    const hook = makeGovernor(ctx, dir)
    const sid = "ses_working_document"

    for (let index = 0; index < 5; index++) {
      await fireMessage(hook, {
        sessionID: sid,
        role: "user",
        id: `u${index}`,
        finish: false,
        input: 0,
        parts: [{ type: "text", text: `user objective ${index} ${"y".repeat(300)}` }],
      })
      await fireMessage(hook, {
        sessionID: sid,
        role: "assistant",
        id: `a${index}`,
        input: 150_000,
        parts: [{ type: "text", text: `assistant reply ${index}` }],
      })
    }

    const text = hook.injectCompactionContext(sid)
    expect(text).toBeDefined()
    expect(text!).toContain("History:")
    // Large history is referenced, never inlined (only a short latest-message
    // summary is carried; earlier entries are absent from the document).
    expect(text!).not.toContain("assistant reply 0")
    expect(text!).not.toContain("assistant reply 1")
    expect(text!.length).toBeLessThanOrEqual(POST_COMPACTION_TARGET_TOKENS * 4)
    // Deterministic for identical state.
    expect(hook.injectCompactionContext(sid)).toBe(text)

    // Trigger the real compaction path -> working document persisted.
    hook.ingestVerdict(sid, SAFE_VERDICT)
    await fireToolAfter(hook, sid, "compact_call")
    expect(ctx.client.session.summarize).toHaveBeenCalled()

    const path = join(
      dir,
      ".omo/context-twin",
      encodeSessionId(sid),
      "working-document.json",
    )
    expect(existsSync(path)).toBe(true)
    const persisted = JSON.parse(readFileSync(path, "utf-8")) as {
      estimatedTokens: number
      historyRef: { count: number } | null
    }
    expect(persisted.historyRef?.count).toBe(10)
    expect(persisted.estimatedTokens).toBeGreaterThan(0)
  })
})

describe("payload budget re-entry bounding", () => {
  it("tool-output-truncator hard-bounds a pathological output via boundToolOutput", async () => {
    const truncateSpy = spyOn(dynamicTruncator, "createDynamicTruncator").mockReturnValue({
      truncate: mock(async (_sessionID: string, output: string) => ({
        result: output,
        truncated: false,
      })),
      getUsage: mock(async () => null),
      truncateSync: mock(() => ({ result: "", truncated: false })),
    } as never)

    try {
      const hook = createToolOutputTruncatorHook({} as never)
      const huge = "Z".repeat(300_000)
      const output = { title: "Result", output: huge, metadata: {} }
      await hook["tool.execute.after"](
        { tool: "grep", sessionID: "s", callID: "c" },
        output,
      )
      expect(output.output.length).toBeLessThan(huge.length)
      expect(output.output).toContain("[truncated")
    } finally {
      truncateSpy.mockRestore()
    }
  })

  it("governor bounds child (task) results before they re-enter the parent", async () => {
    const ctx = createMockCtx()
    const hook = makeGovernor(ctx, dir)
    const output = { title: "child", output: "Q".repeat(80_000), metadata: {} }
    await hook["tool.execute.after"](
      { tool: "task", sessionID: "ses_child", callID: "call-child-1" },
      output,
    )
    expect(output.output).toContain("[truncated")
    expect(output.output).toContain("[full result: call-child-1]")
  })
})
