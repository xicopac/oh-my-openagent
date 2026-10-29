import type { AgentOverrideConfig, AgentOverrides, CategoriesConfig } from "../../config/schema"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import type { DelegateTaskArgs } from "./types"

type ModelSelection = {
  model?: string
  models?: readonly unknown[]
  fallback_models?: unknown
}

function hasModelSelection(config: ModelSelection | undefined): boolean {
  if (!config) return false
  if (config.model) return true
  if ((config.models?.length ?? 0) > 0) return true
  const fallback = config.fallback_models
  if (typeof fallback === "string") return fallback.length > 0
  return Array.isArray(fallback) && fallback.length > 0
}

function categoryPinsModel(categories: CategoriesConfig | undefined, category: string | undefined): boolean {
  if (!category) return false
  return hasModelSelection(categories?.[category])
}

function findAgentOverride(
  agentOverrides: AgentOverrides | undefined,
  agentKey: string,
): AgentOverrideConfig | undefined {
  if (!agentOverrides) return undefined
  const entries = Object.entries(agentOverrides) as Array<[string, AgentOverrideConfig | undefined]>
  return entries.find(([key]) => key === agentKey)?.[1]
    ?? entries.find(([key]) => key.toLowerCase() === agentKey.toLowerCase())?.[1]
}

export function hasExplicitDispatchModelPin(input: {
  args: DelegateTaskArgs
  agentToUse: string
  categories: CategoriesConfig | undefined
  agentOverrides: AgentOverrides | undefined
  sisyphusJuniorModel: string | undefined
  modelInfoSource: string | undefined
}): boolean {
  if (input.args.model_tier !== undefined) return true
  if (input.modelInfoSource === "override") return true

  if (input.args.category) {
    if (input.sisyphusJuniorModel) return true
    return categoryPinsModel(input.categories, input.args.category)
  }

  const override = findAgentOverride(input.agentOverrides, getAgentConfigKey(input.agentToUse))
  if (!override) return false
  if (hasModelSelection(override)) return true
  return categoryPinsModel(input.categories, override.category)
}
