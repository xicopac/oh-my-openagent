import { describe, expect, test } from "bun:test"
import { AGENT_MODEL_REQUIREMENTS } from "./agent-model-requirements"
import { CATEGORY_MODEL_REQUIREMENTS } from "./category-model-requirements"
import { resolveModelPipeline } from "./model-resolution-pipeline"

/**
 * Focused routing-default tests for the DeepSeek model family.
 *
 * Contract under test:
 *  - Plain "DeepSeek V4 Flash" (`deepseek-v4-flash`) is the active DeepSeek
 *    model in the strongest/high-capability DeepSeek routing slot and in the
 *    fast utility slots (`explore`, `librarian`, `quick`).
 *  - "DeepSeek V4 Flash Vision Exp" (`deepseek-v4-flash-vision-exp`) is never
 *    selected as a normal default.
 *  - No active category/agent routing prefers "DeepSeek V4 Pro"
 *    (`deepseek-v4-pro`) over plain Flash.
 *  - Other providers' strongest entries remain unchanged.
 */
describe("DeepSeek V4 Flash default routing", () => {
  const deepseekEntries = (
    chain: readonly { providers: string[]; model: string; variant?: string }[],
  ) => chain.filter((entry) => entry.model.startsWith("deepseek-v4"))

  test("unspecified-low (strongest/high-capability DeepSeek slot) uses plain V4 Flash", () => {
    // given
    const chain = CATEGORY_MODEL_REQUIREMENTS["unspecified-low"].fallbackChain

    // when
    const deepseek = deepseekEntries(chain)

    // then - exactly one DeepSeek entry, plain flash, max variant
    expect(deepseek).toEqual([
      { providers: ["deepseek", "opencode-go"], model: "deepseek-v4-flash", variant: "max" },
    ])
  })

  test("explore and librarian agent chains default to plain V4 Flash after Luna", () => {
    // given
    for (const agentName of ["explore", "librarian"] as const) {
      const chain = AGENT_MODEL_REQUIREMENTS[agentName].fallbackChain

      // when
      const deepseek = deepseekEntries(chain)

      // then - plain flash is the DeepSeek fallback rung
      expect(deepseek).toContainEqual({
        providers: ["deepseek"],
        model: "deepseek-v4-flash",
        variant: "max",
      })
      expect(deepseek.some((entry) => entry.model === "deepseek-v4-pro")).toBe(false)
    }
  })

  test("quick category keeps non-reasoning plain V4 Flash (variant off)", () => {
    // given
    const chain = CATEGORY_MODEL_REQUIREMENTS["quick"].fallbackChain

    // when
    const deepseek = deepseekEntries(chain)

    // then
    expect(deepseek).toEqual([
      { providers: ["deepseek"], model: "deepseek-v4-flash", variant: "off" },
    ])
  })

  test("Vision Exp is NOT selected as any normal default", () => {
    // given
    const allChains = [
      ...Object.values(AGENT_MODEL_REQUIREMENTS).map((r) => r.fallbackChain),
      ...Object.values(CATEGORY_MODEL_REQUIREMENTS).map((r) => r.fallbackChain),
    ].flat()

    // when
    const visionExp = allChains.filter((entry) =>
      entry.model.includes("vision-exp") || entry.model.includes("vision_exp"))

    // then
    expect(visionExp).toEqual([])
  })

  test("no active category/agent routing prefers DeepSeek V4 Pro over plain Flash", () => {
    // given
    const allChains = [
      ...Object.values(AGENT_MODEL_REQUIREMENTS).map((r) => r.fallbackChain),
      ...Object.values(CATEGORY_MODEL_REQUIREMENTS).map((r) => r.fallbackChain),
    ].flat()

    // when
    const pro = allChains.filter((entry) => entry.model === "deepseek-v4-pro")

    // then
    expect(pro).toEqual([])
  })

  test("other providers' strongest entries in unspecified-low remain unchanged", () => {
    // given
    const chain = CATEGORY_MODEL_REQUIREMENTS["unspecified-low"].fallbackChain

    // then - every non-DeepSeek rung stays exactly as approved
    expect(chain.filter((entry) => !entry.model.startsWith("deepseek"))).toEqual([
      {
        providers: ["xai", "github-copilot", "opencode"],
        model: "grok-4.6",
        variant: "xhigh",
      },
      {
        providers: ["openai", "openai-codex", "github-copilot", "opencode"],
        model: "gpt-5.6-terra",
        variant: "high",
      },
      {
        providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"],
        model: "claude-sonnet-5",
        variant: "low",
      },
      {
        providers: ["qwen-token-plan", "alibaba-token-plan", "qwen-token-plan-cn", "alibaba-token-plan-cn"],
        model: "qwen3.8-max-preview",
        variant: "max",
      },
      {
        providers: ["xiaomi", "opencode-go"],
        model: "mimo-v2.5-pro",
        variant: "max",
      },
    ])
  })

  test("a fresh Sisyphus-style primary resolves to plain V4 Flash via the system default", () => {
    // given - fresh process, no UI selection, no user override, runtime default is Flash
    const result = resolveModelPipeline({
      intent: {},
      constraints: { availableModels: new Set(["opencode/deepseek-v4-flash", "opencode/gpt-5.4"]) },
      policy: {
        fallbackChain: AGENT_MODEL_REQUIREMENTS["sisyphus"].fallbackChain,
        systemDefaultModel: "opencode/deepseek-v4-flash",
      },
    })

    // then - the configured default resolves to plain Flash (not Pro, not Vision Exp)
    expect(result?.model).toBe("opencode/deepseek-v4-flash")
    expect(result?.provenance).toBe("system-default")
  })
})