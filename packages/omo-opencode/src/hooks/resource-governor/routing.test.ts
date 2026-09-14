import { describe, expect, test } from "bun:test"

import type { PricingCatalog, ModelPricing } from "./pricing"
import {
  evaluateDelegationValue,
  recommendPaidEscalation,
  selectWorker,
  type WorkerCandidate,
} from "./routing"

const FREE: ModelPricing = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const PAID_CHEAP: ModelPricing = { input: 0.5, output: 2, cache_read: 0, cache_write: 0 }
const PAID_EXPENSIVE: ModelPricing = { input: 5, output: 25, cache_read: 0, cache_write: 0 }

const catalog: PricingCatalog = {
  "vendor/free": FREE,
  "vendor/cheap": PAID_CHEAP,
  "vendor/expensive": PAID_EXPENSIVE,
}

function candidate(model_id: string, capability: number, expected_tokens = 300_000): WorkerCandidate {
  return { model_id, capability, expected_tokens }
}

describe("routing", () => {
  // #3 spec: free suitable worker preferred over paid
  test("selectWorker prefers a sufficient $0 worker over a paid one", () => {
    // given a free worker and an expensive worker, both sufficient
    // when
    const result = selectWorker({
      candidates: [candidate("vendor/expensive", 1.0), candidate("vendor/free", 0.8)],
      required_capability: 0.7,
      pricing: catalog,
      free_first: true,
      prefer_free_only: false,
      max_paid_usd: 5,
    })
    // then the free worker is selected even though less capable
    expect(result.kind).toBe("selected")
    if (result.kind === "selected") {
      expect(result.free).toBe(true)
      expect(result.candidate.model_id).toBe("vendor/free")
    }
  })

  test("selectWorker rejects insufficient candidates", () => {
    // given a free worker below the required capability and a sufficient paid one
    // when free_first is false, the sufficient paid worker is chosen
    const result = selectWorker({
      candidates: [candidate("vendor/free", 0.3), candidate("vendor/cheap", 0.8)],
      required_capability: 0.6,
      pricing: catalog,
      free_first: false,
      prefer_free_only: false,
      max_paid_usd: 5,
    })
    expect(result.kind).toBe("selected")
    if (result.kind === "selected") expect(result.candidate.model_id).toBe("vendor/cheap")
  })

  // #8 spec: cheapest sufficient first (not strongest)
  test("chooses cheapest sufficient paid worker, not strongest", () => {
    // given cheap and expensive sufficient paid workers
    // when
    const result = selectWorker({
      candidates: [candidate("vendor/expensive", 1.0), candidate("vendor/cheap", 0.7)],
      required_capability: 0.6,
      pricing: catalog,
      free_first: false,
      prefer_free_only: false,
      max_paid_usd: 5,
    })
    // then the cheaper one wins
    expect(result.kind).toBe("selected")
    if (result.kind === "selected") expect(result.candidate.model_id).toBe("vendor/cheap")
  })

  test("paid worker blocked when over remaining budget cap", () => {
    // given max_paid_usd lower than the cheapest paid worker's cost
    const result = selectWorker({
      candidates: [candidate("vendor/expensive", 1.0)],
      required_capability: 0.5,
      pricing: catalog,
      free_first: false,
      prefer_free_only: false,
      max_paid_usd: 0.1,
    })
    expect(result.kind).toBe("paid_blocked")
  })

  test("free-only pressure blocks paid when a free worker exists", () => {
    // given high pressure and both free and paid sufficient
    const result = selectWorker({
      candidates: [candidate("vendor/free", 0.7), candidate("vendor/expensive", 1.0)],
      required_capability: 0.6,
      pricing: catalog,
      free_first: true,
      prefer_free_only: true,
      max_paid_usd: 5,
    })
    expect(result.kind).toBe("selected")
    if (result.kind === "selected") expect(result.free).toBe(true)
  })

  // #11 spec: expected value before delegation
  test("evaluateDelegationValue declines cheap root answers", () => {
    expect(evaluateDelegationValue({
      expected_information_value: 0.9,
      cost_usd: 0.5,
      context_cost_tokens: 10_000,
      root_can_answer_cheaply: true,
      prior_evidence_exists: false,
      duplication_risk: 0,
    })).toEqual({ justified: false, reason: "root_can_answer" })
  })

  test("evaluateDelegationValue declines when prior evidence exists", () => {
    expect(evaluateDelegationValue({
      expected_information_value: 0.9,
      cost_usd: 0.5,
      context_cost_tokens: 10_000,
      root_can_answer_cheaply: false,
      prior_evidence_exists: true,
      duplication_risk: 0,
    })).toEqual({ justified: false, reason: "prior_evidence" })
  })

  test("evaluateDelegationValue declines low information value", () => {
    expect(evaluateDelegationValue({
      expected_information_value: 0.1,
      cost_usd: 0.5,
      context_cost_tokens: 10_000,
      root_can_answer_cheaply: false,
      prior_evidence_exists: false,
      duplication_risk: 0,
    })).toEqual({ justified: false, reason: "low_value" })
  })

  test("evaluateDelegationValue justifies a valuable gap", () => {
    expect(evaluateDelegationValue({
      expected_information_value: 0.8,
      cost_usd: 0.5,
      context_cost_tokens: 8_000,
      root_can_answer_cheaply: false,
      prior_evidence_exists: false,
      duplication_risk: 0,
    })).toEqual({ justified: true, reason: "justified" })
  })

  // #17 spec: free-first can escalate after bounded repeated failure
  test("recommendPaidEscalation triggers after bounded failures when cheaper", () => {
    // given 4 free failures already burning 1M root tokens at $2/M, vs a paid worker costing $1
    // when
    const result = recommendPaidEscalation({
      free_failures: 4,
      max_free_failures: 3,
      root_tokens_consumed_interpreted: 1_000_000,
      paid_expected_cost_usd: 1.0,
      token_to_usd_rate: 2 / 1_000_000,
    })
    // then escalate (root cost ~$2 > $1 paid)
    expect(result.escalate).toBe(true)
  })

  test("does not escalate before the failure bound", () => {
    const result = recommendPaidEscalation({
      free_failures: 1,
      max_free_failures: 3,
      root_tokens_consumed_interpreted: 1_000_000,
      paid_expected_cost_usd: 0.1,
      token_to_usd_rate: 2 / 1_000_000,
    })
    expect(result.escalate).toBe(false)
    if (!result.escalate) expect(result.reason).toBe("under_threshold")
  })

  test("does not escalate when paid is more expensive overall", () => {
    const result = recommendPaidEscalation({
      free_failures: 4,
      max_free_failures: 3,
      root_tokens_consumed_interpreted: 100_000,
      paid_expected_cost_usd: 5.0,
      token_to_usd_rate: 2 / 1_000_000,
    })
    expect(result.escalate).toBe(false)
    if (!result.escalate) expect(result.reason).toBe("paid_more_expensive")
  })
})
