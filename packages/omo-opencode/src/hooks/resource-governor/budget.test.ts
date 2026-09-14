import { describe, expect, test } from "bun:test"

import { computePressure, resolveBudgetLevels, softBudgetConsumed } from "./budget"

describe("budget", () => {
  test("budget modes seed distinct defaults", () => {
    // given three modes with no overrides
    // when
    const economy = resolveBudgetLevels({ mode: "economy" })
    const normal = resolveBudgetLevels({ mode: "normal" })
    const generous = resolveBudgetLevels({ mode: "generous" })
    // then economy is tightest, generous is loosest
    expect(economy.hard_usd).toBeLessThan(normal.hard_usd)
    expect(normal.hard_usd).toBeLessThan(generous.hard_usd)
    expect(economy.max_concurrent_children).toBeLessThan(normal.max_concurrent_children)
  })

  test("explicit overrides win over mode defaults", () => {
    // given economy mode with explicit hard cap
    // when
    const levels = resolveBudgetLevels({ mode: "economy", hard_usd: 3.0, soft_usd: 1.5 })
    // then explicit wins, and hard never falls below soft
    expect(levels.hard_usd).toBe(3.0)
    expect(levels.soft_usd).toBe(1.5)
  })

  test("hard floor is never below soft", () => {
    // given hard < soft input (misconfig)
    // when
    const levels = resolveBudgetLevels({ mode: "normal", soft_tokens: 20_000_000, hard_tokens: 1 })
    // then hard is clamped to at least soft
    expect(levels.hard_tokens).toBe(20_000_000)
  })

  // #6 spec: soft budget pressure changes routing behavior (progressive pressure)
  test("pressure progresses with utilization", () => {
    // given a normal budget (hard 3 USD / 12M)
    const levels = resolveBudgetLevels({ mode: "normal" })
    // when 0-50% -> normal, 50-75% -> elevated, 75-90% -> high, 90-100% -> critical
    expect(computePressure({ spent_usd: 0.3, spent_tokens: 1_000_000, levels }).pressure).toBe("normal")
    expect(computePressure({ spent_usd: 1.8, spent_tokens: 1_000_000, levels }).pressure).toBe("elevated")
    expect(computePressure({ spent_usd: 2.4, spent_tokens: 1_000_000, levels }).pressure).toBe("high")
    expect(computePressure({ spent_usd: 2.8, spent_tokens: 1_000_000, levels }).pressure).toBe("critical")
  })

  test("token utilization also drives pressure (max of both)", () => {
    // given low USD spend but near token hard cap
    const levels = resolveBudgetLevels({ mode: "normal" })
    // when tokens at 11.5M / 12M (~96%) but USD low
    const result = computePressure({ spent_usd: 0.1, spent_tokens: 11_500_000, levels })
    // then pressure is critical (exhausted? no: 11.5/12 = 0.958 -> critical)
    expect(result.pressure).toBe("critical")
    expect(result.token_utilization).toBeGreaterThan(0.9)
  })

  // #8/#9 spec: hard ceilings are the only block; >=100% -> exhausted
  test("reaching hard paid ceiling marks exhausted", () => {
    const levels = resolveBudgetLevels({ mode: "normal" })
    const result = computePressure({ spent_usd: 3.0, spent_tokens: 1_000_000, levels })
    expect(result.paid_reached_hard).toBe(true)
    expect(result.pressure).toBe("exhausted")
  })

  test("reaching hard token ceiling marks exhausted", () => {
    const levels = resolveBudgetLevels({ mode: "normal" })
    const result = computePressure({ spent_usd: 0.1, spent_tokens: 12_000_000, levels })
    expect(result.token_reached_hard).toBe(true)
    expect(result.pressure).toBe("exhausted")
  })

  test("softBudgetConsumed returns fraction of soft", () => {
    const levels = resolveBudgetLevels({ mode: "normal" })
    expect(softBudgetConsumed({ spent_usd: 0.75, levels })).toBeCloseTo(0.5)
  })
})
