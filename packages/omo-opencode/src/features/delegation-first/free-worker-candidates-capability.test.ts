import { describe, test, expect } from "bun:test"

import type { PricingCatalog, ModelPricing } from "../../hooks/resource-governor/pricing"
import {
  buildDelegationWorkerCandidates,
  type ModelCapabilityInfo,
} from "./free-worker-candidates"

function catalog(
  entries: Record<string, Partial<ModelPricing>>,
): PricingCatalog {
  return Object.fromEntries(
    Object.entries(entries).map(([id, c]) => [
      id,
      { input: c.input ?? 0, output: c.output ?? 0, cache_read: c.cache_read ?? 0, cache_write: c.cache_write ?? 0 },
    ]),
  )
}

describe("buildDelegationWorkerCandidates: capability + price dimensions", () => {
  test("retains all four price dimensions on a candidate", () => {
    const pricing = catalog({
      "provider/paid": { input: 3, output: 15, cache_read: 0.6, cache_write: 15 },
    })
    const candidates = buildDelegationWorkerCandidates({
      pricing,
      available: new Set(["provider/paid"]),
      resolvedModelID: null,
    })
    const paid = candidates.find((c) => c.model_id === "provider/paid")
    expect(paid?.cost_usd_per_1m_input).toBe(3)
    expect(paid?.cost_usd_per_1m_output).toBe(15)
    expect(paid?.cost_usd_per_1m_cache_read).toBe(0.6)
    expect(paid?.cost_usd_per_1m_cache_write).toBe(15)
  })

  test("a vision requirement drops non-vision models and keeps vision ones", () => {
    const pricing = catalog({
      "provider/text-free": { input: 0, output: 0 },
      "provider/vision-free": { input: 0, output: 0 },
    })
    const modelInfo = new Map<string, ModelCapabilityInfo>([
      ["provider/text-free", { vision: false, tool_call: true }],
      ["provider/vision-free", { vision: true, tool_call: true }],
    ])
    const candidates = buildDelegationWorkerCandidates({
      pricing,
      available: new Set(["provider/text-free", "provider/vision-free"]),
      resolvedModelID: null,
      modelInfo,
      required: { vision: true },
    })
    const ids = candidates.map((c) => c.model_id)
    expect(ids).toContain("provider/vision-free")
    expect(ids).not.toContain("provider/text-free")
  })

  test("a min_context requirement drops models with too small a window", () => {
    const pricing = catalog({
      "provider/small": { input: 0, output: 0 },
      "provider/large": { input: 0, output: 0 },
    })
    const modelInfo = new Map<string, ModelCapabilityInfo>([
      ["provider/small", { context_limit: 4000 }],
      ["provider/large", { context_limit: 128000 }],
    ])
    const candidates = buildDelegationWorkerCandidates({
      pricing,
      available: new Set(["provider/small", "provider/large"]),
      resolvedModelID: null,
      modelInfo,
      required: { min_context: 32000 },
    })
    expect(candidates.map((c) => c.model_id)).toEqual(["provider/large"])
  })

  test("attaches vision / tool_call / context metadata to candidates", () => {
    const pricing = catalog({ "provider/m": { input: 0, output: 0 } })
    const modelInfo = new Map<string, ModelCapabilityInfo>([
      ["provider/m", { vision: true, tool_call: false, reasoning: true, context_limit: 200000 }],
    ])
    const candidates = buildDelegationWorkerCandidates({
      pricing,
      available: new Set(["provider/m"]),
      resolvedModelID: null,
      modelInfo,
    })
    expect(candidates[0].vision).toBe(true)
    expect(candidates[0].tool_call).toBe(false)
    expect(candidates[0].reasoning).toBe(true)
    expect(candidates[0].context_limit).toBe(200000)
  })

  test("unknown capability info passes through when no requirement is set", () => {
    const pricing = catalog({ "provider/unknown-cap": { input: 0, output: 0 } })
    const candidates = buildDelegationWorkerCandidates({
      pricing,
      available: new Set(["provider/unknown-cap"]),
      resolvedModelID: null,
    })
    expect(candidates.length).toBe(1)
  })

  test("a tool_call requirement drops models without known tool support", () => {
    const pricing = catalog({
      "provider/no-tools": { input: 0, output: 0 },
      "provider/tools": { input: 0, output: 0 },
    })
    const modelInfo = new Map<string, ModelCapabilityInfo>([
      ["provider/no-tools", { tool_call: false }],
      ["provider/tools", { tool_call: true }],
    ])
    const candidates = buildDelegationWorkerCandidates({
      pricing,
      available: new Set(["provider/no-tools", "provider/tools"]),
      resolvedModelID: null,
      modelInfo,
      required: { tool_call: true },
    })
    expect(candidates.map((c) => c.model_id)).toEqual(["provider/tools"])
  })
})
