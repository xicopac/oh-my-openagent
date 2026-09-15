import { describe, test, expect } from "bun:test"
import { ResourceGovernorConfigSchema } from "./resource-governor"

describe("ResourceGovernorConfigSchema", () => {
  test("defaults enabled to true (our fork enables the governor by default)", () => {
    const parsed = ResourceGovernorConfigSchema.parse({})
    expect(parsed.enabled).toBe(true)
    expect(parsed.paid.hard_usd).toBe(3.0)
    expect(parsed.tokens.hard_total).toBe(12_000_000)
  })

  test("an explicit enabled:false still disables the governor", () => {
    const parsed = ResourceGovernorConfigSchema.parse({ enabled: false })
    expect(parsed.enabled).toBe(false)
  })

  test("rejects soft_usd above hard_usd", () => {
    const result = ResourceGovernorConfigSchema.safeParse({ paid: { soft_usd: 10, hard_usd: 3 } })
    expect(result.success).toBe(false)
  })

  test("delegation_ladder defaults to bounded retry/escalation", () => {
    const parsed = ResourceGovernorConfigSchema.parse({})
    expect(parsed.delegation_ladder.max_attempts_per_tier).toBe(2)
    expect(parsed.delegation_ladder.max_free_attempts_total).toBe(4)
    expect(parsed.delegation_ladder.escalate_after_attempts).toBe(2)
  })

  test("watchdog defaults enabled with monotonic-only thresholds", () => {
    const parsed = ResourceGovernorConfigSchema.parse({})
    expect(parsed.watchdog.enabled).toBe(true)
    expect(parsed.watchdog.quiet_stall_threshold_ms).toBe(180_000)
    expect(parsed.watchdog.wedged_threshold_ms).toBe(300_000)
  })

  test("rejects a non-positive stall threshold", () => {
    const result = ResourceGovernorConfigSchema.safeParse({ watchdog: { quiet_stall_threshold_ms: 0 } })
    expect(result.success).toBe(false)
  })
})
