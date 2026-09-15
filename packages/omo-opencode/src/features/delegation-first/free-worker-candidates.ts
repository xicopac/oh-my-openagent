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

export type BuildWorkerCandidatesInput = {
  pricing: PricingCatalog
  /** Available model ids (provider/model form), e.g. "opengateway/gpt-5". */
  available: ReadonlySet<string>
  /** The already-resolved model (must always be present in the output). */
  resolvedModelID: string | null
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
export function buildDelegationWorkerCandidates(input: BuildWorkerCandidatesInput): WorkerCandidate[] {
  const { pricing, available, resolvedModelID } = input

  const all = new Set<string>()
  if (resolvedModelID) all.add(resolvedModelID)
  for (const id of available) all.add(id)

  const scored = [...all].map((id) => {
    const { tier, free, cost_usd_per_1m_input } = tierForPricing(id, pricing)
    return { id, tier, free, cost_usd_per_1m_input }
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
    candidates.push({
      model_id: item.id,
      tier: item.tier,
      capability: item.free ? 0.7 : 1.0,
      free: item.free,
      ...(item.cost_usd_per_1m_input === undefined ? {} : { cost_usd_per_1m_input: item.cost_usd_per_1m_input }),
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
