/**
 * Budget modes, soft/hard ceilings, and progressive pressure (pure).
 *
 * Modes seed defaults only; explicit numeric config always wins. This keeps
 * the mode name out of the decision core (spec section 5). Pressure is derived
 * from the higher of token-budget and paid-budget utilization so a cheap but
 * huge run and an expensive but small run both exert pressure.
 */

export type BudgetMode = "economy" | "normal" | "generous"

export type BudgetLevels = {
  soft_usd: number
  hard_usd: number
  soft_tokens: number
  hard_tokens: number
  max_concurrent_children: number
  default_child_tokens: number
}

const MODE_DEFAULTS: Record<BudgetMode, BudgetLevels> = {
  economy: {
    soft_usd: 0.75,
    hard_usd: 1.5,
    soft_tokens: 3_000_000,
    hard_tokens: 5_000_000,
    max_concurrent_children: 2,
    default_child_tokens: 400_000,
  },
  normal: {
    soft_usd: 1.5,
    hard_usd: 3.0,
    soft_tokens: 7_000_000,
    hard_tokens: 12_000_000,
    max_concurrent_children: 4,
    default_child_tokens: 600_000,
  },
  generous: {
    soft_usd: 5.0,
    hard_usd: 15.0,
    soft_tokens: 20_000_000,
    hard_tokens: 40_000_000,
    max_concurrent_children: 8,
    default_child_tokens: 1_500_000,
  },
}

export type ResolveBudgetLevelsInput = {
  mode: BudgetMode
  hard_usd?: number
  soft_usd?: number
  hard_tokens?: number
  soft_tokens?: number
  max_concurrent_children?: number
  default_child_tokens?: number
}

export function resolveBudgetLevels(input: ResolveBudgetLevelsInput): BudgetLevels {
  const base = MODE_DEFAULTS[input.mode]
  return {
    soft_usd: input.soft_usd ?? base.soft_usd,
    hard_usd: Math.max(input.soft_usd ?? base.soft_usd, input.hard_usd ?? base.hard_usd),
    soft_tokens: input.soft_tokens ?? base.soft_tokens,
    hard_tokens: Math.max(input.soft_tokens ?? base.soft_tokens, input.hard_tokens ?? base.hard_tokens),
    max_concurrent_children: input.max_concurrent_children ?? base.max_concurrent_children,
    default_child_tokens: input.default_child_tokens ?? base.default_child_tokens,
  }
}

/** Pressure tier, coarse on purpose so routing reads it without thresholds leaking in. */
export type Pressure = "normal" | "elevated" | "high" | "critical" | "exhausted"

export type PressureInput = {
  spent_usd: number
  spent_tokens: number
  levels: BudgetLevels
}

/**
 * Progressive pressure (spec section 7). Utilization is the max of paid and
 * token utilization. Returned tier maps to routing policy tightening; the
 * `paid_reached_hard` / `token_reached_hard` flags are the only hard stops.
 */
export function computePressure(input: PressureInput): {
  pressure: Pressure
  paid_utilization: number
  token_utilization: number
  paid_reached_hard: boolean
  token_reached_hard: boolean
} {
  const paid_utilization = input.levels.hard_usd <= 0 ? 0 : input.spent_usd / input.levels.hard_usd
  const token_utilization =
    input.levels.hard_tokens <= 0 ? 0 : input.spent_tokens / input.levels.hard_tokens

  const paid_reached_hard = input.spent_usd >= input.levels.hard_usd && input.levels.hard_usd > 0
  const token_reached_hard =
    input.spent_tokens >= input.levels.hard_tokens && input.levels.hard_tokens > 0

  const utilization = Math.max(paid_utilization, token_utilization)

  let pressure: Pressure = "normal"
  if (paid_reached_hard || token_reached_hard) {
    pressure = "exhausted"
  } else if (utilization >= 0.9) {
    pressure = "critical"
  } else if (utilization >= 0.75) {
    pressure = "high"
  } else if (utilization >= 0.5) {
    pressure = "elevated"
  }

  return { pressure, paid_utilization, token_utilization, paid_reached_hard, token_reached_hard }
}

/** Fraction of the soft budget consumed (for the "on budget" forecast check). */
export function softBudgetConsumed(input: {
  spent_usd: number
  levels: BudgetLevels
}): number {
  if (input.levels.soft_usd <= 0) return 0
  return input.spent_usd / input.levels.soft_usd
}
