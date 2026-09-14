/**
 * Task-start resource plan, forecast-vs-actual, and bounded historical
 * correction (pure). The plan is explicit, adjustable, measurable, and fed
 * into routing (spec section 4 + 18).
 */

export type TaskDifficulty = "low" | "medium" | "high"

export type TaskResourcePlan = {
  difficulty: TaskDifficulty
  root_tokens: number
  free_exploration_tokens: number
  implementation_tokens: number
  verification_tokens: number
  reserve_tokens: number
  expected_paid_spend_usd: number
  hard_paid_ceiling_usd: number
  expected_worker_count: number
  expected_context_growth_tokens: number
}

export type BuildPlanInput = {
  difficulty: TaskDifficulty
  /** Optional explicit overrides win over difficulty heuristics. */
  root_tokens?: number
  implementation_tokens?: number
  verification_tokens?: number
  reserve_tokens?: number
  hard_paid_ceiling_usd: number
}

const DIFFICULTY_SEED: Record<TaskDifficulty, Omit<TaskResourcePlan, "hard_paid_ceiling_usd">> = {
  low: {
    difficulty: "low",
    root_tokens: 250_000,
    free_exploration_tokens: 120_000,
    implementation_tokens: 250_000,
    verification_tokens: 120_000,
    reserve_tokens: 100_000,
    expected_paid_spend_usd: 0.2,
    expected_worker_count: 1,
    expected_context_growth_tokens: 20_000,
  },
  medium: {
    difficulty: "medium",
    root_tokens: 2_000_000,
    free_exploration_tokens: 1_500_000,
    implementation_tokens: 2_000_000,
    verification_tokens: 800_000,
    reserve_tokens: 700_000,
    expected_paid_spend_usd: 1.4,
    expected_worker_count: 3,
    expected_context_growth_tokens: 120_000,
  },
  high: {
    difficulty: "high",
    root_tokens: 4_000_000,
    free_exploration_tokens: 3_000_000,
    implementation_tokens: 4_000_000,
    verification_tokens: 1_500_000,
    reserve_tokens: 1_500_000,
    expected_paid_spend_usd: 4.0,
    expected_worker_count: 6,
    expected_context_growth_tokens: 260_000,
  },
}

export function buildTaskResourcePlan(input: BuildPlanInput): TaskResourcePlan {
  const seed = DIFFICULTY_SEED[input.difficulty]
  return {
    difficulty: input.difficulty,
    root_tokens: input.root_tokens ?? seed.root_tokens,
    free_exploration_tokens: seed.free_exploration_tokens,
    implementation_tokens: input.implementation_tokens ?? seed.implementation_tokens,
    verification_tokens: input.verification_tokens ?? seed.verification_tokens,
    reserve_tokens: input.reserve_tokens ?? seed.reserve_tokens,
    expected_paid_spend_usd: seed.expected_paid_spend_usd,
    hard_paid_ceiling_usd: input.hard_paid_ceiling_usd,
    expected_worker_count: seed.expected_worker_count,
    expected_context_growth_tokens: seed.expected_context_growth_tokens,
  }
}

// Forecast-only heuristic: the first delegation's budget proxies task scope
// (no root "difficulty" hook exists). The plan does NOT override enforcement.
export function difficultyFromExpectedTokens(expectedTokens: number): TaskDifficulty {
  if (expectedTokens <= 500_000) return "low"
  if (expectedTokens <= 2_000_000) return "medium"
  return "high"
}

export function planExpectedTokens(plan: TaskResourcePlan): number {
  return (
    plan.root_tokens +
    plan.free_exploration_tokens +
    plan.implementation_tokens +
    plan.verification_tokens +
    plan.reserve_tokens
  )
}

export type ForecastVariance = {
  expected_tokens: number
  actual_tokens: number
  expected_paid_usd: number
  actual_paid_usd: number
  expected_workers: number
  actual_workers: number
  token_error: number
  paid_error: number
  worker_error: number
}

export function computeForecastVariance(input: {
  plan: TaskResourcePlan
  actual_tokens: number
  actual_paid_usd: number
  actual_workers: number
}): ForecastVariance {
  const expected_tokens = planExpectedTokens(input.plan)
  const token_error = expected_tokens <= 0 ? 0 : input.actual_tokens / expected_tokens - 1
  const paid_error =
    input.plan.expected_paid_spend_usd <= 0
      ? 0
      : input.actual_paid_usd / input.plan.expected_paid_spend_usd - 1
  const worker_error =
    input.plan.expected_worker_count <= 0
      ? 0
      : input.actual_workers / input.plan.expected_worker_count - 1

  return {
    expected_tokens,
    actual_tokens: input.actual_tokens,
    expected_paid_usd: input.plan.expected_paid_spend_usd,
    actual_paid_usd: input.actual_paid_usd,
    expected_workers: input.plan.expected_worker_count,
    actual_workers: input.actual_workers,
    token_error,
    paid_error,
    worker_error,
  }
}

/**
 * Bounded moving-average correction multiplier (spec section 18). Clamps to
 * [0.1, 5.0] so one anomalous run cannot wildly distort future forecasts.
 * `samples` is the prior observation count INCLUDING the new sample.
 */
export function updateHistoricalMultiplier(prev: {
  multiplier: number
  samples: number
}, observed: number): { multiplier: number; samples: number } {
  const clamped = Math.min(5.0, Math.max(0.1, observed))
  const samples = prev.samples + 1
  // Exponential blend biased toward history; a single sample keeps its signal
  // but never exceeds the clamp.
  const alpha = 1 / samples
  const multiplier = prev.multiplier * (1 - alpha) + clamped * alpha
  return { multiplier, samples }
}

export const HISTORICAL_MULTIPLIER_MIN = 0.1
export const HISTORICAL_MULTIPLIER_MAX = 5.0
