import { describe, test, expect } from "bun:test"
import { ContextGovernorConfigSchema } from "./context-governor"
import { OhMyOpenCodeConfigSchema } from "./oh-my-opencode-config"

describe("ContextGovernorConfigSchema", () => {
  test("defaults enabled to true (our fork enables the governor by default)", () => {
    const parsed = ContextGovernorConfigSchema.parse({})
    expect(parsed.enabled).toBe(true)
    expect(parsed.prepare_at_tokens).toBe(110000)
    expect(parsed.audit_at_tokens).toBe(135000)
    expect(parsed.normal_limit_tokens).toBe(150000)
    expect(parsed.target_after_compaction_tokens).toBe(60000)
    expect(parsed.max_compaction_passes).toBe(3)
  })

  test("an explicit enabled:true keeps the governor enabled", () => {
    const parsed = ContextGovernorConfigSchema.parse({ enabled: true })
    expect(parsed.enabled).toBe(true)
  })

  test("an explicit enabled:false still disables the governor", () => {
    const parsed = ContextGovernorConfigSchema.parse({ enabled: false })
    expect(parsed.enabled).toBe(false)
  })

  test("rejects prepare_at_tokens >= audit_at_tokens", () => {
    const result = ContextGovernorConfigSchema.safeParse({
      prepare_at_tokens: 140000,
      audit_at_tokens: 140000,
    })
    expect(result.success).toBe(false)
  })
})

describe("OhMyOpenCodeConfigSchema context_governor top-level block", () => {
  test("the context_governor key is optional at the top level", () => {
    const parsed = OhMyOpenCodeConfigSchema.parse({})
    expect(parsed.context_governor).toBeUndefined()
  })

  test("explicit top-level context_governor.enabled:false is honored", () => {
    const parsed = OhMyOpenCodeConfigSchema.parse({
      context_governor: { enabled: false },
    })
    expect(parsed.context_governor?.enabled).toBe(false)
  })

  test("explicit top-level context_governor.enabled:true is honored", () => {
    const parsed = OhMyOpenCodeConfigSchema.parse({
      context_governor: { enabled: true },
    })
    expect(parsed.context_governor?.enabled).toBe(true)
  })
})
