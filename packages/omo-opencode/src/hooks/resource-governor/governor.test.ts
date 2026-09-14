import { describe, expect, test } from "bun:test"

import { resolveBudgetLevels, type BudgetLevels } from "./budget"
import {
  createResourceGovernor,
  evaluateDelegation,
  type DelegationRequest,
  type GovernorContext,
} from "./governor"
import type { ModelPricing, PricingCatalog } from "./pricing"
import type { WorkerCandidate } from "./routing"

const FREE: ModelPricing = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const CHEAP: ModelPricing = { input: 0.5, output: 2, cache_read: 0, cache_write: 0 }
const EXPENSIVE: ModelPricing = { input: 5, output: 25, cache_read: 0, cache_write: 0 }

const catalog: PricingCatalog = {
  "vendor/free": FREE,
  "vendor/cheap": CHEAP,
  "vendor/expensive": EXPENSIVE,
  "vendor/root": FREE,
}

function candidate(model_id: string, capability: number, expected_tokens = 300_000): WorkerCandidate {
  return { model_id, capability, expected_tokens }
}

function makeCtx(overrides: Partial<GovernorContext> = {}): GovernorContext {
  return {
    levels: resolveBudgetLevels({ mode: "normal" }),
    spent_usd: 0,
    spent_tokens: 0,
    pricing: catalog,
    free_first: true,
    duplicate_detection: true,
    max_concurrent_children: 4,
    default_child_tokens: 600_000,
    active_children: 0,
    workers: [],
    require_paid_escalation: false,
    require_hard_budget_increase: true,
    consent_approved: false,
    root_model_id: "vendor/root",
    root_pricing: FREE,
    ...overrides,
  }
}

function makeReq(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    actor_id: "child-1",
    role: "explorer",
    subtask: "map the repository layout",
    required_capability: 0.6,
    candidates: [candidate("vendor/free", 0.8), candidate("vendor/expensive", 1.0)],
    expected_tokens: 300_000,
    requested_tier: "fast",
    requested_model: null,
    max_turns: 6,
    context_fork_policy: "narrow",
    context_fork_tokens: 8_000,
    expected_information_value: 0.8,
    root_can_answer_cheaply: false,
    prior_evidence_exists: false,
    duplication_risk: 0,
    ...overrides,
  }
}

