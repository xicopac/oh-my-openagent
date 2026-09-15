/**
 * Delegation-first free-worker candidate derivation. Maps the live pricing
 * catalog plus the set of currently-available models onto an ordered
 * escalation ladder of `WorkerCandidate`s: cheapest sufficient free workers
 * first, then cheap paid, then stronger paid. Unknown-price models are never
 * classified free; unavailable models are excluded. Pure and deterministic —
 * pricing and availability are injected, never imported.
 *
 * This is the concrete "free-first re-selection at dispatch" layer: it turns
 * the catalog's $0 models into real dispatchable candidates rather than
 * relying on the single already-resolved model.
 */

import {
  estimateCostUsd,
  isFreePricing,
  lookupPricing,
  type PricingCatalog,
} from "../../hooks/resource-governor/pricing"
import type { EscalationTier, WorkerCandidate } from "../delegation-ladder"

/** Per-model capability + context metadata used to filter and annotate candidates. */
export type ModelCapabilityInfo = {
  context_limit?: number
  vision?: boolean
  tool_call?: boolean
  reasoning?: boolean
}

/** Capability requirements a task may impose on a candidate. */
export type WorkerCapabilityRequirement = {
  vision?: boolean
  tool_call?: boolean
  reasoning?: boolean
  min_context?: number
}

export type BuildWorkerCandidatesInput = {
  pricing: PricingCatalog
  /** Available model ids (provider/model form), e.g. "opengateway/gpt-5". */
  available: ReadonlySet<string>
  /** The already-resolved model (kept unless it is marked unavailable). */
  resolvedModelID: string | null
  /** Models known to be unavailable (e.g. disabled); these are never dispatched. */
  unavailable?: ReadonlySet<string>
  /** MAIN's own model, appended as the terminal escalation rung. */
  mainModel?: string
  /** Minimum required capability; candidates with a known lower score are dropped. */
  minCapability?: number
  /** Injected capability score per model id (0..1). Unknown ids are treated as 1.0. */
  capabilities?: ReadonlyMap<string, number>
  /** Per-model capability/context/price metadata, merged onto each candidate. */
  modelInfo?: ReadonlyMap<string, ModelCapabilityInfo>
  /** Required modalities/context; candidates lacking a known capability are dropped. */
  required?: WorkerCapabilityRequirement
}

/**
 * Assign an escalation tier from pricing. Free ($0 across every bucket) sort
 * first; everything else is tiered by how cheap its input price is, so the
 * ladder escalates from cheapest to strongest paid.
 */
export function tierForPricing(
  modelID: string,
  pricing: PricingCatalog,
): { tier: EscalationTier; free: boolean; cost_usd_per_1m_input?: number } {
  const price = lookupPricing(pricing, modelID)
  if (isFreePricing(price)) {
    return { tier: "free", free: true, cost_usd_per_1m_input: 0 }
  }
  const input = price?.input
  const cost = typeof input === "number" ? input : undefined
  if (cost === undefined) {
    // Unknown price is conservative: potentially expensive, never free.
    return { tier: "strong_paid", free: false }
  }
  if (cost <= 1) return { tier: "cheap_paid", free: false, cost_usd_per_1m_input: cost }
  return { tier: "strong_paid", free: false, cost_usd_per_1m_input: cost }
}

const TIER_ORDER: EscalationTier[] = ["free", "free_alt", "cheap_paid", "strong_paid", "expert"]

/**
 * Build an ordered ladder of dispatchable worker candidates. Free models that
 * are available (or already the resolved model) come first, then the resolved
 * model (if paid), then any remaining paid models, cheapest first. The
 * resolved model is always included even if it is not currently marked
 * available, so the single already-resolved dispatch target is never dropped.
 */
function meetsRequirement(
  info: ModelCapabilityInfo | undefined,
  required: WorkerCapabilityRequirement | undefined,
): boolean {
  if (!required) return true
  if (required.vision && info?.vision !== true) return false
  if (required.tool_call && info?.tool_call !== true) return false
  if (required.reasoning && info?.reasoning !== true) return false
  if (required.min_context !== undefined && (info?.context_limit ?? 0) < required.min_context) return false
  return true
}

