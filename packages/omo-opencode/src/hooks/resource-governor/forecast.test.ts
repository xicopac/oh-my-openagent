import { describe, expect, test } from "bun:test"

import {
  buildTaskResourcePlan,
  computeForecastVariance,
  difficultyFromExpectedTokens,
  planExpectedTokens,
  updateHistoricalMultiplier,
  HISTORICAL_MULTIPLIER_MAX,
  HISTORICAL_MULTIPLIER_MIN,
} from "./forecast"

describe("forecast", () => {
  // #1 spec: task-start resource plan exists for substantial orchestration
  test("buildTaskResourcePlan produces a full plan", () => {
    // given a medium difficulty task
    // when
    const plan = buildTaskResourcePlan({ difficulty: "medium", hard_paid_ceiling_usd: 3.0 })
    // then it has root, exploration, implementation, verification, reserve
    expect(plan.root_tokens).toBeGreaterThan(0)
    expect(plan.free_exploration_tokens).toBeGreaterThan(0)
    expect(plan.reserve_tokens).toBeGreaterThan(0)
    expect(plan.hard_paid_ceiling_usd).toBe(3.0)
    expect(planExpectedTokens(plan)).toBeGreaterThan(6_000_000)
  })

  // #2 spec: simple task can bypass expensive orchestration
  test("low difficulty yields a small, cheap plan", () => {
    const plan = buildTaskResourcePlan({ difficulty: "low", hard_paid_ceiling_usd: 0.5 })
    expect(plan.expected_worker_count).toBe(1)
    expect(planExpectedTokens(plan)).toBeLessThan(1_000_000)
    expect(plan.expected_paid_spend_usd).toBeLessThan(0.5)
  })

  test("difficultyFromExpectedTokens buckets the first delegation budget", () => {
    expect(difficultyFromExpectedTokens(100_000)).toBe("low")
    expect(difficultyFromExpectedTokens(500_000)).toBe("low")
    expect(difficultyFromExpectedTokens(500_001)).toBe("medium")
    expect(difficultyFromExpectedTokens(2_000_000)).toBe("medium")
    expect(difficultyFromExpectedTokens(2_000_001)).toBe("high")
  })

  // #26 spec: expected vs actual variance computed
  test("computeForecastVariance reports token/paid/worker error", () => {
    // given a plan and actuals that overran
    const plan = buildTaskResourcePlan({ difficulty: "medium", hard_paid_ceiling_usd: 3.0 })
    // when
    const v = computeForecastVariance({ plan, actual_tokens: 7_700_000, actual_paid_usd: 1.47, actual_workers: 4 })
    // then +10% tokens, +5% paid, +33% workers (approx)
    expect(v.token_error).toBeGreaterThan(0.09)
    expect(v.token_error).toBeLessThan(0.11)
    expect(v.paid_error).toBeCloseTo(0.05, 1)
    expect(v.worker_error).toBeCloseTo(0.33, 1)
  })

  // #27 spec: historical forecast multiplier updates boundedly
  test("updateHistoricalMultiplier blends new observations", () => {
    // given a prior multiplier of 1.0 with 4 samples and a 2.4x observation
    // when
    const next = updateHistoricalMultiplier({ multiplier: 1.0, samples: 4 }, 2.4)
    // then it moves toward 2.4 but does not jump all the way
    expect(next.multiplier).toBeGreaterThan(1.0)
    expect(next.multiplier).toBeLessThan(2.4)
    expect(next.samples).toBe(5)
  })

  // #28 spec: anomalous single run does not wildly distort future estimate
  test("multiplier is clamped to [0.1, 5.0]", () => {
    // given an absurd 100x observation
    // when
    const high = updateHistoricalMultiplier({ multiplier: 1.0, samples: 1 }, 100)
    const low = updateHistoricalMultiplier({ multiplier: 1.0, samples: 1 }, 0.001)
    // then both clamp
    expect(high.multiplier).toBeLessThanOrEqual(HISTORICAL_MULTIPLIER_MAX)
    expect(low.multiplier).toBeGreaterThanOrEqual(HISTORICAL_MULTIPLIER_MIN)
  })

  test("first sample carries bounded signal (single anomalous run)", () => {
    // given no prior samples and one observation of 5.0
    // when
    const next = updateHistoricalMultiplier({ multiplier: 1.0, samples: 0 }, 5.0)
    // then it equals the clamp, not an unbounded value
    expect(next.multiplier).toBeLessThanOrEqual(5.0)
    expect(next.samples).toBe(1)
  })
})
