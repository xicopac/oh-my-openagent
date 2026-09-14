import { describe, test, expect } from "bun:test"

import { ResourceGovernorConfigSchema } from "../../config/schema/resource-governor"
import {
  createWorkerSupervisor,
  DEFAULT_SUPERVISION_POLICY,
  type WorkerSignal,
} from "../../features/worker-supervisor"
import { authorizeChildDispatch } from "./authorize"
import { createResourceGovernorRuntime, type ResourceGovernorRuntime } from "./runtime"

const PAID_MODEL = "openai/gpt-5.6-sol"
const FREE_MODEL = "kimi-for-coding/kimi-for-coding-highspeed"

function config() {
  return ResourceGovernorConfigSchema.parse({})
}

/**
 * A runtime whose paid-spend has already crossed the hard ceiling
 * (normal mode hard_usd === 3.0).
 */
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

/**
 * A runtime with a free model priced at $0 and no ceiling pressure, so a free
 * replacement is the only plausible re-dispatch.
 */
function freeRuntime(): ResourceGovernorRuntime {
  return createResourceGovernorRuntime({
    config: config(),
    pricing: { [FREE_MODEL]: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
  })
}

/** A paid child that has consumed its entire escrow budget (-> EXHAUSTED). */
function exhaustedPaidWorker(): WorkerSignal {
  return {
    workerID: "w1",
    sessionID: "s1",
    status: "running",
    nowMs: 1_000_000,
    lastActivityAtMs: 1_000_000,
    lastMeaningfulProgressAtMs: 1_000_000,
    tokensDelta: 0,
    toolCallsDelta: 0,
    currentTool: null,
    filesChangedDelta: 0,
    outputTail: "",
    isLongRunningCommand: false,
    commandActive: false,
    commandElapsedMs: 0,
    childTokenBudget: 600_000,
    childTokensUsed: 600_000,
    isPaid: true,
    insecureChecks: 0,
  }
}

function paidReplacement() {
  return {
    sessionID: "parent-session",
    role: "explore",
    subtask: "retry the failed investigation",
    resolvedModelID: PAID_MODEL,
    requestedTier: null,
    expectedTokens: 600_000,
    rootModelID: null,
  }
}

describe("replacement budget (supervisor RECLAIM -> governor gate)", () => {
  test("a paid worker burned its escrow, the supervisor reclaims it, and a paid replacement is blocked at the hard ceiling", () => {
    // given the supervisor observes a paid child that exhausted its budget
    const supervisor = createWorkerSupervisor(DEFAULT_SUPERVISION_POLICY)
    const reclaim = supervisor.check(exhaustedPaidWorker())
    expect(reclaim.health).toBe("EXHAUSTED")
    expect(reclaim.intervention.action).toBe("RECLAIM")
    expect(reclaim.intervention.preservePartial).toBe(true)

    // when the root re-dispatches a paid replacement past the paid ceiling
    const result = authorizeChildDispatch(exhaustedRuntime(), paidReplacement())

    // then the replacement is blocked, so a reclaim cycle cannot spend past the hard ceiling
    expect(result.verdict).toBe("BLOCK")
    if (result.verdict === "BLOCK") {
      expect(result.condition).toBe("RESOURCE_BUDGET_EXHAUSTED")
    }
  })

  test("a free replacement is still allowed after a paid worker is reclaimed", () => {
    // given a supervisor that reclaimed a paid worker
    const supervisor = createWorkerSupervisor(DEFAULT_SUPERVISION_POLICY)
    expect(supervisor.check(exhaustedPaidWorker()).intervention.action).toBe("RECLAIM")

    // when the root re-dispatches a $0 replacement instead
    const result = authorizeChildDispatch(freeRuntime(), {
      ...paidReplacement(),
      resolvedModelID: FREE_MODEL,
    })

    // then the free worker may proceed
    expect(result.verdict).toBe("ALLOW")
  })
})
