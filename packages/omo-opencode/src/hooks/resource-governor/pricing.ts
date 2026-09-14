/**
 * Pricing catalog + free-model discovery + cost estimation for the Resource
 * Governor. Pure: the catalog is injected, never imported, so unit tests and
 * the mocked E2E fixture can supply arbitrary pricing without touching disk or
 * a live provider registry.
 *
 * Prices follow the OpenGateway catalog convention: USD per 1,000,000 tokens
 * for each of input / output / cache_read / cache_write (spec section 8).
 */

export type ModelPricing = {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export type PricingCatalog = Readonly<Record<string, ModelPricing>>

/** Tokens broken into the buckets the pricing model charges separately. */
export type TokenBreakdown = {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export type EstimatedCost = {
  usd: number
  /** True when the cost is derived from pricing metadata; false when unknown. */
  known: boolean
  free: boolean
}

const FREE_PRICING: ModelPricing = { input: 0, output: 0, cache_read: 0, cache_write: 0 }

/**
 * A model is free only when every pricing bucket is zero. An unknown model is
 * NOT free: unknown paid status must be treated conservatively, never assumed
 * cheap (spec section 27).
 */
export function isFreePricing(pricing: ModelPricing | undefined): boolean {
  if (pricing === undefined) return false
  return (
    pricing.input === 0 &&
    pricing.output === 0 &&
    pricing.cache_read === 0 &&
    pricing.cache_write === 0
  )
}

/** Discover every model id in the catalog whose pricing is provably $0. */
export function discoverFreeModels(catalog: PricingCatalog): string[] {
  const free: string[] = []
  for (const [modelID, pricing] of Object.entries(catalog)) {
    if (isFreePricing(pricing)) free.push(modelID)
  }
  return free.sort()
}

/**
 * Estimate USD cost for a token breakdown. Returns `known: false` and a zero
 * cost when the model has no pricing metadata, signalling the caller to apply
 * fail-safe behavior rather than trust a fabricated number.
 */
export function estimateCostUsd(
  pricing: ModelPricing | undefined,
  tokens: TokenBreakdown,
): EstimatedCost {
  if (pricing === undefined) {
    return { usd: 0, known: false, free: false }
  }
  const usd =
    (tokens.input * pricing.input +
      tokens.output * pricing.output +
      tokens.cache_read * pricing.cache_read +
      tokens.cache_write * pricing.cache_write) /
    1_000_000
  return { usd, known: true, free: isFreePricing(pricing) }
}

export function lookupPricing(catalog: PricingCatalog, modelID: string): ModelPricing | undefined {
  return catalog[modelID]
}

/**
 * Default pricing for a fixture when no catalog entry exists. Never used in
 * production; callers must pass an explicit catalog so a missing entry is
 * treated as unknown rather than silently defaulted to free.
 */
export function emptyCatalog(): PricingCatalog {
  return {}
}

export function isZeroCost(pricing: ModelPricing): boolean {
  return pricing === FREE_PRICING || isFreePricing(pricing)
}
