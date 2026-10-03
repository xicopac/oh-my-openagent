import { describe, expect, test } from "bun:test"
import type { ModelRoutingConfig } from "../config/schema"
import {
  applyConfiguredMasterModel,
  resolveConfiguredMasterModel,
} from "./master-model-authority"

const MASTER = "opencode/deepseek-v4.1-flash"
const STALE = "opencode/deepseek-v4-flash"

function routing(overrides: Partial<ModelRoutingConfig> = {}): ModelRoutingConfig {
  return {
    enabled: true,
    tiers: {
      master: { model: MASTER, inherit_parent: false },
    },
    ...overrides,
  } as ModelRoutingConfig
}

describe("#given an explicit master pin in model_routing", () => {
  test("#then it resolves as the authoritative master model", () => {
    expect(resolveConfiguredMasterModel(routing())).toBe(MASTER)
  })

  test("#when inherit_parent is omitted #then no master override is produced", () => {
    const config = { enabled: true, tiers: { master: { model: MASTER } } } as ModelRoutingConfig
    expect(resolveConfiguredMasterModel(config)).toBeUndefined()
  })

  test("#when inherit_parent is true #then no master override is produced", () => {
    const config = {
      enabled: true,
      tiers: { master: { model: MASTER, inherit_parent: true } },
    } as ModelRoutingConfig
    expect(resolveConfiguredMasterModel(config)).toBeUndefined()
  })

  test("#when the model is blank #then no master override is produced", () => {
    const config = {
      enabled: true,
      tiers: { master: { model: "   ", inherit_parent: false } },
    } as ModelRoutingConfig
    expect(resolveConfiguredMasterModel(config)).toBeUndefined()
  })

  test("#when model_routing is absent #then no master override is produced", () => {
    expect(resolveConfiguredMasterModel(undefined)).toBeUndefined()
  })
})

describe("#given a stale OpenCode config model (DeepSeek V4 Flash)", () => {
  test("#when the master pin is applied #then config.model is rewritten to V4.1 Flash", () => {
    const config: Record<string, unknown> = { model: STALE }
    const applied = applyConfiguredMasterModel(config, { model_routing: routing() })
    expect(applied).toBe(MASTER)
    expect(config.model).toBe(MASTER)
  })

  test("#when a restart re-applies the same pin #then the result is stable and idempotent", () => {
    const config: Record<string, unknown> = { model: STALE }
    applyConfiguredMasterModel(config, { model_routing: routing() })
    applyConfiguredMasterModel(config, { model_routing: routing() })
    applyConfiguredMasterModel(config, { model_routing: routing() })
    expect(config.model).toBe(MASTER)
  })

  test("#when no master pin is configured #then the existing model is left untouched", () => {
    const config: Record<string, unknown> = { model: STALE }
    const applied = applyConfiguredMasterModel(config, {})
    expect(applied).toBeUndefined()
    expect(config.model).toBe(STALE)
  })
})
