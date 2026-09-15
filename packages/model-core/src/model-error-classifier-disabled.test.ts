import { describe, expect, test } from "bun:test"
import { isAvailabilityError, isModelDisabledError, shouldRetryError } from "./model-error-classifier"

describe("model-error-classifier: disabled-model availability", () => {
	describe("#given a provider reports a model as disabled", () => {
		test("classifies 'Model is disabled' as a disabled-model error", () => {
			//#when
			const result = isModelDisabledError({ name: "AI_APICallError", message: "Model is disabled" })

			//#then
			expect(result).toBe(true)
		})

		test("classifies 'model disabled' (no 'is') as disabled", () => {
			//#when
			const result = isModelDisabledError({ message: "model disabled" })

			//#then
			expect(result).toBe(true)
		})

		test("does not classify an unrelated error as disabled", () => {
			//#when
			const result = isModelDisabledError({ message: "context length exceeded" })

			//#then
			expect(result).toBe(false)
		})
	})

	describe("#given an availability error", () => {
		test("disabled model is an availability error", () => {
			//#given
			const error = { name: "AI_APICallError", message: "Model is disabled" }

			//#when
			const result = isAvailabilityError(error)

			//#then
			expect(result).toBe(true)
		})

		test("model-not-found is an availability error", () => {
			//#given
			const error = { message: "model not found" }

			//#when
			const result = isAvailabilityError(error)

			//#then
			expect(result).toBe(true)
		})

		test("a transient retryable overload is NOT an availability error", () => {
			//#given
			const error = { message: "provider is overloaded" }

			//#when
			const result = isAvailabilityError(error)

			//#then
			expect(result).toBe(false)
		})
	})

	describe("#given a disabled model error and the retry classifier", () => {
		test("disabled model is NOT treated as a quality retry", () => {
			//#given
			const error = { name: "AI_APICallError", message: "Model is disabled" }

			//#when
			const retryable = shouldRetryError(error)

			//#then
			expect(retryable).toBe(false)
		})
	})
})
