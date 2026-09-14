import { describe, expect, test } from "bun:test"
import { OhMyOpenCodeConfigSchema } from "./oh-my-opencode-config"
import { ModelRoutingConfigSchema } from "./model-routing"

describe("model_routing config", () => {
  test("#given a full model_routing section #when parsed #then it accepts all four tiers", () => {
    const config = {
      model_routing: {
        enabled: true,
        tiers: {
          fast: { model: "opencode/nemotron-3.5-lightning-free" },
          balanced: { model: "opencode/mimo-v2.5-free" },
          strong: { model: "opencode/deepseek-v4-pro" },
          master: { inherit_parent: true },
        },
      },
    }
    const result = OhMyOpenCodeConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.model_routing?.enabled).toBe(true)
      expect(result.data.model_routing?.tiers?.fast?.model).toBe("opencode/nemotron-3.5-lightning-free")
      expect(result.data.model_routing?.tiers?.master?.inherit_parent).toBe(true)
    }
  })

  test("#given omitting model_routing #when parsed #then config still succeeds (backward compatible)", () => {
    const result = OhMyOpenCodeConfigSchema.safeParse({ model_fallback: true })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.model_routing).toBeUndefined()
    }
  })

  test("#given an unknown tier name #when parsed #then the unknown key is ignored (only four known tiers survive)", () => {
    const result = ModelRoutingConfigSchema.safeParse({
      tiers: { turbo: { model: "opencode/x" }, fast: { model: "opencode/nemotron-3.5-lightning-free" } },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tiers?.fast?.model).toBe("opencode/nemotron-3.5-lightning-free")
      expect(Object.keys(result.data.tiers ?? {})).toEqual(["fast"])
    }
  })
})
