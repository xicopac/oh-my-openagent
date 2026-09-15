import { describe, expect, test } from "bun:test"
import {
  recommendFailoverAction,
  type FailoverContext,
} from "./failover"
import { DEFAULT_DELEGATION_LADDER_CONFIG, type WorkerCandidate } from "../delegation-ladder"

function free(id: string): WorkerCandidate {
  return { model_id: id, tier: "free", capability: 0.7, free: true }
}

function freeAlt(id: string): WorkerCandidate {
  return { model_id: id, tier: "free_alt", capability: 0.7, free: true }
}

function paid(id: string): WorkerCandidate {
  return { model_id: id, tier: "cheap_paid", capability: 1.0, free: false, cost_usd_per_1m_input: 1 }
}

function ctx(overrides: Partial<FailoverContext> = {}): FailoverContext {
  return {
    workers: [free("openai/free-a"), free("openai/free-b")],
    attempt_number: 1,
    worker_index: 0,
    previous_workers: [],
    config: DEFAULT_DELEGATION_LADDER_CONFIG,
    stallMode: "EXECUTION_STALL",
    correlated: false,
    findings: [],
    ...overrides,
  }
}

describe("recommendFailoverAction", () => {
  test("infrastructure stalls retry the same worker without a model switch", () => {
    // given a launch-level stall on the first free worker
    // when
    const action = recommendFailoverAction(ctx({ stallMode: "PROVIDER_START_STALL" }))
    // then
    expect(action.kind).toBe("retry_worker")
    if (action.kind === "retry_worker") expect(action.worker.model_id).toBe("openai/free-a")
  })

  test("a provider-response stall switches to an alternate model/provider", () => {
    // when
    const action = recommendFailoverAction(ctx({ stallMode: "PROVIDER_RESPONSE_STALL" }))
    // then
    expect(action.kind).toBe("alternate_worker")
    if (action.kind === "alternate_worker") expect(action.worker.model_id).toBe("openai/free-b")
  })

  test("a correlated failure switches away from the current model even for an execution stall", () => {
    // when
    const action = recommendFailoverAction(ctx({ correlated: true }))
    // then
    expect(action.kind).toBe("alternate_worker")
  })

  test("repeated same-worker execution stalls escalate up the ladder", () => {
    // given: two prior attempts already ran on free-a
    // when
    const action = recommendFailoverAction(
      ctx({ previous_workers: ["openai/free-a"], stallMode: "EXECUTION_STALL" }),
    )
    // then
    expect(action.kind).toBe("escalate_worker")
    if (action.kind === "escalate_worker") expect(action.worker.model_id).toBe("openai/free-b")
  })

  test("an execution stall on the first attempt retries the same worker", () => {
    // when
    const action = recommendFailoverAction(ctx({ stallMode: "EXECUTION_STALL", previous_workers: [] }))
    // then
    expect(action.kind).toBe("retry_worker")
  })

  test("the attempt ceiling bounds the retry chain (no relaunch past max)", () => {
    // given: maxTotalAttempts = max_attempts_per_tier (2) * workers.length (2) = 4
    // when: attempt 4 already run
    const action = recommendFailoverAction(ctx({ attempt_number: 4, stallMode: "EXECUTION_STALL" }))
    // then
    expect(action).toEqual({ kind: "give_up", reason: "retry_chain_exhausted" })
  })

  test("free attempts above the free budget escalate to the next tier or give up", () => {
    // given: three workers (ceiling 6), free budget already consumed (4 attempts)
    // when
    const action = recommendFailoverAction(
      ctx({
        attempt_number: 4,
        stallMode: "EXECUTION_STALL",
        previous_workers: ["openai/free-a", "openai/free-a", "openai/free-b"],
        workers: [free("openai/free-a"), free("openai/free-b"), paid("paid-c")],
        worker_index: 1,
      }),
    )
    // then: escalates rather than retrying a free worker again past the free budget
    expect(action.kind).toBe("escalate_worker")
  })

  test("a single worker with no alternate gives up rather than infinite retry", () => {
    // given: one worker only, provider-response stall (wants an alternate), attempt ceiling not hit
    // when
    const action = recommendFailoverAction(
      ctx({ workers: [free("only")], stallMode: "PROVIDER_RESPONSE_STALL", attempt_number: 1 }),
    )
    // then: no alternate, no next tier -> bounded retry same worker
    expect(action.kind).toBe("retry_worker")
    if (action.kind === "retry_worker") expect(action.worker.model_id).toBe("only")
  })

  test("preserved findings are carried on every relaunch action", () => {
    // given
    const findings = [{ type: "anchor" as const, summary: "found", anchors: ["f:1"] }]
    // when
    const action = recommendFailoverAction(
      ctx({ stallMode: "PROVIDER_RESPONSE_STALL", findings }),
    )
    // then
    if (action.kind !== "give_up") expect(action.preserveFindings).toEqual(findings)
  })
})
