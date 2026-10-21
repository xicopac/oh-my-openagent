import { describe, expect, test } from "bun:test"
import { AGENT_MODEL_REQUIREMENTS } from "./agent-model-requirements"
import { CATEGORY_MODEL_REQUIREMENTS } from "./category-model-requirements"
import { resolveModelPipeline } from "./model-resolution-pipeline"

/**
 * Focused routing-default tests for the DeepSeek model family.
 *
 * Contract under test:
 *  - Plain DeepSeek Flash remains the active DeepSeek model in the
 *    strongest/high-capability DeepSeek routing slot (`unspecified-low`,
 *    trailing, pinned to `deepseek-v4-flash` max) and in the `quick`
 *    utility slot (`deepseek-flash` off - upstream's official API id for
 *    DeepSeek V4.1 Flash), and stays as a fallback rung for
 *    `explore`/`librarian` behind the cheap non-DeepSeek lead rungs.
 *  - Ordinary child workers (`explore`, `librarian`, `sisyphus-junior`) do NOT
 *    lead with Flash: `explore`/`librarian` lead with no-thinking Kimi
 *    HighSpeed then GPT-6 Luna low and `sisyphus-junior` leads with Claude
 *    Sonnet 5.
 *  - "DeepSeek V4 Flash Vision Exp" (`deepseek-v4-flash-vision-exp`) is never
 *    selected as a normal default.
 *  - No active category/agent routing prefers "DeepSeek V4 Pro"
 *    (`deepseek-v4-pro`) over plain Flash.
 *  - Other providers' strongest entries in `unspecified-low` follow the
 *    approved upstream lineup with the free-model pins trailing.
 */
describe("DeepSeek V4 Flash default routing", () => {
  const deepseekEntries = (
    chain: readonly { providers: string[]; model: string; variant?: string }[],
  ) => chain.filter((entry) => entry.model.startsWith("deepseek"))

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

  test("explore and librarian lead with no-thinking Kimi HighSpeed then Luna low, keeping Flash max as a trailing rung", () => {
    // given
    for (const agentName of ["explore", "librarian"] as const) {
      const chain = AGENT_MODEL_REQUIREMENTS[agentName].fallbackChain

      // when
      const deepseek = deepseekEntries(chain)

      // then - cheap non-DeepSeek rungs lead; Flash follows, never first
      expect(chain[0]).toEqual({
        providers: ["kimi-for-coding"],
        model: "kimi-for-coding-highspeed",
        variant: "off",
      })
      expect(chain[1]).toEqual({
        providers: ["openai", "chatgpt-subscription"],
        model: "gpt-6-luna-fast",
        variant: "low",
      })
      expect(chain[0].model).not.toBe("deepseek-v4-flash")
      expect(deepseek).toContainEqual({
        providers: ["deepseek"],
        model: "deepseek-flash",
        variant: "max",
      })
      expect(deepseek.some((entry) => entry.model === "deepseek-v4-pro")).toBe(false)
    }
  })

  test("sisyphus-junior leads with Claude Sonnet 5 and carries no DeepSeek rung at all", () => {
    // given
    const chain = AGENT_MODEL_REQUIREMENTS["sisyphus-junior"].fallbackChain

    // when
    const deepseek = deepseekEntries(chain)

    // then - sonnet first; no flash, no pro
    expect(chain[0]).toEqual({
      providers: ["anthropic", "github-copilot", "opencode"],
      model: "claude-sonnet-5",
    })
    expect(deepseek).toEqual([])
  })

  test("quick category keeps non-reasoning Flash (deepseek-flash, variant off)", () => {
    // given
    const chain = CATEGORY_MODEL_REQUIREMENTS["quick"].fallbackChain

    // when
    const deepseek = deepseekEntries(chain)

    // then - exactly one DeepSeek rung on the official V4.1 Flash id, reasoning off
    expect(deepseek).toEqual([
      { providers: ["deepseek"], model: "deepseek-flash", variant: "off" },
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

  test("other providers' strongest entries in unspecified-low follow the approved lineup with the Flash/mimo pins trailing", () => {
    // given
    const chain = CATEGORY_MODEL_REQUIREMENTS["unspecified-low"].fallbackChain

    // then - every non-DeepSeek rung stays exactly as approved
    expect(chain.filter((entry) => !entry.model.startsWith("deepseek"))).toEqual([
      {
        providers: ["anthropic", "anthropic-api", "github-copilot", "opencode"],
        model: "claude-sonnet-5-5",
        variant: "medium",
      },
      {
        providers: ["xiaomi", "opencode-go"],
        model: "mimo-v2.6-pro",
        variant: "max",
      },
      {
        providers: ["xai", "github-copilot", "opencode-go"],
        model: "grok-4.7",
        variant: "xhigh",
      },
      {
        providers: ["zai-coding-plan", "opencode-go"],
        model: "glm-5.3",
        variant: "high",
      },
      {
        providers: ["openai", "chatgpt-subscription"],
        model: "gpt-6.1-sol",
        variant: "medium",
      },
      {
        providers: ["openai", "chatgpt-subscription", "github-copilot", "opencode"],
        model: "gpt-5.6-sol",
        variant: "medium",
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
