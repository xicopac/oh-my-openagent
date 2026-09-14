import { describe, expect, test } from "bun:test"
import { prepareDelegateTaskArgs } from "./tool-argument-preparation"
import type { ToolContextWithMetadata } from "./types"

function ctx(): ToolContextWithMetadata {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "sisyphus",
    abort: new AbortController().signal,
    metadata: () => undefined,
  }
}

describe("prepareDelegateTaskArgs model_tier", () => {
  for (const tier of ["fast", "balanced", "strong", "master"]) {
    test(`#given model_tier=${tier} #when args are prepared #then it is accepted and preserved`, async () => {
      // given
      const args = { prompt: "do the thing", subagent_type: "explore", model_tier: tier }

      // when
      const prepared = await prepareDelegateTaskArgs(args, ctx())

      // then
      expect(prepared.model_tier).toBe(tier)
    })
  }

  test("#given an invalid model_tier #when args are prepared #then it throws", async () => {
    // given
    const args = { prompt: "do the thing", subagent_type: "explore", model_tier: "turbo" }

    // when / then
    await expect(prepareDelegateTaskArgs(args, ctx())).rejects.toThrow(/model_tier must be one of/)
  })

  test("#given no model_tier #when args are prepared #then model_tier is undefined (backward compatible)", async () => {
    // given
    const args = { prompt: "do the thing", category: "quick" }

    // when
    const prepared = await prepareDelegateTaskArgs(args, ctx())

    // then
    expect(prepared.model_tier).toBeUndefined()
  })
})
