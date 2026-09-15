import { describe, expect, test } from "bun:test"
import { createDelegationLadder } from "./attempts"
import { recommendNextAction } from "./ladder"
import { refineAssignment } from "./refinement"
import { DEFAULT_DELEGATION_LADDER_CONFIG } from "./types"
import type { AttemptResult, WorkerCandidate } from "./types"

function worker(overrides: Partial<WorkerCandidate> = {}): WorkerCandidate {
  return {
    model_id: "free-model",
    tier: "free",
    capability: 0.5,
    free: true,
    ...overrides,
  }
}

function result(overrides: Partial<AttemptResult> = {}): AttemptResult {
  return {
    adequate: false,
    objective: "find the auth entry point",
    status: "incomplete",
    findings: [],
    confidence: 0.3,
    unresolved: [],
    ...overrides,
  }
}

const FREE = worker({ model_id: "free-model", tier: "free", free: true })
const FREE_ALT = worker({ model_id: "free-alt-model", tier: "free_alt", free: true })
const PAID = worker({ model_id: "paid-model", tier: "cheap_paid", free: false, cost_usd_per_1m_input: 3 })

describe("delegation ladder", () => {
  test("starts a delegable task by selecting the first worker on attempt 1", () => {
    // given
    const events: string[] = []
    const ladder = createDelegationLadder({}, { onEvent: (_job, event) => events.push(event) })

    // when
    ladder.start("job-1", "find the auth entry point", [FREE, PAID])

    // then
    const state = ladder.get("job-1")
    expect(state?.workerIndex).toBe(0)
    expect(state?.attemptsInTier).toBe(0)
    expect(state?.totalAttempts).toBe(0)
    expect(events).toContain("delegation_first_selected")
    expect(events).toContain("worker_attempt_started")
  })

  test("a weak free result yields retry_refined on the same worker and preserves findings", () => {
    // given
    const ladder = createDelegationLadder()
    ladder.start("job-1", "find the auth entry point", [FREE, PAID])

    // when
    const action = ladder.record("job-1", result({
      findings: [{ type: "file", summary: "auth.ts", anchors: ["src/auth.ts:12"] }],
      unresolved: ["which middleware guards /login"],
    }))

    // then
    expect(action.kind).toBe("retry_refined")
    if (action.kind === "retry_refined") {
      expect(action.sameWorker.model_id).toBe(FREE.model_id)
      expect(action.preserveFindings).toHaveLength(1)
    }
    const findings = ladder.findings("job-1")
    expect(findings.some((f) => f.type === "file" && f.summary === "auth.ts")).toBe(true)
    expect(findings.some((f) => f.type === "unresolved" && f.summary === "which middleware guards /login")).toBe(true)
  })

  test("escalates to the next worker after escalate_after_attempts weak results", () => {
    // given
    const ladder = createDelegationLadder()
    ladder.start("job-1", "find the auth entry point", [FREE, PAID])

    // when: two weak results exhaust the tier
    ladder.record("job-1", result({ findings: [{ type: "note", summary: "first pass" }] }))
    const action = ladder.record("job-1", result({ findings: [{ type: "note", summary: "second pass" }] }))

    // then
    expect(action.kind).toBe("escalate")
    if (action.kind === "escalate") {
      expect(action.worker.model_id).toBe(PAID.model_id)
      expect(action.reason).toBe("attempt_threshold")
      expect(action.preserveFindings).toHaveLength(1)
    }
    expect(ladder.get("job-1")?.workerIndex).toBe(1)
    expect(ladder.get("job-1")?.attemptsInTier).toBe(0)
  })

  test("gives up after exhausting every worker", () => {
    // given
    const ladder = createDelegationLadder()
    ladder.start("job-1", "find the auth entry point", [FREE, PAID])

    // when: exhaust the free tier, then the paid tier
    ladder.record("job-1", result())
    ladder.record("job-1", result())
    ladder.record("job-1", result())
    const action = ladder.record("job-1", result())

    // then
    expect(action.kind).toBe("give_up")
    if (action.kind === "give_up") {
      expect(action.reason).toBe("no_sufficient_worker")
    }
  })

  test("never selects a free:false worker before a free:true worker when the free worker is first", () => {
    // given: a free:false worker whose id could be mistaken for free, listed after a free:true worker
    const unpriced = worker({ model_id: "free-sounding-model", tier: "free_alt", free: false })
    const ladder = createDelegationLadder()

    // when
    ladder.start("job-1", "find the auth entry point", [FREE, unpriced])

    // then
    const state = ladder.get("job-1")
    expect(state?.workers[state.workerIndex].model_id).toBe(FREE.model_id)
    expect(state?.workers[state.workerIndex].free).toBe(true)
  })
})

describe("recommendNextAction (pure)", () => {
  test("returns done for an adequate result", () => {
    // given
    const input = {
      attemptsInTier: 0,
      totalFreeAttempts: 0,
      currentWorker: FREE,
      result: result({ adequate: true }),
      workers: [FREE, PAID],
      config: DEFAULT_DELEGATION_LADDER_CONFIG,
      refinedPrompt: "refined",
    }

    // when
    const action = recommendNextAction(input)

    // then
    expect(action.kind).toBe("done")
  })

  test("returns give_up with expert_exhausted when the expert tier is the last worker", () => {
    // given
    const expert = worker({ model_id: "expert-model", tier: "expert", free: false })
    const input = {
      attemptsInTier: 2,
      totalFreeAttempts: 4,
      currentWorker: expert,
      result: result(),
      workers: [expert],
      config: DEFAULT_DELEGATION_LADDER_CONFIG,
      refinedPrompt: "refined",
    }

    // when
    const action = recommendNextAction(input)

    // then
    expect(action.kind).toBe("give_up")
    if (action.kind === "give_up") {
      expect(action.reason).toBe("expert_exhausted")
    }
  })

  test("escalates with free_exhausted when free attempts are spent but the tier is not", () => {
    // given
    const input = {
      attemptsInTier: 1,
      totalFreeAttempts: 4,
      currentWorker: FREE,
      result: result(),
      workers: [FREE, PAID],
      config: DEFAULT_DELEGATION_LADDER_CONFIG,
      refinedPrompt: "refined",
    }

    // when
    const action = recommendNextAction(input)

    // then
    expect(action.kind).toBe("escalate")
    if (action.kind === "escalate") {
      expect(action.reason).toBe("free_exhausted")
    }
  })
})

describe("refineAssignment", () => {
  test("narrows scope to unresolved items and carries forward known anchors", () => {
    // given
    const attempt = result({
      findings: [{ type: "file", summary: "auth.ts", anchors: ["src/auth.ts:12"] }],
      unresolved: ["which middleware guards /login"],
    })

    // when
    const refined = refineAssignment("find the auth entry point", attempt)

    // then
    expect(refined).toContain("which middleware guards /login")
    expect(refined).toContain("src/auth.ts:12")
    expect(refined).toContain("find the auth entry point")
  })
})
