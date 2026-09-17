import { describe, expect, test } from "bun:test"
import { selectNextEligibleWorker } from "./availability-failover"
import type { WorkerCandidate } from "../delegation-ladder"

function worker(model_id: string): WorkerCandidate {
	return { model_id, tier: "free", capability: 1.0, free: true }
}

describe("selectNextEligibleWorker (disabled-model failover)", () => {
	test("selects the next non-unavailable worker", () => {
		//#given
		const workers = [worker("a/free"), worker("b/disabled"), worker("c/free")]
		const unavailable = new Set(["b/disabled"])

		//#when
		const result = selectNextEligibleWorker(workers, 1, unavailable)

		//#then
		expect(result.kind).toBe("next_worker")
		expect(result.kind === "next_worker" && result.index).toBe(2)
		expect(result.kind === "next_worker" && result.worker.model_id).toBe("c/free")
	})

	test("skips the current worker even if it is not in the unavailable set", () => {
		//#given
		const workers = [worker("a/free"), worker("b/free")]

		//#when
		const result = selectNextEligibleWorker(workers, 0, new Set())

		//#then
		expect(result.kind).toBe("next_worker")
		expect(result.kind === "next_worker" && result.worker.model_id).toBe("b/free")
	})

	test("returns no_eligible_worker when every other candidate is unavailable", () => {
		//#given
		const workers = [worker("a/free"), worker("b/disabled"), worker("c/disabled")]
		const unavailable = new Set(["b/disabled", "c/disabled"])

		//#when
		const result = selectNextEligibleWorker(workers, 0, unavailable)

		//#then
		expect(result).toEqual({ kind: "no_eligible_worker" })
	})

	test("V4 Flash unavailable re-resolves to the next eligible worker, never back to the disabled model", () => {
		//#given - plain Flash is the first worker but the provider reports it disabled
		const workers = [
			worker("opencode/deepseek-v4-flash"),
			worker("opencode/gpt-5.4"),
			worker("opencode/deepseek-v4-flash-vision-exp"),
		]
		const unavailable = new Set(["opencode/deepseek-v4-flash"])

		//#when
		const result = selectNextEligibleWorker(workers, 0, unavailable)

		//#then - the next candidate is re-resolved, skipping disabled Flash and Vision Exp
		expect(result.kind).toBe("next_worker")
		expect(result.kind === "next_worker" && result.worker.model_id).toBe("opencode/gpt-5.4")
	})

	test("Vision Exp is never re-selected after plain Flash is disabled", () => {
		//#given - plain Flash and Vision Exp both marked unavailable
		const workers = [worker("opencode/deepseek-v4-flash"), worker("opencode/deepseek-v4-flash-vision-exp"), worker("opencode/gpt-5.4")]
		const unavailable = new Set(["opencode/deepseek-v4-flash", "opencode/deepseek-v4-flash-vision-exp"])

		//#when
		const result = selectNextEligibleWorker(workers, 0, unavailable)

		//#then - re-resolution skips both and reaches an eligible candidate
		expect(result.kind).toBe("next_worker")
		expect(result.kind === "next_worker" && result.worker.model_id).toBe("opencode/gpt-5.4")
	})
})
