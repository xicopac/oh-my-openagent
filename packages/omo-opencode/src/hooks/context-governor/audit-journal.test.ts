import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ContextGovernorConfig } from "../../config/schema/context-governor"
import { ContextGovernorConfigSchema } from "../../config/schema/context-governor"
import {
  createGovernanceAuditWriter,
  sessionJournalPath,
  type GovernanceAuditWriter,
} from "../../shared/governance-audit"
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

function messagesWithData(used: number) {
  return {
    data: [
      {
        info: {
          role: "assistant",
          providerID: "opencode",
          modelID: "tiny-model",
          tokens: { input: used, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    ],
  }
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

function createMockCtxWithUsage(sequence: number[]) {
  let i = 0
  return {
    client: {
      session: {
        messages: mock(() => {
          const used = sequence[Math.min(i, sequence.length - 1)]
          i += 1
          return Promise.resolve(messagesWithData(used))
        }),
        summarize: mock(() => Promise.resolve({})),
      },
      tui: {
        showToast: mock(() => Promise.resolve()),
      },
    },
    directory: "/tmp/test",
  }
}

function makeCacheStateWithLimit(limit: number): {
  anthropicContext1MEnabled: boolean
  modelContextLimitsCache: Map<string, number>
} {
  const cache = new Map<string, number>()
  cache.set("opencode/tiny-model", limit)
  return { anthropicContext1MEnabled: false, modelContextLimitsCache: cache }
}

const TINY_LIMIT = 20000

async function fireMessageUpdated(
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
          providerID: "opencode",
          modelID: "tiny-model",
          finish: true,
          tokens: {
            input,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
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

type AuditJournal = Array<Record<string, unknown>>

let dir: string
let root: string

function readJournal(sessionID: string): AuditJournal {
  const raw = readFileSync(sessionJournalPath(root, sessionID), "utf-8")
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function newHookWithAudit(ctx: unknown): {
  hook: ReturnType<typeof createContextGovernorHook>
  writer: GovernanceAuditWriter
} {
  const writer = createGovernanceAuditWriter({ root })
  const hook = createContextGovernorHook(ctx as never, {
    pluginConfig: { context_governor: tinyCfg() } as never,
    modelCacheState: makeCacheStateWithLimit(TINY_LIMIT),
    directory: () => dir,
    audit: writer,
  })
  return { hook, writer }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-governor-audit-"))
  root = mkdtempSync(join(tmpdir(), "governance-journal-"))
  logMock.mockClear()
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe("governance audit journal integration", () => {
  it("persists an assessment with token count and decision", async () => {
    const { hook, writer } = newHookWithAudit(createMockCtx())
    const sessionID = "ses_assessment"

    await fireMessageUpdated(hook, sessionID, 600)
    await fireToolAfter(hook, sessionID, "call_1")
    await writer.flush()

    const assessment = readJournal(sessionID).find((e) => e.event === "assessment")
    expect(assessment).toBeDefined()
    expect(assessment?.subsystem).toBe("context_governor")
    expect(assessment?.session_id).toBe(sessionID)
    expect(assessment?.context_tokens).toBe(600)
    expect(assessment?.decision).toBe("distill")
    expect(assessment?.reason_code).toBe("prepare")
  })

  it("persists enter_expansion with next reassessment tokens", async () => {
    const { hook, writer } = newHookWithAudit(createMockCtx())
    const sessionID = "ses_expansion"

    await fireMessageUpdated(hook, sessionID, 900)
    hook.ingestVerdict(sessionID, LEASE_VERDICT)
    await writer.flush()

    const expansion = readJournal(sessionID).find((e) => e.event === "enter_expansion")
    expect(expansion).toBeDefined()
    expect(expansion?.context_tokens).toBe(900)
    expect(expansion?.next_reassessment_tokens).toBe(1200)
    expect(expansion?.lease_extra_tokens).toBe(300)
  })

  it("persists a reassessment decision during expansion", async () => {
    const { hook, writer } = newHookWithAudit(createMockCtx())
    const sessionID = "ses_reassess"

    await fireMessageUpdated(hook, sessionID, 900)
    hook.ingestVerdict(sessionID, LEASE_VERDICT)
    await fireMessageUpdated(hook, sessionID, 1100)
    await fireToolAfter(hook, sessionID, "call_1")
    await writer.flush()

    const events = readJournal(sessionID)
    const assessment = events.find(
      (e) => e.event === "assessment" && e.decision === "expansion",
    )
    expect(assessment).toBeDefined()
    expect(assessment?.reason_code).toBe("defer_lease")
    expect(assessment?.next_reassessment_tokens).toBe(1200)

    const continued = events.find((e) => e.event === "continue_expansion")
    expect(continued).toBeDefined()
    expect(continued?.reason_code).toBe("lease_active")
  })

  it("persists a compact decision with effective target tokens", async () => {
    const ctx = createMockCtx()
    const { hook, writer } = newHookWithAudit(ctx)
    const sessionID = "ses_compact"

    await fireMessageUpdated(hook, sessionID, 1100)
    hook.ingestVerdict(sessionID, SAFE_VERDICT)
    await fireToolAfter(hook, sessionID, "call_1")
    await writer.flush()

    expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)

    const assessment = readJournal(sessionID).find(
      (e) => e.event === "assessment" && e.decision === "compact",
    )
    expect(assessment).toBeDefined()
    expect(assessment?.effective_target_tokens).toBe(250)
    expect(assessment?.context_tokens).toBe(1100)
  })

  it("records each multi-pass compaction pass separately with before/after tokens", async () => {
    const { hook, writer } = newHookWithAudit(createMockCtxWithUsage([1100, 900, 850]))
    const sessionID = "ses_multipass"

    await fireMessageUpdated(hook, sessionID, 1100)
    hook.ingestVerdict(sessionID, SAFE_VERDICT)
    await fireToolAfter(hook, sessionID, "call_1")
    await writer.flush()

    const passes = readJournal(sessionID).filter((e) => e.event === "compaction_pass")
    expect(passes.map((p) => p.pass)).toEqual([1, 2])
    expect(passes[0].before_tokens).toBe(1100)
    expect(passes[0].after_tokens).toBe(900)
    expect(passes[1].before_tokens).toBe(900)
    expect(passes[1].after_tokens).toBe(850)
  })

  it("persists the convergence stop reason", async () => {
    const { hook, writer } = newHookWithAudit(createMockCtxWithUsage([1100, 900, 850]))
    const sessionID = "ses_stop"

    await fireMessageUpdated(hook, sessionID, 1100)
    hook.ingestVerdict(sessionID, SAFE_VERDICT)
    await fireToolAfter(hook, sessionID, "call_1")
    await writer.flush()

    const complete = readJournal(sessionID).find((e) => e.event === "compaction_complete")
    expect(complete).toBeDefined()
    expect(complete?.stop_reason).toBe("poor_pass_value")
    expect(complete?.pass_count).toBe(2)
    expect(complete?.after_tokens).toBe(850)
  })

  it("appends to the correct journal across a resumed session", async () => {
    const { hook: hook1 } = newHookWithAudit(createMockCtx())
    const sessionID = "ses_resume"

    await fireMessageUpdated(hook1, sessionID, 600)
    await fireToolAfter(hook1, sessionID, "call_1")

    const { hook: hook2, writer } = newHookWithAudit(createMockCtx())
    await fireMessageUpdated(hook2, sessionID, 700)
    await fireToolAfter(hook2, sessionID, "call_2")
    await writer.flush()

    const assessments = readJournal(sessionID).filter((e) => e.event === "assessment")
    expect(assessments.length).toBe(2)
    expect(assessments.every((e) => e.session_id === sessionID)).toBe(true)
  })

  it("writes no prompts, secrets, or reasoning to the journal", async () => {
    const { hook, writer } = newHookWithAudit(createMockCtx())
    const sessionID = "ses_privacy"

    await fireMessageUpdated(hook, sessionID, 1100)
    hook.ingestVerdict(sessionID, SAFE_VERDICT)
    await fireToolAfter(hook, sessionID, "call_1")
    await writer.flush()

    const raw = readFileSync(sessionJournalPath(root, sessionID), "utf-8")
    for (const line of raw.split("\n").filter((l) => l.length > 0)) {
      const record = JSON.parse(line) as Record<string, unknown>
      expect(record).not.toHaveProperty("prompt")
      expect(record).not.toHaveProperty("output")
      expect(record).not.toHaveProperty("messages")
      expect(record).not.toHaveProperty("reasoning")
    }
  })

  it("emits session_init on first state creation and session_shutdown on delete", async () => {
    const { hook, writer } = newHookWithAudit(createMockCtx())
    const sessionID = "ses_lifecycle"

    await fireMessageUpdated(hook, sessionID, 600)
    await hook.event({
      event: { type: "session.deleted", properties: { info: { id: sessionID } } },
    })
    await writer.flush()

    const eventNames = readJournal(sessionID).map((e) => e.event)
    expect(eventNames).toContain("session_init")
    expect(eventNames).toContain("session_shutdown")
  })

  it("reports the audit journal path in the live diagnostic", async () => {
    const { hook } = newHookWithAudit(createMockCtx())
    const sessionID = "ses_diag"

    await fireMessageUpdated(hook, sessionID, 600)

    expect(hook.diagnose(sessionID).audit_journal_path).toBe(sessionJournalPath(root, sessionID))
  })

  it("does not change governor behavior when no audit writer is present", async () => {
    const ctx = createMockCtx()
    const hook = createContextGovernorHook(ctx as never, {
      pluginConfig: { context_governor: tinyCfg() } as never,
      modelCacheState: makeCacheStateWithLimit(TINY_LIMIT),
      directory: () => dir,
    })
    const sessionID = "ses_no_audit"

    await fireMessageUpdated(hook, sessionID, 1100)
    hook.ingestVerdict(sessionID, SAFE_VERDICT)
    await fireToolAfter(hook, sessionID, "call_1")

    expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)
  })
})
