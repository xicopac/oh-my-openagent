import { z } from "zod"

export const MODEL_TIERS = ["fast", "balanced", "strong", "master"] as const
export const ModelTierSchema = z.enum(MODEL_TIERS)

export const ModelTierEntryConfigSchema = z.object({
  /** Exact registered model id in "provider/model" form. The model registry is the source of truth; never a guessed id. */
  model: z.string().optional(),
  /** For "master": true resolves to the parent/main session's current model. */
  inherit_parent: z.boolean().optional(),
})

export const ModelRoutingConfigSchema = z.object({
  /** Enable per-delegation model tier selection (default: enabled when the section is present). */
  enabled: z.boolean().optional(),
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
