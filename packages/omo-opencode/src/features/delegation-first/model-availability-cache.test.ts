import { describe, expect, test } from "bun:test"
import { createModelAvailabilityCache } from "./model-availability-cache"

describe("model-availability-cache (negative availability)", () => {
	test("marks a model unavailable and reports it", () => {
		//#given
		const cache = createModelAvailabilityCache()

		//#when
		cache.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)

		//#then
		expect(cache.isUnavailable("opencode/claude-haiku-4-5", 0)).toBe(true)
	})

	test("does not report an unmarked model unavailable", () => {
		//#given
		const cache = createModelAvailabilityCache()

		//#when
		const result = cache.isUnavailable("opencode-go/qwen3.5-plus", 0)

		//#then
		expect(result).toBe(false)
	})

	test("entry expires after TTL", () => {
		//#given
		const cache = createModelAvailabilityCache({ ttlMs: 10_000 })
		cache.markUnavailable("opencode/claude-haiku-4-5", "disabled", 0)

		//#when
		const before = cache.isUnavailable("opencode/claude-haiku-4-5", 9_999)
		const after = cache.isUnavailable("opencode/claude-haiku-4-5", 10_001)

		//#then
		expect(before).toBe(true)
		expect(after).toBe(false)
	})

	test("bounded at maxEntries, evicting oldest", () => {
		//#given
		const cache = createModelAvailabilityCache({ maxEntries: 2, ttlMs: 60_000 })

		//#when
		cache.markUnavailable("a/model-1", "disabled", 0)
		cache.markUnavailable("b/model-2", "disabled", 1)
		cache.markUnavailable("c/model-3", "disabled", 2)

		//#then
		expect(cache.size()).toBe(2)
		expect(cache.isUnavailable("a/model-1", 2)).toBe(false)
		expect(cache.isUnavailable("c/model-3", 2)).toBe(true)
	})

	test("unavailableKeys returns only live (unexpired) keys", () => {
		//#given
		const cache = createModelAvailabilityCache({ ttlMs: 10_000 })
		cache.markUnavailable("a/model-1", "disabled", 0)
		cache.markUnavailable("b/model-2", "disabled", 0)

		//#when
		const liveAt = cache.unavailableKeys(5_000).sort()

		//#then
		expect(liveAt).toEqual(["a/model-1", "b/model-2"])
	})

	test("clear(key) removes a single entry", () => {
		//#given
		const cache = createModelAvailabilityCache()
		cache.markUnavailable("a/model-1", "disabled", 0)

		//#when
		cache.clear("a/model-1")

		//#then
		expect(cache.isUnavailable("a/model-1", 0)).toBe(false)
	})
})