export function buildDelegationWorkerCandidates(input: BuildWorkerCandidatesInput): WorkerCandidate[] {
  const {
    pricing,
    available,
    resolvedModelID,
    unavailable,
    mainModel,
    minCapability,
    capabilities,
    modelInfo,
    required,
  } = input

  const unavailableSet = unavailable ?? new Set<string>()

  const all = new Set<string>()
  if (resolvedModelID && !unavailableSet.has(resolvedModelID)) all.add(resolvedModelID)
  for (const id of available) {
    if (!unavailableSet.has(id)) all.add(id)
  }

  const scored = [...all].map((id) => {
    const { tier, free, cost_usd_per_1m_input } = tierForPricing(id, pricing)
    const capability = capabilities?.get(id) ?? (free ? 0.7 : 1.0)
    const info = modelInfo?.get(id)
    return { id, tier, free, cost_usd_per_1m_input, capability, info }
  }).filter((item) => {
    if (minCapability !== undefined && item.capability < minCapability) return false
    return meetsRequirement(item.info, required)
  })

  scored.sort((a, b) => {
    const ta = TIER_ORDER.indexOf(a.tier)
    const tb = TIER_ORDER.indexOf(b.tier)
    if (ta !== tb) return ta - tb
    if (a.free !== b.free) return a.free ? -1 : 1
    const ca = typeof a.cost_usd_per_1m_input === "number" ? a.cost_usd_per_1m_input : Number.POSITIVE_INFINITY
    const cb = typeof b.cost_usd_per_1m_input === "number" ? b.cost_usd_per_1m_input : Number.POSITIVE_INFINITY
    return ca - cb
  })

  const candidates: WorkerCandidate[] = []
  const seen = new Set<string>()
  for (const item of scored) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const price = lookupPricing(pricing, item.id)
    const info = item.info
    candidates.push({
      model_id: item.id,
      tier: item.tier,
      capability: item.capability,
      free: item.free,
      ...(item.cost_usd_per_1m_input === undefined ? {} : { cost_usd_per_1m_input: item.cost_usd_per_1m_input }),
      ...(price?.output === undefined ? {} : { cost_usd_per_1m_output: price.output }),
      ...(price?.cache_read === undefined ? {} : { cost_usd_per_1m_cache_read: price.cache_read }),
      ...(price?.cache_write === undefined ? {} : { cost_usd_per_1m_cache_write: price.cache_write }),
      ...(info?.context_limit === undefined ? {} : { context_limit: info.context_limit }),
      ...(info?.vision === undefined ? {} : { vision: info.vision }),
      ...(info?.tool_call === undefined ? {} : { tool_call: info.tool_call }),
      ...(info?.reasoning === undefined ? {} : { reasoning: info.reasoning }),
    })
  }

  if (mainModel && !unavailableSet.has(mainModel) && !seen.has(mainModel)) {
    const info = modelInfo?.get(mainModel)
    candidates.push({
      model_id: mainModel,
      tier: "expert",
      capability: capabilities?.get(mainModel) ?? 1.0,
      free: false,
      ...(info?.vision === undefined ? {} : { vision: info.vision }),
      ...(info?.tool_call === undefined ? {} : { tool_call: info.tool_call }),
      ...(info?.reasoning === undefined ? {} : { reasoning: info.reasoning }),
      ...(info?.context_limit === undefined ? {} : { context_limit: info.context_limit }),
    })
  }

  return candidates
}

/**
 * Convenience for callers that only need a free/sufficient boolean per model.
 * Returns the estimated USD cost for a fixed token budget (0 when free/unknown)
 * so callers can rank candidates without re-deriving pricing.
 */
export function estimatedCostUsdFor(
  pricing: PricingCatalog,
  modelID: string,
  tokens: number,
): number {
  const price = lookupPricing(pricing, modelID)
  if (!price) return 0
  return estimateCostUsd(price, {
    input: Math.floor(tokens * 0.6),
    output: Math.floor(tokens * 0.4),
    cache_read: 0,
    cache_write: 0,
  }).usd
}
