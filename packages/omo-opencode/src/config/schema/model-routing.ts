import { z } from "zod"

/**
 * Capability tiers double as ECONOMIC BANDS over the enabled model pool:
 *
 *   fast      -> free       ($0 models)
 *   balanced  -> cheap_paid (paid, materially cheaper than MAIN)
 *   strong    -> strong_paid (stronger paid, below/equal MAIN)
 *   master    -> main_equiv (same concrete model as MAIN)
 *
 * A tier is a POLICY/BAND, not one fixed model: the runtime resolver selects a
 * concrete model dynamically from the enabled catalog, using live pricing and
 * capability metadata. The `model` field below is an explicit OVERRIDE (pin),
 * honored only when set; it is NOT the default routing mechanism.
 */
export const MODEL_TIERS = ["fast", "balanced", "strong", "master"] as const
export const ModelTierSchema = z.enum(MODEL_TIERS)

export const ModelTierEntryConfigSchema = z.object({
  /** Explicit model-id pin override in "provider/model" form. When set it wins for this tier; when absent the tier resolves dynamically via its economic band. */
  model: z.string().optional(),
  /** For "master": when false, an explicit `model` pin wins over the parent/main model. Default (omitted/true) is main_equiv -> MAIN's concrete model. */
  inherit_parent: z.boolean().optional(),
})

export const PAID_WORKER_POLICIES = ["master_with_operator_consent", "disabled"] as const
export const PaidWorkerPolicySchema = z.enum(PAID_WORKER_POLICIES)

export const PaidWorkersConfigSchema = z.object({
  /** Policy governing paid child launches. Default requires master authority + fresh operator consent per launch. */
  policy: PaidWorkerPolicySchema.optional().default("master_with_operator_consent"),
  /** Maximum concurrent paid children (default 1). One approval never authorizes a second concurrent child. */
  max_concurrent: z.number().int().min(1).optional().default(1),
})

export const ModelRoutingConfigSchema = z.object({
  /** Enable per-delegation model tier (band) selection (default: enabled when the section is present). */
  enabled: z.boolean().optional(),
  /**
   * COST-SAFETY: may automatically spawned children (explore, librarian,
   * general, background workers, delegated workers) select PAID models?
   * Default false. A paid child requires explicit opt-in; capability tier
   * alone (fast/balanced/strong/master) never implies paid permission.
   */
  allow_paid_workers: z.boolean().optional().default(false),
  /** Maximum concurrent paid child requests when allow_paid_workers is true. Default 1. */
  max_concurrent_paid_workers: z.number().int().min(1).optional().default(1),
  /**
   * NEW POLICY: paid children require true MASTER/ROOT authority plus fresh operator
   * consent for each exact launch (single-use approval). The deprecated allow_paid_workers
   * boolean cannot bypass this gate.
   */
  paid_workers: PaidWorkersConfigSchema.optional(),
  tiers: z
    .object({
      fast: ModelTierEntryConfigSchema.optional(),
      balanced: ModelTierEntryConfigSchema.optional(),
      strong: ModelTierEntryConfigSchema.optional(),
      master: ModelTierEntryConfigSchema.optional(),
    })
    .optional(),
})

export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>
