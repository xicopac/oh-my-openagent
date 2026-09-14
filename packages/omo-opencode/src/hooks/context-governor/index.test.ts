import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ContextGovernorConfig } from "../../config/schema/context-governor"
import { ContextGovernorConfigSchema } from "../../config/schema/context-governor"
import { encodeSessionId } from "./capsule-store"
import type { VerifierVerdict } from "./verdict"

const logMock = mock(() => {})

mock.module("../../shared/logger", () => ({
  log: logMock,
}))

afterAll(() => {
  mock.restore()
})

const { createContextGovernorHook } = await import("./index")

const SAFE_VERDICT: VerifierVerdict = {
  verdict: "SAFE_TO_COMPACT",
  capsule_revision: 3,
  capsule_hash: "aaaa",
  cursor_covered: 42,
  anchor_count: 1,
  required_state_checks: [],
  missing_critical_state: false,
}

const LEASE_VERDICT: VerifierVerdict = {
  verdict: "CONTEXT_LEASE_REQUIRED",
  reason: "atomic_reasoning_phase",
  exact_raw_context_required: "keep diff A vs B active",
  anchors: [
    { type: "session_entries", ref: "seg-a", range: { from: 10, to: 20, label: "diff" } },
  ],
  expected_safe_condition: "after tests pass",
}

