import { describe, expect, test } from "bun:test"
import { extractModelPricingForTest, getModelsWithPricingForDelegateTask } from "./available-models"
import { resolveDynamicWorkerModel } from "./dynamic-model-resolver"
import type { OpencodeClient } from "./types"
import { isFreePricing } from "../../hooks/resource-governor/pricing"
import { writeProviderModelsCache } from "../../shared/connected-providers-cache"

describe("available-models: live cost → pricing (free discovery)", () => {
	test("extracts OpenCode Model.cost into a ModelPricing", () => {
		//#given
		const cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }

		//#when
		const pricing = extractModelPricingForTest(cost)

		//#then
		expect(pricing).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 })
	})

	test("a $0 model is genuinely free", () => {
		//#given
		const pricing = extractModelPricingForTest({ input: 0, output: 0, cache: { read: 0, write: 0 } })

		//#when / #then
		expect(isFreePricing(pricing)).toBe(true)
	})

	test("a model with non-zero input is NOT free", () => {
		//#given
		const pricing = extractModelPricingForTest({ input: 0.8, output: 3.2, cache: { read: 0, write: 0 } })

		//#when / #then
		expect(isFreePricing(pricing)).toBe(false)
	})

	test("a missing/unknown cost yields no pricing (unknown ≠ free)", () => {
		//#given
		const pricing = extractModelPricingForTest(undefined)

		//#when / #then
		expect(pricing).toBeUndefined()
		expect(isFreePricing(pricing)).toBe(false)
	})
})

describe("available-models: provider-models cache → pricing (live cache-hit path)", () => {
	test("extracts pricing from cached cost metadata, including a $0 free model", async () => {
		//#given - a provider-models cache in the real schema: object entries spread the raw
		// metadata (cost included); legacy string entries carry only the model id
		writeProviderModelsCache({
			models: {
				opencode: [
					{ id: "free-model-test", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
					{ id: "paid-model", cost: { input: 0.3, output: 0.9 } },
				],
				legacy: ["string-only-model"],
			},
			connected: ["opencode", "legacy"],
		})
		const client = {} as unknown as OpencodeClient

		//#when
		const { models, pricing } = await getModelsWithPricingForDelegateTask(client)

		//#then - every connected model is available, and cost metadata became pricing
		expect([...models].sort()).toEqual(
			["legacy/string-only-model", "opencode/free-model-test", "opencode/paid-model"].sort(),
		)
		expect(pricing["opencode/free-model-test"]).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 })
		expect(pricing["opencode/paid-model"]).toEqual({ input: 0.3, output: 0.9, cache_read: 0, cache_write: 0 })
		expect(pricing["legacy/string-only-model"]).toBeUndefined()
		expect(isFreePricing(pricing["opencode/free-model-test"])).toBe(true)
		expect(isFreePricing(pricing["opencode/paid-model"])).toBe(false)
	})

	test("a $0 cached model lands in the free band for balanced children without a pricing catalog", async () => {
		//#given - the live cache-hit path: pricing comes only from cached cost metadata
		writeProviderModelsCache({
			models: {
				opencode: [
					{ id: "free-model-test", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
					{ id: "deepseek-v4-flash", cost: { input: 0.3, output: 0.9 } },
					{ id: "main-model", cost: { input: 10, output: 30 } },
				],
			},
			connected: ["opencode"],
		})
		const client = {
			app: { agents: async () => ({}) },
			config: { get: async () => ({ data: {} }) },
		} as unknown as OpencodeClient

		//#when - an ordinary balanced child resolves with no static pricing catalog
		const resolved = await resolveDynamicWorkerModel({
			client,
			tier: "balanced",
			mainModel: "opencode/main-model",
		})

		//#then - the free pool is non-empty, so the child stays free instead of escalating to paid
		expect(resolved.kind).toBe("resolved")
		if (resolved.kind !== "resolved") throw new Error("Expected resolved")
		expect(resolved.model).toBe("opencode/free-model-test")
		expect(resolved.model).not.toBe("opencode/deepseek-v4-flash")
		expect(resolved.band).toBe("free")
		expect(resolved.escalated).toBe(false)
	})
})
