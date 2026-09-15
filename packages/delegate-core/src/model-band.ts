/**
 * Dynamic economic/capability band resolution for delegated workers.
 *
 * A requested worker tier is a POLICY/BAND, not one fixed model. Each tier maps
 * to an economic band over the entire enabled model pool:
 *
 *   fast      -> free          : suitable enabled models whose authoritative
 *                                 applicable price is $0 across every bucket
 *   balanced  -> cheap_paid    : suitable paid models materially cheaper than
 *                                 MAIN (lowest expected cost first)
 *   strong    -> strong_paid   : suitable stronger paid models below or equal to
 *                                 MAIN's ceiling (capability/strength first)
 *   master    -> main_equiv    : the same concrete model/tier as MAIN (child)
 *
 * Classification and ranking are relative to MAIN's own price so the ladder never
 * hardcodes a price threshold. Capability requirements (vision / tool_call /
 * reasoning / min_context / min_capability) are applied BEFORE economics so an
 * unsuitable-but-cheap model never wins. Unknown pricing is never treated as
 * free. Explicit per-tier `model` pins are honored only as an override.
 *
 * Pure: the candidate pool, pricing, capability metadata, MAIN model, and the
 * unavailable set are all injected, never imported.
 */

export const MODEL_TIERS = ["fast", "balanced", "strong", "master"] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export const MODEL_BANDS = ["free", "cheap_paid", "strong_paid", "main_equiv"] as const
export type ModelBand = (typeof MODEL_BANDS)[number]

export const TIER_TO_BAND: Record<ModelTier, ModelBand> = {
  fast: "free",
  balanced: "cheap_paid",
  strong: "strong_paid",
  master: "main_equiv",
}

export function tierToBand(tier: ModelTier): ModelBand {
  return TIER_TO_BAND[tier]
}

