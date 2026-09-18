/**
 * Role requirements for named agents and delegation categories.
 *
 * A role declares WHAT it needs (preferred economic band, capability/modality
 * requirements, minimum strength) — never a concrete provider/model chain.
 * The canonical runtime resolver maps those requirements onto the live enabled
 * model pool and picks a concrete model. This replaces the legacy
 * `AGENT_MODEL_REQUIREMENTS` / `CATEGORY_MODEL_REQUIREMENTS` hardcoded
 * provider/model fallback chains, which selected concrete models (e.g.
 * `openai/gpt-5.6-luna-fast`) regardless of provider enable state.
 *
 * Pure metadata: no provider/model ids, no pricing, no state. Consumers inject
 * the live pool and resolve via the economic-band resolver.
 */

/**
 * Economic/strength tier for a role. Mirrors the delegate-core `ModelTier`
 * union without importing it (model-core must not depend on delegate-core).
 *
 *   fast     -> free      ($0 models)
 *   balanced -> free      (free-first; escalates to paid bands only after
 *                          the free pool is exhausted)
 *   strong   -> strong_paid (stronger paid, below/equal MAIN)
 *   master   -> main_equiv (same concrete model as MAIN)
 */
export type RoleTier = "fast" | "balanced" | "strong" | "master"

/** Capability/modality requirements a role imposes on a candidate model. */
export type RoleCapabilityRequirement = {
  /** Candidate must support image input. */
  vision?: boolean
  /** Candidate must support tool calls. */
  tool_call?: boolean
  /** Candidate must be a reasoning model. */
  reasoning?: boolean
  /** Minimum context window (tokens). */
  min_context?: number
  /** Minimum capability score (0..1). Unknown scores are treated as 1.0 (kept). */
  min_capability?: number
}

export type RoleRequirement = {
  /** Preferred economic band / strength tier for this role. */
  defaultTier: RoleTier
  /** Capability/modality requirements applied before banding. */
  required?: RoleCapabilityRequirement
}

/**
 * Named-agent role requirements. Keys are the agent config keys used by the
 * delegate-task `subagent_type` resolution.
 */
export const AGENT_ROLE_REQUIREMENTS: Record<string, RoleRequirement> = {
  sisyphus: { defaultTier: "strong" },
  hephaestus: { defaultTier: "strong" },
  oracle: { defaultTier: "strong" },
  librarian: { defaultTier: "fast" },
  explore: { defaultTier: "fast" },
  "multimodal-looker": { defaultTier: "balanced" },
  prometheus: { defaultTier: "strong" },
  metis: { defaultTier: "strong" },
  momus: { defaultTier: "strong" },
  atlas: { defaultTier: "balanced" },
  "sisyphus-junior": { defaultTier: "balanced" },
  general: { defaultTier: "balanced" },
}

/**
 * Delegation-category role requirements. Keys are category names.
 */
export const CATEGORY_ROLE_REQUIREMENTS: Record<string, RoleRequirement> = {
  "visual-engineering": { defaultTier: "strong" },
  ultrabrain: { defaultTier: "strong" },
  deep: { defaultTier: "strong" },
  artistry: { defaultTier: "strong" },
  quick: { defaultTier: "fast" },
  "unspecified-low": { defaultTier: "balanced" },
  "unspecified-high": { defaultTier: "strong" },
  writing: { defaultTier: "balanced" },
}

export function getAgentRoleRequirement(agentConfigKey: string): RoleRequirement | undefined {
  return AGENT_ROLE_REQUIREMENTS[agentConfigKey]
}

export function getCategoryRoleRequirement(categoryName: string): RoleRequirement | undefined {
  return CATEGORY_ROLE_REQUIREMENTS[categoryName]
}
