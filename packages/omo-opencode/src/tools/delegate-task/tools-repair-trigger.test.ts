// ROOT_REPAIR_MODE TRIGGER ON PAID-GATE BLOCK (regression)
// An ordinary child launch that is BLOCKED at the paid gate / paid-slot
// acquisition / consent-consumed stage returns an error string to the caller
// BEFORE a child session is created and BEFORE background-task.ts runs, so
// noteChildStartupFailure was never reached there. The parent root therefore
// never entered ROOT_REPAIR_MODE and the worker-first gate deadlocked the root
// out of all validation/remediation. These tests pin the tools.ts wiring that
// fires noteChildStartupFailure on those early-return paths.
declare const require: NodeJS.Require
const { describe, expect, test, spyOn, mock, beforeEach } = require("bun:test")
import { createDelegationFirstRuntime } from "../../features/delegation-first"
import { PaidConsentRegistry } from "./paid-consent"
import * as executor from "./executor"

const runtimeRequire = require as NodeJS.Require & { cache?: Record<string, unknown> }

function clearRequireCache(modulePath: string): void {
  const resolvedPath = runtimeRequire.resolve(modulePath)
  if (runtimeRequire.cache?.[resolvedPath]) {
    delete runtimeRequire.cache[resolvedPath]
  }
}

const testPaidConsentRegistry = new PaidConsentRegistry()
const testApprovingAsk = async (): Promise<void> => {}
const PAID_MODEL = "openai/gpt-5.6-sol"
const PAID_PRICING = { [PAID_MODEL]: { input: 10, output: 30, cache_read: 0, cache_write: 0 } }

function makeToolContext(): Record<string, unknown> {
  return {
    sessionID: "root-session",
    messageID: "root-message",
    agent: "sisyphus",
    abort: new AbortController().signal,
    ask: testApprovingAsk,
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

function makeTool(rt: ReturnType<typeof createDelegationFirstRuntime>): { execute: (args: unknown, ctx: unknown) => Promise<unknown> } {
  const { createDelegateTask } = require("./tools")
  return createDelegateTask({
    paidConsentRegistry: testPaidConsentRegistry,
    isRootSession: true,
    manager: { launch: async () => ({}) },
    client: makeMockClient(),
    delegationFirstRuntime: rt,
    pricingCatalog: PAID_PRICING,
  })
}

describe("delegate-task paid-gate block triggers ROOT_REPAIR_MODE", () => {
  beforeEach(() => {
    mock.restore()
    clearRequireCache("./tools")
  })

  test("paid-slot exhaustion fires noteChildStartupFailure with paid_slot_exhaustion", async () => {
    // given - a real delegation-first runtime whose single paid slot is already
    // held, so the tool's tryAcquirePaidChild returns false (concurrency limit).
    const rt = createDelegationFirstRuntime(undefined)
    expect(rt.tryAcquirePaidChild()).toBe(true)
    const noteSpy = spyOn(rt, "noteChildStartupFailure")

    const tool = makeTool(rt)
    const resolveCategorySpy = spyOn(executor, "resolveCategoryExecution").mockResolvedValue({
      agentToUse: "Sisyphus-Junior",
      categoryModel: { providerID: "openai", modelID: "gpt-5.6-sol" },
      categoryPromptAppend: undefined,
      modelInfo: { model: PAID_MODEL, type: "user-defined", source: "override" },
      actualModel: PAID_MODEL,
      isUnstableAgent: false,
    })

    // when - a paid child launch is blocked at the paid-slot acquisition stage
    const result = await tool.execute(
      { description: "paid slot", prompt: "do it", category: "deep", run_in_background: true, load_skills: [] },
      makeToolContext(),
    )

    // then - the returned message is preserved exactly and the runtime received
    // the repair trigger for the parent root session.
    expect(String(result)).toContain("PAID_WORKER_CONCURRENCY_LIMIT")
    expect(noteSpy).toHaveBeenCalledWith("root-session", null, "paid_slot_exhaustion")

    resolveCategorySpy.mockRestore()
    noteSpy.mockRestore()
    await rt.dispose()
  })

  test("paid-gate block fires noteChildStartupFailure with paid_gate_block", async () => {
    // given - a real runtime and a paid resolved model, but the operator denies
    // the paid launch so gatePaidChildLaunch returns a block message.
    const rt = createDelegationFirstRuntime(undefined)
    const noteSpy = spyOn(rt, "noteChildStartupFailure")

    const tool = makeTool(rt)
    const resolveCategorySpy = spyOn(executor, "resolveCategoryExecution").mockResolvedValue({
      agentToUse: "Sisyphus-Junior",
      categoryModel: { providerID: "openai", modelID: "gpt-5.6-sol" },
      categoryPromptAppend: undefined,
      modelInfo: { model: PAID_MODEL, type: "user-defined", source: "override" },
      actualModel: PAID_MODEL,
      isUnstableAgent: false,
    })

    // when - the operator denies the paid launch (ask throws -> denied)
    const denyingAsk = async (): Promise<void> => {
      throw new Error("denied")
    }
    const result = await tool.execute(
      { description: "paid gate", prompt: "do it", category: "deep", run_in_background: true, load_skills: [] },
      { ...makeToolContext(), ask: denyingAsk },
    )

    // then - the block message is preserved and the repair trigger fired.
    expect(String(result)).toContain("PAID_WORKER_CONSENT_DENIED")
    expect(noteSpy).toHaveBeenCalledWith("root-session", null, "paid_gate_block")

    resolveCategorySpy.mockRestore()
    noteSpy.mockRestore()
    await rt.dispose()
  })

  test("PAID_ESCALATION_REQUIRED resolution error does NOT fire noteChildStartupFailure", async () => {
    // given - a real runtime and a resolution error (free-pool exhaustion for an
    // ordinary child). This is the CORRECT designed outcome, not a machinery
    // failure, so it must NOT enter ROOT_REPAIR_MODE.
    const rt = createDelegationFirstRuntime(undefined)
    const noteSpy = spyOn(rt, "noteChildStartupFailure")

    const tool = makeTool(rt)
    const resolveCategorySpy = spyOn(executor, "resolveCategoryExecution").mockResolvedValue({
      agentToUse: "",
      categoryModel: undefined,
      categoryPromptAppend: undefined,
      modelInfo: undefined,
      actualModel: undefined,
      isUnstableAgent: false,
      error: "PAID_ESCALATION_REQUIRED: no eligible free model satisfies role requirements for agent \"deep\" (tier \"deep\").",
    })

    // when - the free-only resolver refuses to auto-escalate an ordinary child
    const result = await tool.execute(
      { description: "escalation", prompt: "do it", category: "deep", run_in_background: true, load_skills: [] },
      makeToolContext(),
    )

    // then - the escalation message is returned and no repair trigger fired.
    expect(String(result)).toContain("PAID_ESCALATION_REQUIRED")
    expect(noteSpy).not.toHaveBeenCalled()

    resolveCategorySpy.mockRestore()
    noteSpy.mockRestore()
    await rt.dispose()
  })
})
