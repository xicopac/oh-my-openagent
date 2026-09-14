import { describe, expect, test } from "bun:test"

import {
  discoverFreeModels,
  emptyCatalog,
  estimateCostUsd,
  isFreePricing,
  isZeroCost,
  lookupPricing,
  type ModelPricing,
  type PricingCatalog,
} from "./pricing"

const FREE: ModelPricing = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
const PAID: ModelPricing = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }

describe("pricing", () => {
  // #33 spec: discover $0 models dynamically from registry metadata, never hardcode names
  test("discoverFreeModels returns only provably $0 models", () => {
    // given a catalog with free, paid, and mixed models
    const catalog: PricingCatalog = {
      "vendor/free-a": FREE,
      "vendor/free-b": { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      "vendor/paid": PAID,
      "vendor/partially-free": { input: 0, output: 5, cache_read: 0, cache_write: 0 },
    }
    // when
    const free = discoverFreeModels(catalog)
    // then only fully-zero models are free; partial-zero is NOT free
    expect(free).toEqual(["vendor/free-a", "vendor/free-b"])
  })

  test("isFreePricing treats undefined as not-free (conservative)", () => {
    // given no pricing metadata
    // when / then unknown is never assumed cheap
    expect(isFreePricing(undefined)).toBe(false)
  })

  test("estimateCostUsd computes USD from per-million pricing", () => {
    // given 2M input + 1M output on a paid model priced at $3/$15
    // when
    const est = estimateCostUsd(PAID, { input: 2_000_000, output: 1_000_000, cache_read: 0, cache_write: 0 })
    // then (2*3 + 1*15) = 21 USD
    expect(est.usd).toBeCloseTo(21)
    expect(est.known).toBe(true)
    expect(est.free).toBe(false)
  })

  test("estimateCostUsd marks unknown pricing as not-known, zero, not-free", () => {
    // given no pricing entry (fail-safe: unknown paid status must not be assumed cheap)
    // when
    const est = estimateCostUsd(undefined, { input: 1_000_000, output: 1_000_000, cache_read: 0, cache_write: 0 })
    // then
    expect(est.known).toBe(false)
    expect(est.usd).toBe(0)
    expect(est.free).toBe(false)
  })

  test("free model cost is zero and marked free", () => {
    const est = estimateCostUsd(FREE, { input: 5_000_000, output: 5_000_000, cache_read: 0, cache_write: 0 })
    expect(est.usd).toBe(0)
    expect(est.free).toBe(true)
  })

  test("lookupPricing and isZeroCost agree", () => {
    const catalog: PricingCatalog = { "v/free": FREE, "v/paid": PAID }
    expect(lookupPricing(catalog, "v/free") && isZeroCost(lookupPricing(catalog, "v/free")!)).toBe(true)
    expect(isZeroCost(lookupPricing(catalog, "v/missing")!)).toBe(false)
  })

  test("emptyCatalog has no entries", () => {
    expect(Object.keys(emptyCatalog())).toEqual([])
  })
})