function tinyCfg(): ContextGovernorConfig {
  return ContextGovernorConfigSchema.parse({
    enabled: true,
    prepare_at_tokens: 500,
    audit_at_tokens: 800,
    normal_limit_tokens: 1000,
    target_after_compaction_tokens: 250,
    provider_relative_ratio: 0.1,
    lease: { max_renewals: 1, extra_tokens: 300, max_turns: 3 },
  })
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

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-governor-test-"))
  logMock.mockClear()
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

async function fireMessageUpdated(
  hook: ReturnType<typeof createContextGovernorHook>,
  args: {
    sessionID: string
    providerID?: string
    modelID?: string
    input: number
    cacheRead?: number
  },
): Promise<void> {
  await hook.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          role: "assistant",
          sessionID: args.sessionID,
          providerID: args.providerID ?? "opencode",
          modelID: args.modelID ?? "tiny-model",
          finish: true,
          tokens: {
            input: args.input,
            output: 0,
            reasoning: 0,
            cache: { read: args.cacheRead ?? 0, write: 0 },
          },
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

function makeCacheStateWithLimit(limit: number): {
  anthropicContext1MEnabled: boolean
  modelContextLimitsCache: Map<string, number>
} {
  const cache = new Map<string, number>()
  cache.set("opencode/tiny-model", limit)
  return { anthropicContext1MEnabled: false, modelContextLimitsCache: cache }
}

// actualLimit=20000 with tinyCfg ratio=0.1 -> compactRel=2000 >= 1000, so the
// absolute cap (1000) binds and thresholds stay at 500/800/1000/250.
const TINY_LIMIT = 20000

describe("createContextGovernorHook", () => {
  it("is a NOOP when context_governor is not configured", async () => {
    // given
    const ctx = createMockCtx()
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: {} as never,
      modelCacheState: makeCacheStateWithLimit(TINY_LIMIT),
      directory: () => dir,
    })
    const sessionID = "ses_disabled_undefined"

    // when
    await fireMessageUpdated(hook, { sessionID, input: 1500 })
    await fireToolAfter(hook, sessionID, "call_1")

    // then
    expect(ctx.client.session.summarize).not.toHaveBeenCalled()
  })

  it("is a NOOP when context_governor.enabled=false", async () => {
    // given
    const cfg = { ...tinyCfg(), enabled: false }
    const ctx = createMockCtx()
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: { context_governor: cfg } as never,
      modelCacheState: makeCacheStateWithLimit(TINY_LIMIT),
      directory: () => dir,
    })
    const sessionID = "ses_disabled"

    // when
    await fireMessageUpdated(hook, { sessionID, input: 1500 })
    await fireToolAfter(hook, sessionID, "call_1")

    // then
    expect(ctx.client.session.summarize).not.toHaveBeenCalled()
  })

  it("triggers summarize with expected body shape at compact threshold after SAFE verdict", async () => {
    // given
    const ctx = createMockCtx()
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: { context_governor: tinyCfg() } as never,
      modelCacheState: makeCacheStateWithLimit(TINY_LIMIT),
      directory: () => dir,
    })
    const sessionID = "ses_safe_compact"

    // when: cache tokens, ingest SAFE verdict, cross compactAt
    await fireMessageUpdated(hook, { sessionID, input: 1100 })
    hook.ingestVerdict(sessionID, SAFE_VERDICT)
    await fireToolAfter(hook, sessionID, "call_1")

    // then
    expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)
    const call = ctx.client.session.summarize.mock.calls[0]?.[0]
    expect(call?.path?.id).toBe(sessionID)
    expect(call?.body?.providerID).toBe("opencode")
    expect(call?.body?.modelID).toBe("tiny-model")
    expect(call?.body?.auto).toBe(true)
    expect(call?.query?.directory).toBe(dir)
  })

  it("does NOT call summarize when an active lease is present", async () => {
    // given
    const ctx = createMockCtx()
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: { context_governor: tinyCfg() } as never,
      modelCacheState: makeCacheStateWithLimit(TINY_LIMIT),
      directory: () => dir,
    })
    const sessionID = "ses_lease_block"

    // when: verdict grants a lease, then cross compactAt
    await fireMessageUpdated(hook, { sessionID, input: 900 })
    hook.ingestVerdict(sessionID, LEASE_VERDICT)
    await fireMessageUpdated(hook, { sessionID, input: 1100 })
    await fireToolAfter(hook, sessionID, "call_1")

    // then
    expect(ctx.client.session.summarize).not.toHaveBeenCalled()
  })

  it("writes an active-lease.json under the injected directory when ingestVerdict is CONTEXT_LEASE_REQUIRED", async () => {
    // given
    const ctx = createMockCtx()
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: { context_governor: tinyCfg() } as never,
      modelCacheState: makeCacheStateWithLimit(TINY_LIMIT),
      directory: () => dir,
    })
    const sessionID = "ses_lease_files"

    // when
    await fireMessageUpdated(hook, { sessionID, input: 900 })
    hook.ingestVerdict(sessionID, LEASE_VERDICT)

    // then
    const encoded = encodeSessionId(sessionID)
    const activeLease = join(dir, ".omo/context-twin", encoded, "active-lease.json")
    const leasesLog = join(dir, ".omo/context-twin", encoded, "leases.ndjson")
    expect(existsSync(activeLease)).toBe(true)
    expect(existsSync(leasesLog)).toBe(true)
  })

  it("force_compact: with max_renewals=1 and second expiry, summarize fires", async () => {
    // given
    const ctx = createMockCtx()
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: { context_governor: tinyCfg() } as never,
      modelCacheState: makeCacheStateWithLimit(TINY_LIMIT),
      directory: () => dir,
    })
    const sessionID = "ses_force_compact"

    // given: initial lease granted at 900 tokens
    await fireMessageUpdated(hook, { sessionID, input: 900 })
    hook.ingestVerdict(sessionID, LEASE_VERDICT)

    // when: cross compactAt with lease expired via tokens_since_grant (300 >= extra_tokens=300)
    // and LEASE verdict still active -> renew_lease consumes the one allowed renewal
    await fireMessageUpdated(hook, { sessionID, input: 1200 })
    await fireToolAfter(hook, sessionID, "call_1")

    // when: still lease_active, advance again -> lease expired, renewals exhausted -> force_compact
    await fireMessageUpdated(hook, { sessionID, input: 1600 })
    await fireToolAfter(hook, sessionID, "call_2")

    // then
    expect(ctx.client.session.summarize).toHaveBeenCalled()
  })

  it("captures provider/model from message.updated for later use", async () => {
    // given
    const ctx = createMockCtx()
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: { context_governor: tinyCfg() } as never,
      modelCacheState: makeCacheStateWithLimit(TINY_LIMIT),
      directory: () => dir,
    })
    const sessionID = "ses_provider_capture"

    // when
    await fireMessageUpdated(hook, {
      sessionID,
      providerID: "opencode",
      modelID: "tiny-model",
      input: 1100,
    })
    hook.ingestVerdict(sessionID, SAFE_VERDICT)
    await fireToolAfter(hook, sessionID, "call_1")

    // then
    expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)
    const call = ctx.client.session.summarize.mock.calls[0]?.[0]
    expect(call?.body?.providerID).toBe("opencode")
    expect(call?.body?.modelID).toBe("tiny-model")
  })

  it("appends decision + verdict lines to wakes.ndjson under the injected directory", async () => {
    // given
    const ctx = createMockCtx()
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: { context_governor: tinyCfg() } as never,
      modelCacheState: makeCacheStateWithLimit(TINY_LIMIT),
      directory: () => dir,
    })
    const sessionID = "ses_wakes"

    // when
    await fireMessageUpdated(hook, { sessionID, input: 600 })
    await fireToolAfter(hook, sessionID, "call_prep")
    hook.ingestVerdict(sessionID, SAFE_VERDICT)

    // then
    const encoded = encodeSessionId(sessionID)
    const wakesPath = join(dir, ".omo/context-twin", encoded, "wakes.ndjson")
    expect(existsSync(wakesPath)).toBe(true)
    const lines = readFileSync(wakesPath, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.some((entry) => entry.kind === "prepare")).toBe(true)
    expect(lines.some((entry) => entry.kind === "verdict")).toBe(true)
  })
})
