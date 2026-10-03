import { describe, test, expect } from "bun:test"

import type { PricingCatalog } from "../../hooks/resource-governor/pricing"
import { buildDelegationWorkerCandidates } from "./free-worker-candidates"

function catalog(entries: Record<string, { input: number; output: number }>): PricingCatalog {
  return Object.fromEntries(
    Object.entries(entries).map(([id, c]) => [id, { input: c.input, output: c.output, cache_read: 0, cache_write: 0 }]),
  )
}

describe("buildDelegationWorkerCandidates", () => {
  test("orders free workers before paid, cheapest first, and always retains the resolved model", () => {
    const pricing = catalog({
      "provider/free-a": { input: 0, output: 0 },
      "provider/free-b": { input: 0, output: 0 },
      "provider/cheap": { input: 0.8, output: 2 },
      "provider/pricy": { input: 15, output: 60 },
      "provider/resolved": { input: 3, output: 15 },
    })

    const candidates = buildDelegationWorkerCandidates({
      pricing,
      available: new Set(["provider/free-a", "provider/free-b", "provider/cheap", "provider/pricy"]),
      resolvedModelID: "provider/resolved",
    })

    const order = candidates.map((c) => c.model_id)
    // Free workers first (sorted), then paid cheapest-first; resolved model always present.
    expect(order[0]).toBe("provider/free-a")
    expect(order[1]).toBe("provider/free-b")
    expect(order).toContain("provider/resolved")

    const free = candidates.filter((c) => c.free)
    expect(free.length).toBe(2)
    expect(free.every((c) => c.tier === "free")).toBe(true)

    // The resolved paid model is classified non-free.
    const resolved = candidates.find((c) => c.model_id === "provider/resolved")
    expect(resolved?.free).toBe(false)
  })

  test("never classifies an unknown-price model as free", () => {
    const pricing = catalog({ "provider/known-paid": { input: 5, output: 20 } })
    const candidates = buildDelegationWorkerCandidates({
      pricing,
      available: new Set(["provider/unknown"]),
      resolvedModelID: "provider/known-paid",
    })

    const unknown = candidates.find((c) => c.model_id === "provider/unknown")
    expect(unknown?.free).toBe(false)
    expect(unknown?.tier).toBe("strong_paid")
  })

  test("excludes unavailable models", () => {
    const pricing = catalog({
      "provider/free-a": { input: 0, output: 0 },
      "provider/unavailable": { input: 0, output: 0 },
    })

    const candidates = buildDelegationWorkerCandidates({
      pricing,
      available: new Set(["provider/free-a"]),
      resolvedModelID: "provider/free-a",
    })

    expect(candidates.some((c) => c.model_id === "provider/unavailable")).toBe(false)
  })

  test("returns an empty ladder when there is no resolved model and no catalog", () => {
    const candidates = buildDelegationWorkerCandidates({
      pricing: {},
      available: new Set(),
      resolvedModelID: null,
    })
    expect(candidates.length).toBe(0)
  })

  describe("#given the ordinary-child free-only policy", () => {
    const pricing = catalog({
      "provider/free-a": { input: 0, output: 0 },
      "provider/free-b": { input: 0, output: 0 },
      "provider/cheap": { input: 0.8, output: 2 },
    })

    test("#when allowPaid is false #then paid and unknown-price candidates are excluded and MAIN is never appended", () => {
      const candidates = buildDelegationWorkerCandidates({
        pricing,
        available: new Set(["provider/free-a", "provider/free-b", "provider/cheap", "provider/unknown"]),
        resolvedModelID: "provider/cheap",
        mainModel: "provider/main-paid",
        allowPaid: false,
      })

      expect(candidates.length).toBe(2)
      expect(candidates.every((candidate) => candidate.free)).toBe(true)
      expect(candidates.map((candidate) => candidate.model_id)).toEqual(["provider/free-a", "provider/free-b"])
      expect(candidates.some((candidate) => candidate.model_id === "provider/cheap")).toBe(false)
      expect(candidates.some((candidate) => candidate.model_id === "provider/unknown")).toBe(false)
      expect(candidates.some((candidate) => candidate.model_id === "provider/main-paid")).toBe(false)
    })

    test("#when allowPaid is false and the free pool is empty #then the ladder is empty (explicit failure upstream)", () => {
      const candidates = buildDelegationWorkerCandidates({
        pricing,
        available: new Set(["provider/cheap"]),
        resolvedModelID: "provider/cheap",
        mainModel: "provider/main-paid",
        allowPaid: false,
      })
      expect(candidates.length).toBe(0)
    })

    test("#when allowPaid is true #then the existing paid escalation behavior is preserved", () => {
      const candidates = buildDelegationWorkerCandidates({
        pricing,
        available: new Set(["provider/free-a", "provider/cheap"]),
        resolvedModelID: "provider/cheap",
        mainModel: "provider/main-paid",
        allowPaid: true,
      })
      expect(candidates.some((candidate) => candidate.model_id === "provider/cheap")).toBe(true)
      expect(candidates.some((candidate) => candidate.model_id === "provider/main-paid")).toBe(true)
    })
  })
})
