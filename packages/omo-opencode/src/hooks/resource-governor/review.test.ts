import { describe, expect, test } from "bun:test"

import { decideReview } from "./review"

describe("review", () => {
  // #18 spec: review is risk-based, not mandatory
  test("low-risk change gets self-review", () => {
    // given a small, non-security, low-risk diff
    // when
    const decision = decideReview({
      risk: "low",
      has_failing_tests: false,
      security_sensitive: false,
      diff_size: 50,
      architectural_impact: false,
      available_budget_usd: 5.0,
    })
    // then no independent reviewer
    expect(decision).toEqual({ kind: "self_review" })
  })

  test("high-risk change gets independent review", () => {
    const decision = decideReview({
      risk: "high",
      has_failing_tests: false,
      security_sensitive: false,
      diff_size: 100,
      architectural_impact: false,
      available_budget_usd: 5.0,
    })
    expect(decision.kind).toBe("independent_review")
  })

  test("security-sensitive change triggers independent review even at low risk", () => {
    const decision = decideReview({
      risk: "low",
      has_failing_tests: false,
      security_sensitive: true,
      diff_size: 10,
      architectural_impact: false,
      available_budget_usd: 5.0,
    })
    expect(decision.kind).toBe("independent_review")
  })

  test("large diff triggers review", () => {
    const decision = decideReview({
      risk: "medium",
      has_failing_tests: false,
      security_sensitive: false,
      diff_size: 5000,
      architectural_impact: false,
      available_budget_usd: 5.0,
    })
    expect(decision.kind).toBe("independent_review")
  })

  test("constrained budget prefers a free reviewer", () => {
    const decision = decideReview({
      risk: "high",
      has_failing_tests: false,
      security_sensitive: false,
      diff_size: 100,
      architectural_impact: false,
      available_budget_usd: 0.2,
    })
    expect(decision).toEqual({ kind: "independent_review", prefer_free: true })
  })
})
