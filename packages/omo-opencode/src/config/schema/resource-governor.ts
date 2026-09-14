import { z } from "zod"

/**
 * Resource Governor config. The governor treats token usage, paid spend,
 * context growth, and delegation fan-out as scarce resources from the start
 * of a task. It is the sibling of the context-governor (Context Cop) and owns
 * the Token/Cost Cop and Delegation Cop concerns on one shared ledger.
 *
 * Budget modes only seed defaults; explicit numeric fields always win, so the
 * mode name is never core logic (spec section 5).
 */

const BUDGET_MODES = ["economy", "normal", "generous"] as const
export const BudgetModeSchema = z.enum(BUDGET_MODES)

export const ResourceGovernorPaidConfigSchema = z
  .object({
    /** Soft paid-spend ceiling in USD (progressive pressure begins here). */
    soft_usd: z.number().min(0).default(1.5),
    /** Hard paid-spend ceiling in USD (new paid consumption is blocked here). */
    hard_usd: z.number().min(0).default(3.0),
  })
  .strict()

export const ResourceGovernorTokensConfigSchema = z
  .object({
    /** Soft raw-token budget (progressive pressure begins here). */
    soft_total: z.number().int().min(0).default(7_000_000),
    /** Hard raw-token budget (additional expensive work is blocked here). */
    hard_total: z.number().int().min(0).default(12_000_000),
  })
  .strict()

export const ResourceGovernorDelegationConfigSchema = z
  .object({
    /** Max concurrently active children. */
    max_concurrent_children: z.number().int().min(1).max(32).default(4),
    /** Default raw-token budget granted to each child. */
    default_child_tokens: z.number().int().min(1).default(600_000),
    /** Whether duplicate-work detection is enabled. */
    duplicate_detection: z.boolean().default(true),
    /** Prefer a $0 worker when one is plausibly sufficient. */
    free_first: z.boolean().default(true),
  })
  .strict()

export const ResourceGovernorContextConfigSchema = z
  .object({
    /** Preferred steady-state context in tokens (NOT a hard ceiling). */
    preferred_tokens: z.number().int().min(1).default(150_000),
    preferred_post_compaction_tokens: z.number().int().min(1).default(60_000),
    expansion_enabled: z.boolean().default(true),
    max_compaction_passes: z.number().int().min(1).max(8).default(3),
  })
  .strict()

export const ResourceGovernorForecastingConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Persist bounded historical correction multipliers. */
    persist_history: z.boolean().default(true),
  })
  .strict()

export const ResourceGovernorConsentConfigSchema = z
  .object({
    /** Require explicit human consent before exceeding an escalation boundary. */
    require_paid_escalation: z.boolean().default(true),
    /** Require explicit human consent before moving past the hard ceiling. */
    require_hard_budget_increase: z.boolean().default(true),
  })
  .strict()

export const ResourceGovernorConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    budget_mode: BudgetModeSchema.default("normal"),

    paid: ResourceGovernorPaidConfigSchema.default(() =>
      ResourceGovernorPaidConfigSchema.parse({}),
    ),
    tokens: ResourceGovernorTokensConfigSchema.default(() =>
      ResourceGovernorTokensConfigSchema.parse({}),
    ),
    delegation: ResourceGovernorDelegationConfigSchema.default(() =>
      ResourceGovernorDelegationConfigSchema.parse({}),
    ),
    context: ResourceGovernorContextConfigSchema.default(() =>
      ResourceGovernorContextConfigSchema.parse({}),
    ),
    forecasting: ResourceGovernorForecastingConfigSchema.default(() =>
      ResourceGovernorForecastingConfigSchema.parse({}),
    ),
    consent: ResourceGovernorConsentConfigSchema.default(() =>
      ResourceGovernorConsentConfigSchema.parse({}),
    ),
  })
  .strict()
  .refine((cfg) => cfg.paid.soft_usd <= cfg.paid.hard_usd, {
    message: "paid.soft_usd must be <= paid.hard_usd",
    path: ["paid", "soft_usd"],
  })
  .refine((cfg) => cfg.tokens.soft_total <= cfg.tokens.hard_total, {
    message: "tokens.soft_total must be <= tokens.hard_total",
    path: ["tokens", "soft_total"],
  })

export type ResourceGovernorPaidConfig = z.infer<typeof ResourceGovernorPaidConfigSchema>
export type ResourceGovernorTokensConfig = z.infer<typeof ResourceGovernorTokensConfigSchema>
export type ResourceGovernorDelegationConfig = z.infer<typeof ResourceGovernorDelegationConfigSchema>
export type ResourceGovernorContextConfig = z.infer<typeof ResourceGovernorContextConfigSchema>
export type ResourceGovernorForecastingConfig = z.infer<typeof ResourceGovernorForecastingConfigSchema>
export type ResourceGovernorConsentConfig = z.infer<typeof ResourceGovernorConsentConfigSchema>
export type ResourceGovernorConfig = z.infer<typeof ResourceGovernorConfigSchema>
