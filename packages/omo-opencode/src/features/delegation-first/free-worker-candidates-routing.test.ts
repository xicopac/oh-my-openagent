import { describe, test, expect } from "bun:test"

import type { PricingCatalog } from "../../hooks/resource-governor/pricing"
import { buildDelegationWorkerCandidates } from "./free-worker-candidates"

function catalog(entries: Record<string, { input: number; output: number }>): PricingCatalog {
  return Object.fromEntries(
    Object.entries(entries).map(([id, c]) => [id, { input: c.input, output: c.output, cache_read: 0, cache_write: 0 }]),
  )
}

describe("buildDelegationWorkerCandidates: availability + capability + MAIN rung", () => {
	test("skips a disabled candidate even when it is the resolved model", () => {
		const pricing = catalog({
			"opencode/claude-haiku-4-5": { input: 0.8, output: 4 },
			"opencode-go/qwen3.5-plus": { input: 1, output: 4 },
		})
		const candidates = buildDelegationWorkerCandidates({
			pricing,
			available: new Set(["opencode/claude-haiku-4-5", "opencode-go/qwen3.5-plus"]),
			resolvedModelID: "opencode/claude-haiku-4-5",
			unavailable: new Set(["opencode/claude-haiku-4-5"]),
		})
		const ids = candidates.map((c) => c.model_id)
		expect(ids).not.toContain("opencode/claude-haiku-4-5")
		expect(ids[0]).toBe("opencode-go/qwen3.5-plus")
	})

	test("appends MAIN's model as the terminal expert rung", () => {
		const pricing = catalog({
			"provider/free-a": { input: 0, output: 0 },
		})
		const candidates = buildDelegationWorkerCandidates({
			pricing,
			available: new Set(["provider/free-a"]),
			resolvedModelID: "provider/free-a",
			mainModel: "opencode/deepseek-v4-pro",
		})
		expect(candidates[candidates.length - 1].model_id).toBe("opencode/deepseek-v4-pro")
		expect(candidates[candidates.length - 1].tier).toBe("expert")
	})

	test("does not append MAIN rung when MAIN model is marked unavailable", () => {
		const pricing = catalog({ "provider/free-a": { input: 0, output: 0 } })
		const candidates = buildDelegationWorkerCandidates({
			pricing,
			available: new Set(["provider/free-a"]),
			resolvedModelID: "provider/free-a",
			mainModel: "opencode/deepseek-v4-pro",
			unavailable: new Set(["opencode/deepseek-v4-pro"]),
		})
		expect(candidates.some((c) => c.tier === "expert")).toBe(false)
	})

	test("drops candidates whose known capability is below the floor", () => {
		const pricing = catalog({
			"provider/weak-free": { input: 0, output: 0 },
			"provider/strong-free": { input: 0, output: 0 },
		})
		const capabilities = new Map<string, number>([
			["provider/weak-free", 0.3],
			["provider/strong-free", 0.9],
		])
		const candidates = buildDelegationWorkerCandidates({
			pricing,
			available: new Set(["provider/weak-free", "provider/strong-free"]),
			resolvedModelID: null,
			capabilities,
			minCapability: 0.8,
		})
		const ids = candidates.map((c) => c.model_id)
		expect(ids).not.toContain("provider/weak-free")
		expect(ids).toContain("provider/strong-free")
	})

	test("free model still ranks before paid after filtering", () => {
		const pricing = catalog({
			"provider/free-a": { input: 0, output: 0 },
			"provider/paid-b": { input: 5, output: 20 },
		})
		const candidates = buildDelegationWorkerCandidates({
			pricing,
			available: new Set(["provider/free-a", "provider/paid-b"]),
			resolvedModelID: "provider/paid-b",
		})
		expect(candidates[0].model_id).toBe("provider/free-a")
	})
})
