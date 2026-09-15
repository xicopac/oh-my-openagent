import { describe, expect, test } from "bun:test"
import { extractModelPricingForTest } from "./available-models"
import { isFreePricing } from "../../hooks/resource-governor/pricing"

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
