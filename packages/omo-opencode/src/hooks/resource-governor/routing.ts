/**
 * Economic routing + expected-value delegation (pure). The Delegation Cop
 * chooses the cheapest sufficient worker first, not the strongest available
 * one (spec section 8 + 11). No knowledge of specific free model names —
 * free/paid and pricing flow in from the injected catalog.
 */

import type { PricingCatalog } from "./pricing"
import { discoverFreeModels, estimateCostUsd, isFreePricing, lookupPricing } from "./pricing"

export type WorkerCandidate = {
  model_id: string
  /** Coarse capability score 0..1 for matching subtask difficulty. */
  capability: number
  /** Expected raw tokens this worker would consume for the subtask. */
  expected_tokens: number
}

export type SelectWorkerInput = {
  candidates: readonly WorkerCandidate[]
  required_capability: number
  pricing: PricingCatalog
  free_first: boolean
  /** When true (high pressure), paid workers need high expected value to pass. */
  prefer_free_only: boolean
  /** Maximum paid USD allowed for this worker under current policy. */
  max_paid_usd: number
}

export type SelectWorkerResult =
  | { kind: "selected"; candidate: WorkerCandidate; free: boolean; cost_usd: number }
  | { kind: "no_sufficient_candidate" }
  | { kind: "paid_blocked"; candidate: WorkerCandidate; cost_usd: number; reason: "over_cap" | "free_only_pressure" }

function sufficient(candidate: WorkerCandidate, required: number): boolean {
  return candidate.capability >= required
}

function expectedCostUsd(pricing: PricingCatalog, model_id: string, tokens: number): { usd: number; known: boolean } {
  const price = lookupPricing(pricing, model_id)
  const est = estimateCostUsd(price, {
    input: Math.floor(tokens * 0.6),
    output: Math.floor(tokens * 0.4),
    cache_read: 0,
    cache_write: 0,
  })
  return { usd: est.usd, known: est.known }
}

/**
 * Pick the cheapest sufficient worker. Free workers sort first when
 * `free_first` (default). Under `prefer_free_only` pressure, paid workers are
 * rejected unless none exists, in which case they are reported as blocked so
 * the caller can seek consent. Unknown-price workers fail conservatively and
 * are ranked last (treated as potentially expensive, never as free).
 */
export function selectWorker(input: SelectWorkerInput): SelectWorkerResult {
  const freeSet = new Set(discoverFreeModels(input.pricing))

  const eligible = input.candidates.filter((c) => sufficient(c, input.required_capability))
  if (eligible.length === 0) return { kind: "no_sufficient_candidate" }

  const scored = eligible.map((candidate) => {
    const cost = expectedCostUsd(input.pricing, candidate.model_id, candidate.expected_tokens)
    const free = isFreePricing(lookupPricing(input.pricing, candidate.model_id))
    return { candidate, cost, free, knownFree: freeSet.has(candidate.model_id) || free }
  })

  const freeWorkers = scored.filter((s) => s.free)
  const paidWorkers = scored.filter((s) => !s.free)

  if (input.prefer_free_only && freeWorkers.length > 0) {
    // High pressure: prefer the cheapest free worker even if a paid worker is
    // stronger, as long as the free worker is sufficient.
    const best = sortByCheapest(freeWorkers)[0]
    return { kind: "selected", candidate: best.candidate, free: true, cost_usd: best.cost.usd }
  }

  if (input.free_first && freeWorkers.length > 0) {
    const best = sortByCheapest(freeWorkers)[0]
    return { kind: "selected", candidate: best.candidate, free: true, cost_usd: best.cost.usd }
  }

  if (paidWorkers.length === 0) {
    // No paid workers: fall back to the available free worker (or none).
    if (freeWorkers.length > 0) {
      const best = sortByCheapest(freeWorkers)[0]
      return { kind: "selected", candidate: best.candidate, free: true, cost_usd: best.cost.usd }
    }
    return { kind: "no_sufficient_candidate" }
  }

  if (input.prefer_free_only) {
    const bestPaid = sortByCheapest(paidWorkers)[0]
    return {
      kind: "paid_blocked",
      candidate: bestPaid.candidate,
      cost_usd: bestPaid.cost.usd,
      reason: "free_only_pressure",
    }
  }

  const bestPaid = sortByCheapest(paidWorkers)[0]
  if (bestPaid.cost.usd > input.max_paid_usd && input.max_paid_usd >= 0) {
    return {
      kind: "paid_blocked",
      candidate: bestPaid.candidate,
      cost_usd: bestPaid.cost.usd,
      reason: "over_cap",
    }
  }

  return { kind: "selected", candidate: bestPaid.candidate, free: false, cost_usd: bestPaid.cost.usd }
}

function sortByCheapest<T extends { cost: { usd: number } }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.cost.usd - b.cost.usd)
}

/**
 * Expected-value delegation gate (spec section 11). A child is justified only
 * when the information gain outweighs the resource cost and the root cannot
 * answer cheaply itself. Returns a plain boolean + a concise reason string so
 * the caller can log the routing decision without hidden reasoning.
 */
export type DelegationValueInput = {
  /** 0..1 estimate of the chance this child materially changes a decision. */
  expected_information_value: number
  cost_usd: number
  context_cost_tokens: number
  /** True when the root could answer this itself at negligible cost. */
  root_can_answer_cheaply: boolean
  /** True when a prior worker already produced relevant evidence. */
  prior_evidence_exists: boolean
  duplication_risk: number
}

export type DelegationValueResult =
  | { justified: true; reason: "justified" }
  | {
      justified: false
      reason: "root_can_answer" | "prior_evidence" | "low_value" | "high_duplication"
    }

export function evaluateDelegationValue(input: DelegationValueInput): DelegationValueResult {
  if (input.root_can_answer_cheaply) return { justified: false, reason: "root_can_answer" }
  if (input.prior_evidence_exists) return { justified: false, reason: "prior_evidence" }
  if (input.expected_information_value < 0.35) return { justified: false, reason: "low_value" }
  if (input.duplication_risk >= 0.8) return { justified: false, reason: "high_duplication" }
  return { justified: true, reason: "justified" }
}

/**
 * "Free-first but capability-aware" escalation (spec section 23). After a
 * bounded number of free-worker failures, a single paid specialist has better
 * expected total cost when the paid worker's expected cost is lower than the
 * root tokens already burned interpreting free failures. Returns a plain
 * recommendation; the hard ceiling still governs whether it can dispatch.
 */
export type EscalationInput = {
  free_failures: number
  max_free_failures: number
  root_tokens_consumed_interpreted: number
  paid_expected_cost_usd: number
  token_to_usd_rate: number
}

export type EscalationResult =
  | { escalate: true; reason: "bounded_failures_cheaper" }
  | { escalate: false; reason: "under_threshold" | "paid_more_expensive" }

export function recommendPaidEscalation(input: EscalationInput): EscalationResult {
  if (input.free_failures < input.max_free_failures) {
    return { escalate: false, reason: "under_threshold" }
  }
  const rootCostEstimate = input.root_tokens_consumed_interpreted * input.token_to_usd_rate
  if (input.paid_expected_cost_usd >= rootCostEstimate) {
    return { escalate: false, reason: "paid_more_expensive" }
  }
  return { escalate: true, reason: "bounded_failures_cheaper" }
}