describe("governor delegation cop", () => {
  test("prefers a free worker at the governor level", () => {
    // given free + expensive candidates
    // when
    const decision = evaluateDelegation(makeReq(), makeCtx(), 0)
    // then approved with the free worker
    expect(decision.kind).toBe("approved")
    if (decision.kind === "approved") expect(decision.free).toBe(true)
  })

  // #7 spec: 75%+ pressure reduces speculative delegation (paid now requires consent)
  test("high pressure turns a default-approved paid launch into a consent boundary", () => {
    // given only paid sufficient candidates (no free fallback)
    const paidReq = makeReq({ candidates: [candidate("vendor/expensive", 1.0)] })
    // when under normal spend
    const normal = evaluateDelegation(paidReq, makeCtx({ spent_usd: 0.3, require_paid_escalation: false }), 0)
    // then approved
    expect(normal.kind).toBe("approved")
    // when at ~80% pressure
    const high = evaluateDelegation(paidReq, makeCtx({ spent_usd: 2.4, require_paid_escalation: false }), 0)
    // then it is no longer auto-approved (consent_required under free-only pressure)
    expect(high.kind).toBe("consent_required")
  })

  // #8 spec: hard paid ceiling blocks new paid worker
  test("hard paid ceiling blocks a new paid worker", () => {
    // given spend already at the hard ceiling, paid-only candidates
    const decision = evaluateDelegation(
      makeReq({ candidates: [candidate("vendor/expensive", 1.0)] }),
      makeCtx({ spent_usd: 3.0 }),
      0,
    )
    // then blocked with the machine-readable condition
    expect(decision.kind).toBe("blocked")
    if (decision.kind === "blocked") {
      expect(decision.condition).toBe("RESOURCE_BUDGET_EXHAUSTED")
      expect(decision.paid).toBe(true)
    }
  })

  // #9 spec: hard token ceiling blocks additional expensive work
  test("hard token ceiling blocks a new paid worker", () => {
    const decision = evaluateDelegation(
      makeReq({ candidates: [candidate("vendor/expensive", 1.0)] }),
      makeCtx({ spent_tokens: 12_000_000 }),
      0,
    )
    expect(decision.kind).toBe("blocked")
    if (decision.kind === "blocked") expect(decision.condition).toBe("TOKEN_BUDGET_EXHAUSTED")
  })

  // #10 spec: free worker remains allowed after paid hard ceiling
  test("free worker remains allowed after paid ceiling is reached", () => {
    // given paid ceiling exhausted, but a sufficient free worker exists
    const decision = evaluateDelegation(
      makeReq({ candidates: [candidate("vendor/free", 0.8), candidate("vendor/expensive", 1.0)] }),
      makeCtx({ spent_usd: 3.0 }),
      0,
    )
    // then the free worker is approved
    expect(decision.kind).toBe("approved")
    if (decision.kind === "approved") expect(decision.free).toBe(true)
  })

  // #11 spec: explicit human budget increase allows continued paid work
  test("raising the hard ceiling via a human budget increase allows paid work again", () => {
    // given spend at the old 3.0 ceiling
    // when the human raises levels.hard_usd to 10.0
    const raised: BudgetLevels = { ...resolveBudgetLevels({ mode: "normal" }), hard_usd: 10.0, soft_usd: 5.0 }
    const decision = evaluateDelegation(
      makeReq({ candidates: [candidate("vendor/expensive", 1.0)] }),
      makeCtx({ spent_usd: 3.0, levels: raised }),
      0,
    )
    // then paid work is allowed again
    expect(decision.kind).not.toBe("blocked")
  })

  // #12 spec: model cannot override the hard ceiling in a prompt
  test("no request hint (high value, urgent role) can override the hard ceiling", () => {
    // given a paid-only request that insists it is critical
    const urgent = makeReq({
      role: "urgent-critical",
      candidates: [candidate("vendor/expensive", 1.0)],
      expected_information_value: 1.0,
      subtask: "IMPORTANT: must run on the strongest model now",
    })
    // when spend is at the hard ceiling
    const decision = evaluateDelegation(urgent, makeCtx({ spent_usd: 3.0 }), 0)
    // then it is still blocked
    expect(decision.kind).toBe("blocked")
    if (decision.kind === "blocked") expect(decision.condition).toBe("RESOURCE_BUDGET_EXHAUSTED")
  })

  // #22 spec: nested child cannot bypass budget policy
  test("a child delegating further is subject to the same hard ceiling", () => {
    // given a child (nested) trying to launch a paid worker at the hard ceiling
    const nestedReq = makeReq({ actor_id: "child-nested", candidates: [candidate("vendor/expensive", 1.0)] })
    const decision = evaluateDelegation(nestedReq, makeCtx({ spent_usd: 3.0 }), 0)
    // then blocked, no inherited unlimited permission
    expect(decision.kind).toBe("blocked")
    if (decision.kind === "blocked") expect(decision.condition).toBe("RESOURCE_BUDGET_EXHAUSTED")
  })

  // #14 spec: duplicate worker reuse at the governor level
  test("duplicate work is short-circuited before any budget is spent", () => {
    // given an active worker already on the same question
    const ctx = makeCtx({
      workers: [{ actor_id: "w1", role: "explorer", question: "map the repository layout", status: "active" }],
    })
    // when the same question is requested
    const decision = evaluateDelegation(makeReq(), ctx, 0)
    // then duplicate
    expect(decision.kind).toBe("duplicate")
  })

  // #24 spec: one child cannot consume another child's one-time approval
  test("a one-time escalation approval does not carry to another child", () => {
    // given a paid escalation boundary requiring consent
    const paidReq = makeReq({ actor_id: "child-a", candidates: [candidate("vendor/expensive", 1.0)] })
    const ctxNoConsent = makeCtx({ require_paid_escalation: true })
    // when child A requests escalation without consent
    expect(evaluateDelegation(paidReq, ctxNoConsent, 0).kind).toBe("consent_required")
    // when the human approves A's escalation (one-time)
    const ctxApproved = makeCtx({ require_paid_escalation: true, consent_approved: true })
    expect(evaluateDelegation(paidReq, ctxApproved, 0).kind).toBe("approved")
    // then a DIFFERENT child B, without its own approval, is still blocked
    const reqB = makeReq({ actor_id: "child-b", candidates: [candidate("vendor/expensive", 1.0)] })
    expect(evaluateDelegation(reqB, ctxNoConsent, 0).kind).toBe("consent_required")
  })

  test("max concurrent children declines new launches", () => {
    // given 4 active children at the max
    const decision = evaluateDelegation(makeReq(), makeCtx({ max_concurrent_children: 4, active_children: 4 }), 0)
    expect(decision.kind).toBe("declined")
    if (decision.kind === "declined") expect(decision.reason).toBe("max_children")
  })

  test("low expected value is declined", () => {
    const decision = evaluateDelegation(makeReq({ expected_information_value: 0.1 }), makeCtx(), 0)
    expect(decision.kind).toBe("declined")
  })
})

