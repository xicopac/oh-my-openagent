import { describe, test, expect } from "bun:test"

import type { PricingCatalog } from "../../hooks/resource-governor/pricing"
import { buildDelegationWorkerCandidates, reselectFreeWorker } from "./free-worker-candidates"

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

describe("reselectFreeWorker", () => {
  const pricing = catalog({
    "provider/free-a": { input: 0, output: 0 },
    "provider/free-b": { input: 0, output: 0 },
    "provider/cheap": { input: 0.8, output: 2 },
    "provider/paid": { input: 4, output: 16 },
  })

  test("#given a paid resolved model and available $0 candidates #when reselectFreeWorker runs #then it selects an available $0 candidate", () => {
    // given
    const available = new Set(["provider/free-a", "provider/free-b", "provider/paid"])

    // when
    const result = reselectFreeWorker({
      pricing,
      available,
      resolvedModelID: "provider/paid",
    })

    // then
    expect(result.reselected).toBe(true)
    expect(result.modelID).toBe("provider/free-a")
    expect(result.candidates.every((candidate) => candidate.free)).toBe(true)
    expect(result.freeCandidatesExhausted).toBe(false)
  })

  test("#given the resolved model is already an available $0 candidate #when reselectFreeWorker runs #then it keeps the resolved model", () => {
    // given
    const available = new Set(["provider/paid", "provider/free-a", "provider/free-b"])

    // when
    const result = reselectFreeWorker({
      pricing,
      available,
      resolvedModelID: "provider/free-b",
    })

    // then
    expect(result.reselected).toBe(false)
    expect(result.modelID).toBe("provider/free-b")
    expect(result.freeCandidatesExhausted).toBe(false)
  })

  test("#given the resolved $0 model is unavailable #when reselectFreeWorker runs #then it selects another available $0 candidate", () => {
    // given
    const available = new Set(["provider/free-b", "provider/paid"])

    // when
    const result = reselectFreeWorker({
      pricing,
      available,
      resolvedModelID: "provider/free-a",
    })

    // then
    expect(result.reselected).toBe(true)
    expect(result.modelID).toBe("provider/free-b")
  })

  test("#given no $0 candidate is available #when reselectFreeWorker runs #then it keeps the resolved model and reports exhaustion", () => {
    // given
    const available = new Set(["provider/cheap", "provider/paid"])

    // when
    const result = reselectFreeWorker({
      pricing,
      available,
      resolvedModelID: "provider/paid",
    })

    // then
    expect(result.reselected).toBe(false)
    expect(result.modelID).toBe("provider/paid")
    expect(result.freeCandidatesExhausted).toBe(true)
  })

  test("#given an empty live model pool #when reselectFreeWorker runs #then it does not claim free exhaustion", () => {
    // given
    const available = new Set<string>()

    // when
    const result = reselectFreeWorker({
      pricing,
      available,
      resolvedModelID: "provider/paid",
    })

    // then
    expect(result.reselected).toBe(false)
    expect(result.modelID).toBe("provider/paid")
    expect(result.freeCandidatesExhausted).toBe(false)
  })

  test("#given an explicit caller model pin #when reselectFreeWorker runs #then it never replaces the resolved model", () => {
    // given
    const available = new Set(["provider/free-a", "provider/paid"])

    // when
    const result = reselectFreeWorker({
      pricing,
      available,
      resolvedModelID: "provider/paid",
      pinned: true,
    })

    // then
    expect(result.reselected).toBe(false)
    expect(result.modelID).toBe("provider/paid")
    expect(result.freeCandidatesExhausted).toBe(false)
  })

  test("#given a required capability no $0 candidate meets #when reselectFreeWorker runs #then it keeps the resolved model and reports exhaustion", () => {
    // given
    const available = new Set(["provider/free-a", "provider/free-b", "provider/paid"])
    const modelInfo = new Map([
      ["provider/free-a", { capabilities: { vision: false, tool_call: true, reasoning: "low", context_window: 128000 } }],
      ["provider/free-b", { capabilities: { vision: false, tool_call: true, reasoning: "low", context_window: 128000 } }],
      ["provider/paid", { capabilities: { vision: true, tool_call: true, reasoning: "high", context_window: 200000 } }],
    ])

    // when
    const result = reselectFreeWorker({
      pricing,
      available,
      resolvedModelID: "provider/paid",
      modelInfo,
      required: { vision: true },
    })

    // then
    expect(result.reselected).toBe(false)
    expect(result.modelID).toBe("provider/paid")
    expect(result.freeCandidatesExhausted).toBe(true)
  })

  test("#given resolved model is free but not in the available pool #when reselectFreeWorker runs #then it selects an available $0 candidate", () => {
    // given
    const available = new Set(["provider/free-b", "provider/paid"])

    // when
    const result = reselectFreeWorker({
      pricing,
      available,
      resolvedModelID: "provider/free-a",
    })

    // then
    expect(result.reselected).toBe(true)
    expect(result.modelID).toBe("provider/free-b")
  })
})
