/**
 * Risk-based review policy (pure). Review is NOT mandatory: low-risk changes
 * may be satisfied by local tests plus root self-review, while high-risk
 * changes justify an independent reviewer (spec section 24). The cheapest
 * sufficient reviewer is always preferred.
 */

export type ReviewRisk = "low" | "medium" | "high"

export type ReviewDecision =
  | { kind: "self_review" }
  | { kind: "independent_review"; prefer_free: boolean }

export type ReviewPolicyInput = {
  risk: ReviewRisk
  has_failing_tests: boolean
  security_sensitive: boolean
  diff_size: number
  architectural_impact: boolean
  available_budget_usd: number
}

export function decideReview(input: ReviewPolicyInput): ReviewDecision {
  const high =
    input.risk === "high" ||
    input.has_failing_tests ||
    input.security_sensitive ||
    input.architectural_impact ||
    input.diff_size >= 2000

  if (!high) return { kind: "self_review" }

  // Independent review is warranted, but prefer the cheapest sufficient
  // reviewer whenever budget is constrained.
  const prefer_free = input.available_budget_usd < 1.0
  return { kind: "independent_review", prefer_free }
}
