import type { AgentOverrides } from "../../config/schema"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { fuzzyMatchModel } from "../../shared/model-availability"
import { buildFallbackChainFromModels } from "../../shared/fallback-chain-from-models"
import { normalizeModelFormat } from "../../shared/model-format-normalizer"
import { flattenToFallbackModelStrings, normalizeFallbackModels } from "../../shared/model-resolver"
import { getAgentRoleRequirement } from "../../shared/model-requirements"
import type { ModelTier } from "@oh-my-opencode/delegate-core"
import { log } from "../../shared/logger"
import { getAvailableModelsForDelegateTask, getEnabledModelState } from "./available-models"
import { PAID_ESCALATION_REQUIRED } from "./paid-consent"
import { filterEnabledModelKeys, isModelEnabled } from "../../shared/model-enable-state"
import { applyCategoryParams } from "./delegated-model-config"
import { applyFallbackEntrySettings } from "./fallback-entry-settings"
import { resolveEffectiveFallbackEntry } from "./fallback-entry-resolution"
import { resolveModelForDelegateTask } from "./model-selection"
import { resolveDynamicWorkerModel, buildModelRoutingPins } from "./dynamic-model-resolver"
import type { ExecutorContext } from "./executor-types"
import type { AgentInfo } from "./subagent-discovery"
import type { ResolvedSubagentModel } from "./subagent-resolution-types"

function findAgentOverride(agentOverrides: AgentOverrides | undefined, agentConfigKey: string) {
  return agentOverrides?.[agentConfigKey]
    ?? Object.entries(agentOverrides ?? {}).find(([key]) => key.toLowerCase() === agentConfigKey)?.[1]
}

