import { describe, test, expect } from "bun:test"
import {
  AGENT_ROLE_REQUIREMENTS,
  CATEGORY_ROLE_REQUIREMENTS,
  getAgentRoleRequirement,
  getCategoryRoleRequirement,
} from "./role-requirements"

const MODEL_TIERS = ["fast", "balanced", "strong", "master"] as const

describe("role requirements - role metadata not concrete models", () => {
  test("every built-in named agent defines a role requirement with a valid tier", () => {
    const agents = [
      "sisyphus",
      "hephaestus",
      "oracle",
      "librarian",
      "explore",
      "multimodal-looker",
      "prometheus",
      "metis",
      "momus",
      "atlas",
      "sisyphus-junior",
    ]
    for (const name of agents) {
      const req = getAgentRoleRequirement(name)
      expect(req).toBeDefined()
      expect(MODEL_TIERS).toContain(req!.defaultTier)
    }
  })

  test("every built-in category defines a role requirement with a valid tier", () => {
    const categories = [
      "visual-engineering",
      "ultrabrain",
      "deep",
      "artistry",
      "quick",
      "unspecified-low",
      "unspecified-high",
      "writing",
    ]
    for (const name of categories) {
      const req = getCategoryRoleRequirement(name)
      expect(req).toBeDefined()
      expect(MODEL_TIERS).toContain(req!.defaultTier)
    }
  })

  test("explore and librarian prefer the free/fast economic band", () => {
    expect(getAgentRoleRequirement("explore")?.defaultTier).toBe("fast")
    expect(getAgentRoleRequirement("librarian")?.defaultTier).toBe("fast")
  })

  test("role requirements carry no concrete provider/model ids", () => {
    const serialized = JSON.stringify({ ...AGENT_ROLE_REQUIREMENTS, ...CATEGORY_ROLE_REQUIREMENTS })
    for (const forbidden of ["openai/", "anthropic/", "gpt-", "claude-", "gemini-", "kimi-", "minimax"]) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
