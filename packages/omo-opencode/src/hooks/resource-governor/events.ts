/**
 * Observability event catalog for the Resource Governor. Structured event
 * names only — no hidden reasoning, no secrets (spec section 28 + 34). The
 * hook layer emits these; the pure core returns decisions that map onto them.
 */

export const RESOURCE_GOVERNOR_EVENTS = [
  "resource-plan-created",
  "resource-budget-pressure",
  "resource-hard-limit",
  "child-budget-created",
  "child-budget-exhausted",
  "routing-free-preferred",
  "routing-paid-justified",
  "duplicate-work-prevented",
  "context-replication-avoided",
  "forecast-adjusted",
  "cost-gate-blocked",
  "cost-gate-approved",
] as const

export type ResourceGovernorEvent = (typeof RESOURCE_GOVERNOR_EVENTS)[number]

/** Machine-readable condition returned when the hard ceiling blocks a launch. */
export const RESOURCE_BUDGET_EXHAUSTED = "RESOURCE_BUDGET_EXHAUSTED" as const
export type ResourceBudgetExhausted = typeof RESOURCE_BUDGET_EXHAUSTED