export async function resolveSubagentModel(
  agentToUse: string,
  matchedAgent: AgentInfo,
  executorCtx: ExecutorContext,
  options: { mainModel?: string } = {},
): Promise<ResolvedSubagentModel> {
  let categoryModel = undefined
  let fallbackChain = undefined

  const agentConfigKey = getAgentConfigKey(agentToUse)
  const agentOverride = findAgentOverride(executorCtx.agentOverrides, agentConfigKey)
  const roleRequirement = getAgentRoleRequirement(agentConfigKey)
  const agentCategoryConfig = agentOverride?.category
    ? executorCtx.userCategories?.[agentOverride.category]
    : undefined
  const agentCategoryModel = agentCategoryConfig?.model
  const hasExplicitUserModel = Boolean(agentOverride?.model ?? agentCategoryModel)
  const normalizedAgentFallbackModels = normalizeFallbackModels(
    agentOverride?.fallback_models
    ?? agentCategoryConfig?.fallback_models
  )
  const hasUserFallbackModels = Boolean(normalizedAgentFallbackModels && normalizedAgentFallbackModels.length > 0)

  const availableModels = await getAvailableModelsForDelegateTask(executorCtx.client)
  const enableState = await getEnabledModelState(executorCtx.client)
  const enabledAvailableModels = filterEnabledModelKeys(availableModels, enableState)

  const normalizedMatchedModel = matchedAgent.model
    ? normalizeModelFormat(matchedAgent.model)
    : undefined
  const matchedAgentModelStr = normalizedMatchedModel
    ? `${normalizedMatchedModel.providerID}/${normalizedMatchedModel.modelID}`
    : undefined

  let dynamicDefaultModel: string | undefined
  // Role-requirement agents are free-first: whenever the user has not pinned an
  // explicit model or fallback list, the dynamic band resolver runs FIRST, even
  // when the agent's static configured model is usable. The static matched-agent
  // model is only a fallback for when the dynamic resolver cannot produce a
  // candidate (cold cache / empty live pool), handled below.
  if (roleRequirement && !hasExplicitUserModel && !hasUserFallbackModels) {
    const dynamic = await resolveDynamicWorkerModel({
      client: executorCtx.client,
      tier: roleRequirement.defaultTier as ModelTier,
      required: roleRequirement.required,
      mainModel: options.mainModel,
      pinned: buildModelRoutingPins(executorCtx.modelRouting),
      ...(executorCtx.availableModelsOverride ? { availableModelsOverride: executorCtx.availableModelsOverride } : {}),
      ...(executorCtx.pricingCatalog ? { pricingCatalog: executorCtx.pricingCatalog } : {}),
      ...(executorCtx.delegationFirstRuntime
        ? { extraUnavailable: executorCtx.delegationFirstRuntime.unavailableModels() }
        : {}),
      // ORDINARY CHILD POLICY (free-only): automatically spawned children are
      // FREE-ONLY. Root/master parent authority must NOT mutate an ordinary
      // child into a paid child. Paid execution requires a separate explicit
      // MASTER paid-worker request plus fresh operator consent, enforced at
      // launch by gatePaidChildLaunch / enforcePaidWorkerLaunch.
      allowPaidWorkers: false,
    })
    if (dynamic.kind === "resolved") {
      dynamicDefaultModel = dynamic.model
      log("[delegate-task] resolved subagent model dynamically", {
        agent: agentToUse,
        tier: roleRequirement.defaultTier,
        band: dynamic.band,
        model: dynamic.model,
        escalated: dynamic.escalated,
        usedMainModel: dynamic.usedMainModel,
      })
    } else if (dynamic.kind === "no-eligible-candidate" && !dynamic.livePoolEmpty) {
      throw new Error(
        `${PAID_ESCALATION_REQUIRED}: no eligible free model satisfies role requirements for agent "${agentToUse}" (tier "${roleRequirement.defaultTier}"). ` +
        `Free worker pool exhausted; report free_pool_exhausted to the master. The master may request a paid worker, which requires explicit operator approval.`,
      )
    }
  }

  if (agentOverride?.model || agentCategoryModel || roleRequirement || matchedAgent.model) {
    const resolution = resolveModelForDelegateTask({
      userModel: agentOverride?.model ?? agentCategoryModel ?? dynamicDefaultModel,
      userFallbackModels: flattenToFallbackModelStrings(normalizedAgentFallbackModels),
      categoryDefaultModel: matchedAgentModelStr,
      fallbackChain: undefined,
      availableModels: enabledAvailableModels,
      systemDefaultModel: undefined,
    })

    const resolutionSkipped = resolution && "skipped" in resolution

    if (resolution && !resolutionSkipped) {
      const normalized = normalizeModelFormat(resolution.model)
      if (normalized) {
        const variantToUse = agentOverride?.variant ?? resolution.variant ?? agentCategoryConfig?.variant
        const resolvedModel = variantToUse ? { ...normalized, variant: variantToUse } : normalized
        categoryModel = applyCategoryParams(resolvedModel, agentCategoryConfig)
      }
    } else if (resolutionSkipped && (agentOverride?.model ?? agentCategoryModel)) {
      const explicitModel = agentOverride?.model ?? agentCategoryModel
      const normalized = explicitModel ? normalizeModelFormat(explicitModel) : undefined
      if (normalized) {
        const variantToUse = agentOverride?.variant ?? agentCategoryConfig?.variant
        const resolvedModel = variantToUse ? { ...normalized, variant: variantToUse } : normalized
        categoryModel = applyCategoryParams(resolvedModel, agentCategoryConfig)
        log("[delegate-task] Cold cache: using explicit user override for subagent", {
          agent: agentToUse,
          model: agentOverride?.model ?? agentCategoryModel,
        })
      }
    }

    const defaultProviderID = categoryModel?.providerID
      ?? normalizedMatchedModel?.providerID
      ?? "opencode"
    const configuredFallbackChain = buildFallbackChainFromModels(
      normalizedAgentFallbackModels,
      defaultProviderID,
    )
    fallbackChain = configuredFallbackChain
    const effectiveEntry = resolveEffectiveFallbackEntry({
      categoryModel,
      configuredFallbackChain,
      resolution,
    })

    if (categoryModel && effectiveEntry) {
      categoryModel = applyFallbackEntrySettings({
        categoryModel,
        effectiveEntry,
        variantOverride: agentOverride?.variant,
      })
    }
  }

  if (!categoryModel && normalizedMatchedModel) {
    const fullModel = `${normalizedMatchedModel.providerID}/${normalizedMatchedModel.modelID}`
    if (enabledAvailableModels.size === 0 || fuzzyMatchModel(fullModel, enabledAvailableModels, [normalizedMatchedModel.providerID])) {
      categoryModel = normalizedMatchedModel
    } else {
      log("[delegate-task] Skipping unavailable agent default model", {
        agent: agentToUse,
        model: fullModel,
      })
    }
  }

  if (categoryModel) {
    const key = `${categoryModel.providerID}/${categoryModel.modelID}`
    if (!isModelEnabled(key, enableState)) {
      throw new Error(`Resolved model "${key}" for agent "${agentToUse}" uses a disabled provider or model.`)
    }
  }

  return { categoryModel, fallbackChain }
}
