export const MODEL_TIERS = ["fast", "balanced", "strong", "master"] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export type ModelTierEntryConfig = {
  /** Exact registered model id in "provider/model" form. Source of truth is the model registry, never a guessed id. */
  readonly model?: string
  /** For "master": resolve to the parent/main session's current model instead of any configured id. */
  readonly inherit_parent?: boolean
}

export type ModelTierRoutingConfig = {
  readonly enabled?: boolean
  readonly tiers?: {
    readonly fast?: ModelTierEntryConfig
    readonly balanced?: ModelTierEntryConfig
    readonly strong?: ModelTierEntryConfig
    readonly master?: ModelTierEntryConfig
  }
}

export type ModelTierResolutionInput = {
  readonly tier: ModelTier
  readonly config: ModelTierRoutingConfig
  /** The live model registry as a set of "provider/model" ids. Empty means cold cache (cannot validate). */
  readonly availableModels: ReadonlySet<string>
  /** The parent/main session's current model in "provider/model" form (used by master.inherit_parent). */
  readonly parentModel?: string
}

export type ModelTierResolutionResult = {
  readonly model: string
  /** The tier that actually produced the model (may differ from requested after escalation). */
  readonly tier: ModelTier
  readonly requestedTier: ModelTier
  readonly escalated: boolean
  readonly usedParentModel: boolean
}

const ESCALATION: Record<ModelTier, readonly ModelTier[]> = {
  fast: ["fast", "balanced", "strong", "master"],
  balanced: ["balanced", "strong", "master"],
  strong: ["strong", "master"],
  master: ["master"],
}

function isAvailable(model: string, availableModels: ReadonlySet<string>): boolean {
  // Cold cache: we cannot prove the id is missing, so we trust the exact configured id.
  // We never fabricate or prefix an id — the config value is returned verbatim.
  if (availableModels.size === 0) return true
  return availableModels.has(model)
}

/**
 * Resolve the model for a requested capability tier, escalating upward
 * (fast -> balanced -> strong -> master) when a configured model is missing or
 * unconfigured. Returns undefined when routing is disabled/unconfigured so the
 * caller falls through to its existing model resolution.
 *
 * "master" resolves to the parent session model when inherit_parent is set (the
 * default); it never fabricates a provider-prefixed id.
 */
export function resolveModelTier(
  input: ModelTierResolutionInput,
): ModelTierResolutionResult | undefined {
  const { tier, config, availableModels, parentModel } = input

  if (config?.enabled === false) return undefined
  const tiers = config?.tiers
  if (!tiers) return undefined

  for (const candidate of ESCALATION[tier]) {
    if (candidate === "master") {
      const master = tiers.master
      const inherit = master?.inherit_parent ?? true
      if (inherit && parentModel) {
        return {
          model: parentModel,
          tier: "master",
          requestedTier: tier,
          escalated: candidate !== tier,
          usedParentModel: true,
        }
      }
      if (master?.model && isAvailable(master.model, availableModels)) {
        return {
          model: master.model,
          tier: "master",
          requestedTier: tier,
          escalated: candidate !== tier,
          usedParentModel: false,
        }
      }
      continue
    }

    const entry = tiers[candidate]
    if (!entry || !entry.model) continue
    if (isAvailable(entry.model, availableModels)) {
      return {
        model: entry.model,
        tier: candidate,
        requestedTier: tier,
        escalated: candidate !== tier,
        usedParentModel: false,
      }
    }
  }

  return undefined
}
