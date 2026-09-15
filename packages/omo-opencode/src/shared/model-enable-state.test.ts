import { describe, test, expect } from "bun:test"

import {
  computeModelEnableState,
  isModelEnabled,
  filterEnabledModelKeys,
} from "./model-enable-state"

describe("computeModelEnableState", () => {
  test("disabled providers exclude every model under them", () => {
    const state = computeModelEnableState({ disabled_providers: ["openai"] })
    expect(isModelEnabled("openai/gpt-5", state)).toBe(false)
    expect(isModelEnabled("anthropic/claude", state)).toBe(true)
  })

  test("enabled_providers acts as an allowlist", () => {
    const state = computeModelEnableState({ enabled_providers: ["opencode"] })
    expect(isModelEnabled("opencode/deepseek-v4-pro", state)).toBe(true)
    expect(isModelEnabled("openai/gpt-5", state)).toBe(false)
  })

  test("a provider blacklist disables only the listed models", () => {
    const state = computeModelEnableState({
      provider: { opencode: { blacklist: ["claude-haiku-4-5"] } },
    })
    expect(isModelEnabled("opencode/claude-haiku-4-5", state)).toBe(false)
    expect(isModelEnabled("opencode/qwen3.5-plus", state)).toBe(true)
  })

  test("a provider whitelist enables only the listed models", () => {
    const state = computeModelEnableState({
      provider: { opencode: { whitelist: ["qwen3.5-plus"] } },
    })
    expect(isModelEnabled("opencode/qwen3.5-plus", state)).toBe(true)
    expect(isModelEnabled("opencode/claude-haiku-4-5", state)).toBe(false)
  })

  test("a per-model disabled status is excluded", () => {
    const state = computeModelEnableState({
      provider: { opencode: { models: { "claude-haiku-4-5": { status: "disabled" } } } },
    })
    expect(isModelEnabled("opencode/claude-haiku-4-5", state)).toBe(false)
    expect(isModelEnabled("opencode/other-model", state)).toBe(true)
  })

  test("filterEnabledModelKeys drops disabled models and keeps enabled ones", () => {
    const state = computeModelEnableState({
      disabled_providers: ["gemini"],
      provider: { opencode: { blacklist: ["claude-haiku-4-5"] } },
    })
    const filtered = filterEnabledModelKeys(
      new Set(["opencode/claude-haiku-4-5", "opencode/qwen3.5-plus", "gemini/gemini-3"]),
      state,
    )
    expect(filtered).toEqual(new Set(["opencode/qwen3.5-plus"]))
  })

  test("empty config enables everything", () => {
    const state = computeModelEnableState(undefined)
    expect(isModelEnabled("anything/at-all", state)).toBe(true)
  })
})