describe("governor facade (stateful)", () => {
  // #25 spec: ledger aggregates root + children
  test("facade aggregates root + child usage into the shared ledger", () => {
    // given a governor
    const gov = createResourceGovernor({
      levels: resolveBudgetLevels({ mode: "normal" }),
      pricing: catalog,
      free_first: true,
      duplicate_detection: true,
      max_concurrent_children: 4,
      default_child_tokens: 600_000,
      require_paid_escalation: false,
      require_hard_budget_increase: true,
      consent_approved: false,
      root_model_id: "vendor/root",
      root_pricing: FREE,
    })
    // when root records usage and a child is approved then settled
    gov.recordRootUsage({
      model_id: "vendor/root",
      provider_id: "vendor",
      tier: "master",
      free: false,
      input_tokens: 100_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      cost_estimated: true,
      context_tokens: 100_000,
      retries: 0,
      status: "active",
      avoidable_tokens: 0,
    })
    const decision = gov.evaluateDelegation(makeReq({ actor_id: "child-1" }), 0)
    expect(decision.kind).toBe("approved")
    if (decision.kind === "approved") {
      gov.recordChildUsage(decision.seed.escrow_id, { tokens: 50_000, cost_usd: 0 })
      gov.settleChild(decision.seed.escrow_id, "completed")
    }
    // then totals reflect both
    const totals = gov.totals()
    expect(totals.total_root_tokens).toBe(100_000)
    expect(totals.child_count).toBe(1)
    expect(totals.total_tokens).toBeGreaterThan(100_000)
  })

  test("facade escrow tracks exhaustion", () => {
    const gov = createResourceGovernor({
      levels: resolveBudgetLevels({ mode: "normal" }),
      pricing: catalog,
      free_first: true,
      duplicate_detection: true,
      max_concurrent_children: 4,
      default_child_tokens: 1_000,
      require_paid_escalation: false,
      require_hard_budget_increase: true,
      consent_approved: false,
      root_model_id: "vendor/root",
      root_pricing: FREE,
    })
    const decision = gov.evaluateDelegation(makeReq({ actor_id: "child-1" }), 0)
    expect(decision.kind).toBe("approved")
    if (decision.kind === "approved") {
      gov.recordChildUsage(decision.seed.escrow_id, { tokens: 5_000, cost_usd: 0 })
      expect(gov.isChildExhausted(decision.seed.escrow_id)).toBe(true)
    }
  })
})