/** USD per 1,000,000 tokens for each priced bucket. */
export type ModelBandPricing = {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export type ModelBandCandidate = {
  /** Registered model id in "provider/model" form. */
  model: string
  /** Pricing when known; undefined means unknown (treated conservative, never free). */
  pricing?: ModelBandPricing
  /** Coarse capability/strength score 0..1. Unknown defaults by band. */
  capability?: number
  vision?: boolean
  tool_call?: boolean
  reasoning?: boolean
  context_limit?: number
}

export type ModelBandRequirement = {
  vision?: boolean
  tool_call?: boolean
  reasoning?: boolean
  min_context?: number
  min_capability?: number
}

export type ResolveModelBandInput = {
  /** Requested capability tier (fast/balanced/strong/master). */
  requestedTier: ModelTier
  /** Full enabled candidate pool (already filtered by enable state upstream). */
  candidates: readonly ModelBandCandidate[]
  /** MAIN/parent concrete model key in "provider/model" form. */
  mainModel?: string
  /** MAIN's pricing, used as the relative price reference for cheap/strong bands. */
  mainPricing?: ModelBandPricing
  /** Capability requirements applied before banding. */
  required?: ModelBandRequirement
  /** Explicit per-tier model-pin overrides (from model_routing.tiers.*.model). */
  pinned?: Partial<Record<ModelTier, string>>
  /** Models known unavailable (disabled / negative-cached); never selected. */
  unavailable?: ReadonlySet<string>
}

export type ResolveModelBandResult = {
  model: string
  band: ModelBand
  requestedTier: ModelTier
  requestedBand: ModelBand
  escalated: boolean
  usedMainModel: boolean
}

const BAND_ESCALATION: Record<ModelBand, readonly ModelBand[]> = {
  free: ["free", "cheap_paid", "strong_paid", "main_equiv"],
  cheap_paid: ["cheap_paid", "strong_paid", "main_equiv"],
  strong_paid: ["strong_paid", "main_equiv"],
  main_equiv: ["main_equiv"],
}

const BAND_TO_TIER: Record<ModelBand, ModelTier> = {
  free: "fast",
  cheap_paid: "balanced",
  strong_paid: "strong",
  main_equiv: "master",
}

function isAvailable(model: string, unavailable: ReadonlySet<string> | undefined): boolean {
  return unavailable === undefined || !unavailable.has(model)
}

function isFreePricing(pricing: ModelBandPricing | undefined): boolean {
  if (pricing === undefined) return false
  return (
    pricing.input === 0 &&
    pricing.output === 0 &&
    pricing.cache_read === 0 &&
    pricing.cache_write === 0
  )
}

function meetsRequirement(candidate: ModelBandCandidate, required: ModelBandRequirement | undefined): boolean {
  if (!required) return true
  if (required.vision && candidate.vision !== true) return false
  if (required.tool_call && candidate.tool_call !== true) return false
  if (required.reasoning && candidate.reasoning !== true) return false
  if (required.min_context !== undefined && (candidate.context_limit ?? 0) < required.min_context) return false
  if (required.min_capability !== undefined) {
    const capability = candidate.capability ?? 1.0
    if (capability < required.min_capability) return false
  }
  return true
}

/** Weighted per-1M-token rate used to rank paid candidates by expected cost. */
function expectedCostRate(pricing: ModelBandPricing): number {
  return pricing.input * 0.6 + pricing.output * 0.4
}

/** Compare two candidates by strength (capability, then reasoning, then context). */
function compareStrength(a: ModelBandCandidate, b: ModelBandCandidate): number {
  // Unknown capability ranks neutral (0.5), never above a known-strong or below a known-weak model.
  const ca = a.capability ?? 0.5
  const cb = b.capability ?? 0.5
  if (ca !== cb) return cb - ca
  const ra = a.reasoning === true ? 1 : 0
  const rb = b.reasoning === true ? 1 : 0
  if (ra !== rb) return rb - ra
  const xa = a.context_limit ?? 0
  const xb = b.context_limit ?? 0
  return xb - xa
}

type PaidEntry = { candidate: ModelBandCandidate; costRate: number }

type ClassifiedBands = {
  free: ModelBandCandidate[]
  /** Known-price paid models strictly cheaper than MAIN. */
  cheap: PaidEntry[]
  /** Paid candidate set for the strong band: known paid below/equal MAIN + unknown-priced. */
  strong: PaidEntry[]
}

function classifyBands(
  candidates: readonly ModelBandCandidate[],
  mainModel: string | undefined,
  mainPricing: ModelBandPricing | undefined,
): ClassifiedBands {
  const free: ModelBandCandidate[] = []
  const cheap: PaidEntry[] = []
  const strong: PaidEntry[] = []
  const mainInput = mainPricing?.input

  for (const candidate of candidates) {
    if (mainModel !== undefined && candidate.model === mainModel) continue
    const pricing = candidate.pricing
    if (pricing === undefined) {
      // Unknown price is conservative: never free, never provably cheap.
      strong.push({ candidate, costRate: Number.POSITIVE_INFINITY })
      continue
    }
    if (isFreePricing(pricing)) {
      free.push(candidate)
      continue
    }
    // Paid. A model costing more than MAIN never serves as a cheaper/equal alternative.
    if (mainInput !== undefined && pricing.input > mainInput) continue
    const costRate = expectedCostRate(pricing)
    if (mainInput === undefined || pricing.input < mainInput) {
      cheap.push({ candidate, costRate })
    }
    strong.push({ candidate, costRate })
  }

  return { free, cheap, strong }
}

function pickFree(free: ModelBandCandidate[]): ModelBandCandidate | undefined {
  return [...free].sort((a, b) => compareStrength(a, b) || a.model.localeCompare(b.model))[0]
}

function pickCheap(cheap: PaidEntry[]): ModelBandCandidate | undefined {
  return [...cheap].sort(
    (a, b) =>
      a.costRate - b.costRate ||
      compareStrength(a.candidate, b.candidate) ||
      a.candidate.model.localeCompare(b.candidate.model),
  )[0]?.candidate
}

function pickStrong(strong: PaidEntry[]): ModelBandCandidate | undefined {
  return [...strong].sort((a, b) => {
    const aUnknown = a.costRate === Number.POSITIVE_INFINITY ? 1 : 0
    const bUnknown = b.costRate === Number.POSITIVE_INFINITY ? 1 : 0
    if (aUnknown !== bUnknown) return aUnknown - bUnknown
    return (
      compareStrength(a.candidate, b.candidate) ||
      a.costRate - b.costRate ||
      a.candidate.model.localeCompare(b.candidate.model)
    )
  })[0]?.candidate
}

/**
 * Resolve a concrete model for a requested capability tier from the full enabled
 * catalog, using dynamic economic/capability bands. Returns undefined when no
 * candidate satisfies the request and MAIN is unavailable, signalling the caller
 * to fall through to its existing model resolution.
 */
export function resolveModelBand(input: ResolveModelBandInput): ResolveModelBandResult | undefined {
  const requestedBand = tierToBand(input.requestedTier)

  const result = (model: string, band: ModelBand, usedMainModel: boolean): ResolveModelBandResult => ({
    model,
    band,
    requestedTier: input.requestedTier,
    requestedBand,
    escalated: band !== requestedBand,
    usedMainModel,
  })

  // Explicit pin override for the requested tier (honored unless unavailable).
  const requestedPin = input.pinned?.[input.requestedTier]
  if (requestedPin && isAvailable(requestedPin, input.unavailable)) {
    return result(requestedPin, requestedBand, false)
  }

  // Capability-first filter; also drops unavailable models.
  const eligible = input.candidates.filter(
    (candidate) => isAvailable(candidate.model, input.unavailable) && meetsRequirement(candidate, input.required),
  )

  const { free, cheap, strong } = classifyBands(eligible, input.mainModel, input.mainPricing)

  for (const band of BAND_ESCALATION[requestedBand]) {
    if (band === "main_equiv") {
      const masterPin = input.pinned?.master
      if (masterPin && isAvailable(masterPin, input.unavailable)) {
        return result(masterPin, band, false)
      }
      if (input.mainModel) {
        return result(input.mainModel, band, true)
      }
      continue
    }

    // Higher-tier explicit pin during escalation.
    const bandPin = input.pinned?.[BAND_TO_TIER[band]]
    if (bandPin && isAvailable(bandPin, input.unavailable)) {
      return result(bandPin, band, false)
    }

    const picked =
      band === "free" ? pickFree(free) : band === "cheap_paid" ? pickCheap(cheap) : pickStrong(strong)
    if (picked) {
      return result(picked.model, band, false)
    }
  }

  return undefined
}
