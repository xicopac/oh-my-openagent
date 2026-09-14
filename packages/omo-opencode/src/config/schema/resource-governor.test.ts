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
})
