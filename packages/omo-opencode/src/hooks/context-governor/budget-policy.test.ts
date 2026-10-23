import { describe, expect, test } from "bun:test"
import {
  PROACTIVE_COMPACTION_TOKENS,
  MANDATORY_COMPACTION_TOKENS,
  PRE_DISPATCH_CEILING_TOKENS,
  POST_COMPACTION_MIN_TOKENS,
  POST_COMPACTION_MAX_TOKENS,
  POST_COMPACTION_TARGET_TOKENS,
  resolveOutputReserve,
  resolveContextBudget,
  boundaryDecision,
  measureContextReduction,
  type ContextBudgetPlan,
} from "./budget-policy"

/**
 * Helper: compute a ContextBudgetPlan for a given window size and optional max output,
 * then assert the plan matches expected values.
 */
function planForWindow(
  windowTokens: number,
  maxOutputTokens?: number | null,
  overrides?: Partial<ContextBudgetPlan>,
) {
  const plan = resolveContextBudget({ windowTokens, maxOutputTokens })
  return { plan, ...overrides }
}

describe("budget-policy constants", () => {
  test("constants have correct values", () => {
    expect(PROACTIVE_COMPACTION_TOKENS).toBe(60_000)
    expect(MANDATORY_COMPACTION_TOKENS).toBe(90_000)
    expect(PRE_DISPATCH_CEILING_TOKENS).toBe(150_000)
    expect(POST_COMPACTION_MIN_TOKENS).toBe(10_000)
    expect(POST_COMPACTION_MAX_TOKENS).toBe(20_000)
    expect(POST_COMPACTION_TARGET_TOKENS).toBe(15_000)
    // target must lie inside min..max
    expect(POST_COMPACTION_TARGET_TOKENS).toBeGreaterThanOrEqual(POST_COMPACTION_MIN_TOKENS)
    expect(POST_COMPACTION_TARGET_TOKENS).toBeLessThanOrEqual(POST_COMPACTION_MAX_TOKENS)
  })
})

describe("resolveOutputReserve", () => {
  test("with maxOutputTokens 8000 on 128k => 8000", () => {
    expect(resolveOutputReserve(128_000, 8000)).toBe(8000)
  })

  test("without maxOutputTokens on 128k => 12800", () => {
    expect(resolveOutputReserve(128_000)).toBe(12_800)
  })

  test("tiny 2048 window yields reserve >=1024 and < window", () => {
    const r = resolveOutputReserve(2048)
    expect(r).toBeGreaterThanOrEqual(1024)
    expect(r).toBeLessThan(2048)
  })

  test("1_000_000 window with 32k max output => 32000", () => {
    expect(resolveOutputReserve(1_000_000, 32_000)).toBe(32_000)
  })
})

describe("resolveContextBudget", () => {
  test("1_000_000 window, 32k max output: exact 60000/90000/150000, bindingLimit none, target 15000", () => {
    const plan = resolveContextBudget({ windowTokens: 1_000_000, maxOutputTokens: 32_000 })
    expect(plan.proactiveAt).toBe(60_000)
    expect(plan.mandatoryAt).toBe(90_000)
    expect(plan.preDispatchCeiling).toBe(150_000)
    expect(plan.bindingLimit).toBe("none")
    expect(plan.postCompactionTarget).toBe(15_000)
  })

  test("128_000 window: reserve 12800, usable 115200, proactive 60000, mandatory 90000, ceiling 115200, bindingLimit ceiling", () => {
    const plan = resolveContextBudget({ windowTokens: 128_000 })
    expect(plan.reservedOutputTokens).toBe(12_800)
    expect(plan.usableTokens).toBe(115_200)
    expect(plan.proactiveAt).toBe(60_000)
    expect(plan.mandatoryAt).toBe(90_000)
    expect(plan.preDispatchCeiling).toBe(115_200)
    expect(plan.bindingLimit).toBe("ceiling")
    expect(plan.postCompactionTarget).toBeGreaterThan(0)
  })

  test("200_000 window: reserve 20000, usable 180000, exact fixed thresholds, bindingLimit none", () => {
    const plan = resolveContextBudget({ windowTokens: 200_000 })
    expect(plan.reservedOutputTokens).toBe(20_000)
    expect(plan.usableTokens).toBe(180_000)
    expect(plan.proactiveAt).toBe(60_000)
    expect(plan.mandatoryAt).toBe(90_000)
    expect(plan.preDispatchCeiling).toBe(150_000)
    expect(plan.bindingLimit).toBe("none")
    expect(plan.postCompactionTarget).toBe(15_000)
  })

  test("32_000 window: reserve 3200, usable 28800; ordering holds (proactive < mandatory <= ceiling) and all values >0", () => {
    const plan = resolveContextBudget({ windowTokens: 32_000 })
    expect(plan.reservedOutputTokens).toBe(3_200)
    expect(plan.usableTokens).toBe(28_800)
    expect(plan.proactiveAt).toBeGreaterThan(0)
    expect(plan.mandatoryAt).toBeGreaterThan(plan.proactiveAt)
    expect(plan.preDispatchCeiling).toBeGreaterThanOrEqual(plan.mandatoryAt)
    expect(plan.proactiveAt < plan.mandatoryAt).toBe(true)
    expect(plan.mandatoryAt <= plan.preDispatchCeiling).toBe(true)
  })

  test("boundary decisions at proactive-1/proactive, mandatory-1/mandatory, ceiling/ceiling+1", () => {
    const plan = resolveContextBudget({ windowTokens: 500_000 })

    // Below proactive
    expect(boundaryDecision(plan, plan.proactiveAt - 1).level).toBe("ok")
    // At proactive
    expect(boundaryDecision(plan, plan.proactiveAt).level).toBe("proactive")
    // At mandatory - 1 (still proactive)
    expect(boundaryDecision(plan, plan.mandatoryAt - 1).level).toBe("proactive")
    // At mandatory
    expect(boundaryDecision(plan, plan.mandatoryAt).level).toBe("mandatory")
    // At ceiling
    expect(boundaryDecision(plan, plan.preDispatchCeiling).level).toBe("mandatory")
    // At ceiling + 1 (blocked)
    expect(boundaryDecision(plan, plan.preDispatchCeiling + 1).level).toBe("blocked")
  })
})

describe("measureContextReduction", () => {
  test("150000 -> 15000 => 135000, 0.9", () => {
    const result = measureContextReduction(150_000, 15_000)
    expect(result.reductionTokens).toBe(135_000)
    expect(result.reductionRatio).toBe(0.9)
  })

  test("safe for 0 before tokens", () => {
    const result = measureContextReduction(0, 0)
    expect(result.reductionTokens).toBe(0)
    expect(result.reductionRatio).toBe(0)
  })

  test("before equals after, ratio 0", () => {
    const result = measureContextReduction(10_000, 10_000)
    expect(result.reductionTokens).toBe(0)
    expect(result.reductionRatio).toBe(0)
  })

  test("reductionRatio clamped to [0,1]", () => {
    const result = measureContextReduction(5_000, 0)
    expect(result.reductionRatio).toBe(1)
  })
})