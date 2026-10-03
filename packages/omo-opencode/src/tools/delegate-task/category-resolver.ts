import type { ModelFallbackInfo } from "../../features/task-toast-manager/types"
import type { DelegateTaskArgs } from "./types"
import type { ExecutorContext } from "./executor-types"
import type { FallbackEntry } from "../../shared/model-requirements"
import { mergeCategories } from "../../shared/merge-categories"
import { SISYPHUS_JUNIOR_AGENT } from "./sisyphus-junior-agent"
import { resolveCategoryConfig } from "./categories"
import { builtinCategoryGateModels, CATEGORY_PROMPT_APPEND_RESOLVERS } from "./constants"
import { parseModelString } from "../../shared/model-string-parser"
import { CATEGORY_MODEL_REQUIREMENTS, getCategoryRoleRequirement } from "../../shared/model-requirements"
import { normalizeFallbackModels, flattenToFallbackModelStrings } from "../../shared/model-resolver"
import { buildFallbackChainFromModels, findMostSpecificFallbackEntry } from "../../shared/fallback-chain-from-models"
import {
  getAvailableModelsForDelegateTask,
  getEnabledModelState,
  getModelsWithPricingAndMetadataForDelegateTask,
} from "./available-models"
import { filterEnabledModelKeys, isModelEnabled } from "../../shared/model-enable-state"
import { resolveModelForDelegateTask } from "./model-selection"
import { resolveDynamicWorkerModel, buildModelRoutingPins } from "./dynamic-model-resolver"
import { classifyPaidStatus } from "./paid-consent"
import type { PricingCatalog } from "../../hooks/resource-governor/pricing"
import { log } from "../../shared/logger"
import type { ModelTier } from "@oh-my-opencode/delegate-core"
import type { DelegatedModelConfig } from "./types"
import { applyCategoryParams } from "./delegated-model-config"
import { applyFallbackEntrySettings } from "./fallback-entry-settings"

function getConfiguredModel(entry: string | { model: string } | undefined): string | undefined {
  return typeof entry === "string" ? entry : entry?.model
}

function resolveCategoryPromptAppendForModel(
  categoryName: string,
  actualModel: string | undefined,
  staticPromptAppend: string,
  userPromptAppend: string | undefined,
): string | undefined {
  const dynamicResolver = CATEGORY_PROMPT_APPEND_RESOLVERS[categoryName]
  if (!dynamicResolver) {
    return staticPromptAppend || undefined
  }
  const dynamicBase = dynamicResolver(actualModel)
  if (!userPromptAppend) {
    return dynamicBase || undefined
  }
  return dynamicBase ? `${dynamicBase}\n\n${userPromptAppend}` : userPromptAppend
}

export interface CategoryResolutionResult {
  agentToUse: string
  categoryModel: DelegatedModelConfig | undefined
  categoryPromptAppend: string | undefined
  maxPromptTokens?: number
  modelInfo: ModelFallbackInfo | undefined
  actualModel: string | undefined
  isUnstableAgent: boolean
  fallbackChain?: FallbackEntry[]  // For runtime retry on model errors
  error?: string
}

function categoryResolutionError(error: string): CategoryResolutionResult {
  return {
    agentToUse: "",
    categoryModel: undefined,
    categoryPromptAppend: undefined,
    maxPromptTokens: undefined,
    modelInfo: undefined,
    actualModel: undefined,
    isUnstableAgent: false,
    error,
  }
}

export async function resolveCategoryExecution(
  args: DelegateTaskArgs,
  executorCtx: ExecutorContext,
  inheritedModel: string | undefined,
  systemDefaultModel: string | undefined
): Promise<CategoryResolutionResult> {
  const { client, userCategories, sisyphusJuniorModel } = executorCtx

  const categoryName = args.category!
  const enabledCategories = mergeCategories(userCategories)
  const categoryExists = enabledCategories[categoryName] !== undefined

  if (!categoryExists) {
    const allCategoryNames = Object.keys(enabledCategories).join(", ")
    return categoryResolutionError(`Unknown category: "${categoryName}". Available: ${allCategoryNames}`)
  }

  const availableModels = await getAvailableModelsForDelegateTask(client)
  const enableState = await getEnabledModelState(client)
  const enabledAvailableModels = filterEnabledModelKeys(availableModels, enableState)

  const resolved = resolveCategoryConfig(categoryName, {
    userCategories,
    inheritedModel,
    systemDefaultModel,
    availableModels,
  })

  if (!resolved) {
    const requirement = CATEGORY_MODEL_REQUIREMENTS[categoryName]
    const requiredModels = builtinCategoryGateModels(categoryName, requirement?.requiresModel)
    const requiredModel = requiredModels.length > 0 ? requiredModels.join('" or "') : undefined
    const allCategoryNames = Object.keys(enabledCategories).join(", ")
    const configuredModels = userCategories?.[categoryName]?.models

    if (configuredModels && availableModels.size > 0) {
      const configuredChain = configuredModels.map((entry) => getConfiguredModel(entry)).join(" -> ")
      return categoryResolutionError(`Configured model chain is unavailable for category "${categoryName}": ${configuredChain}`)
    }

    if (categoryExists && requiredModel) {
      return categoryResolutionError(`Category "${categoryName}" requires model "${requiredModel}" which is not available.

To use this category:
1. Connect a provider with this model: ${requiredModel}
2. Or configure an alternative model in your .omo/omo.jsonc for this category

Available categories: ${allCategoryNames}`)
    }

    return categoryResolutionError(`Unknown category: "${categoryName}". Available: ${allCategoryNames}`)
  }

  const requirement = CATEGORY_MODEL_REQUIREMENTS[args.category!]
  const hasCanonicalModels = resolved.config.models !== undefined
  const canonicalPrimaryEntry = resolved.config.models?.[0]
  const configuredPrimaryModel = getConfiguredModel(canonicalPrimaryEntry)
  const categoryResolvedModel = hasCanonicalModels ? configuredPrimaryModel : resolved.model
  const normalizedConfiguredFallbackModels = normalizeFallbackModels(
    hasCanonicalModels ? resolved.config.models?.slice(1) : resolved.config.fallback_models,
  )
  let actualModel: string | undefined
  let modelInfo: ModelFallbackInfo | undefined
  let categoryModel: DelegatedModelConfig | undefined
  let isModelResolutionSkipped = false
  let fallbackEntry: FallbackEntry | undefined
  let matchedFallback = false

  const overrideModel = sisyphusJuniorModel
  const explicitCategoryModel = hasCanonicalModels
    ? configuredPrimaryModel
    : userCategories?.[args.category!]?.model
  // True when the dynamic free-only resolver found no eligible free candidate.
  // In that case the static fallback may still run, but only a provably free
  // result is allowed; a paid/unknown result becomes an explicit failure.
  let dynamicFreePoolExhausted = false
  let dynamicLivePoolEmpty = false

  if (!requirement) {
    // Precedence: explicit category model > sisyphus-junior default > category resolved model
    // This keeps `sisyphus-junior.model` useful as a global default while allowing
    // per-category overrides via `categories[category].model`.
    actualModel = explicitCategoryModel ?? overrideModel ?? categoryResolvedModel
    if (actualModel) {
      modelInfo = explicitCategoryModel || overrideModel
        ? { model: actualModel, type: "user-defined", source: "override" }
        : { model: actualModel, type: "system-default", source: "system-default" }
      const parsedModel = parseModelString(actualModel)
      const variantToUse = userCategories?.[args.category!]?.variant ?? resolved.config.variant
      categoryModel = parsedModel
        ? applyCategoryParams({ ...parsedModel, variant: variantToUse ?? parsedModel.variant }, resolved.config)
        : undefined
    }
  } else {
    const hasUserFallbackModels = Boolean(normalizedConfiguredFallbackModels && normalizedConfiguredFallbackModels.length > 0)
    const hasExplicitUserSource = Boolean(explicitCategoryModel ?? overrideModel ?? hasUserFallbackModels)
    let dynamicCategoryModel: string | undefined
    const roleRequirement = getCategoryRoleRequirement(args.category!)
    if (!hasExplicitUserSource && roleRequirement) {
      const dynamic = await resolveDynamicWorkerModel({
        client,
        tier: roleRequirement.defaultTier as ModelTier,
        required: roleRequirement.required,
        mainModel: inheritedModel,
        pinned: buildModelRoutingPins(executorCtx.modelRouting),
        ...(executorCtx.availableModelsOverride ? { availableModelsOverride: executorCtx.availableModelsOverride } : {}),
        ...(executorCtx.pricingCatalog ? { pricingCatalog: executorCtx.pricingCatalog } : {}),
        ...(executorCtx.delegationFirstRuntime
          ? { extraUnavailable: executorCtx.delegationFirstRuntime.unavailableModels() }
          : {}),
        // ORDINARY CATEGORY CHILD POLICY (free-only): categories spawn ordinary
        // children and are FREE-ONLY. Root/master parent authority must NOT
        // mutate them into paid children. Paid execution requires a separate
        // explicit MASTER paid-worker request plus fresh operator consent,
        // enforced at launch by gatePaidChildLaunch / enforcePaidWorkerLaunch.
        allowPaidWorkers: false,
      })
      if (dynamic.kind === "resolved") {
        // A main_equiv escalation (usedMainModel) means the live pool held no candidate suitable
        // for the category's tier, so the band resolver fell back to the parent session model.
        // Categories carry explicit defaults and must not inherit the parent model, so skip the
        // escalation and let the category-default resolution below win.
        if (!dynamic.usedMainModel) {
          dynamicCategoryModel = dynamic.model
        }
      } else if (dynamic.kind === "no-eligible-candidate") {
        // ORDINARY CATEGORY CHILD POLICY (free-only): the dynamic free pool is
        // exhausted.
        dynamicFreePoolExhausted = true
        dynamicLivePoolEmpty = dynamic.livePoolEmpty
        if (!dynamic.livePoolEmpty) {
          // A warm catalog with no free candidate is a hard, actionable
          // failure. Never fall through to the static (typically paid) category
          // default, and never let the master take the work over.
          return categoryResolutionError(
            `FREE_WORKER_POOL_EXHAUSTED: no enabled free model satisfies role requirements for category "${args.category!}" ` +
            `(tier "${roleRequirement.defaultTier}"). Ordinary children are free-only; connect a free provider or add an ` +
            `explicit free model pin, then retry. The master must not take over the implementation and must not fall back to ` +
            `a paid child.`,
          )
        }
      }
    }

    if (!hasExplicitUserSource && dynamicCategoryModel) {
      actualModel = dynamicCategoryModel
      const parsedModel = parseModelString(actualModel)
      const variantToUse = userCategories?.[args.category!]?.variant ?? resolved.config.variant
      categoryModel = parsedModel
        ? applyCategoryParams({ ...parsedModel, variant: variantToUse ?? parsedModel.variant }, resolved.config)
        : undefined
      modelInfo = { model: actualModel, type: "category-default", source: "category-default" }
    } else {
      const resolution = resolveModelForDelegateTask({
        userModel: explicitCategoryModel ?? overrideModel,
        userFallbackModels: flattenToFallbackModelStrings(normalizedConfiguredFallbackModels),
        categoryDefaultModel: categoryResolvedModel,
        isUserConfiguredCategoryModel: hasCanonicalModels
          ? configuredPrimaryModel !== undefined
          : resolved.isUserConfiguredModel,
        fallbackChain: undefined,
        availableModels: enabledAvailableModels,
        systemDefaultModel,
      })

      if (resolution && "skipped" in resolution) {
        isModelResolutionSkipped = true
        const userModelOverride = explicitCategoryModel ?? overrideModel
        if (userModelOverride) {
          actualModel = userModelOverride
          const parsedModel = parseModelString(userModelOverride)
          const variantToUse = userCategories?.[args.category!]?.variant ?? resolved.config.variant
          categoryModel = parsedModel
            ? applyCategoryParams({ ...parsedModel, variant: variantToUse ?? parsedModel.variant }, resolved.config)
            : undefined
          modelInfo = { model: userModelOverride, type: "user-defined", source: "override" }
        }
      } else if (resolution) {
        const {
          model: resolvedModel,
          variant: resolvedVariant,
          fallbackEntry: resolvedFallbackEntry,
          matchedFallback: resolvedMatchedFallback,
        } = resolution
        fallbackEntry = resolvedFallbackEntry
        matchedFallback = resolvedMatchedFallback === true
        actualModel = resolvedModel

        if (!parseModelString(actualModel)) {
          return categoryResolutionError(`Invalid model format "${actualModel}". Expected "provider/model" format (e.g., "anthropic/claude-sonnet-4-6").`)
        }

        const type: "user-defined" | "inherited" | "category-default" | "system-default" =
          (explicitCategoryModel || overrideModel)
            ? "user-defined"
            : (systemDefaultModel && actualModel === systemDefaultModel)
                ? "system-default"
                : "category-default"

        const source: "override" | "category-default" | "system-default" =
          type === "user-defined"
            ? "override"
            : type === "system-default"
                ? "system-default"
                : "category-default"

        modelInfo = { model: actualModel, type, source }

        const parsedModel = parseModelString(actualModel)
        const variantToUse = userCategories?.[args.category!]?.variant ?? resolvedVariant ?? resolved.config.variant
        categoryModel = parsedModel
          ? applyCategoryParams({ ...parsedModel, variant: variantToUse ?? parsedModel.variant }, resolved.config)
          : undefined
      }
    }
  }

  if (!categoryModel && actualModel) {
    const parsedModel = parseModelString(actualModel)
    categoryModel = parsedModel ?? undefined
  }

  // ORDINARY CATEGORY CHILD POLICY (free-only): when the dynamic free pool was
  // exhausted, the static fallback is only acceptable if it resolves to a
  // provably $0 model. This preserves free static defaults (e.g. a free
  // category model) while refusing the paid DeepSeek static default that used
  // to slip through as an automatic paid child.
  if (dynamicFreePoolExhausted) {
    const resolvedKey = categoryModel
      ? `${categoryModel.providerID}/${categoryModel.modelID}`
      : undefined
    const live = await getModelsWithPricingAndMetadataForDelegateTask(client)
    const effectivePricing: PricingCatalog = executorCtx.pricingCatalog
      ? { ...executorCtx.pricingCatalog, ...live.pricing }
      : live.pricing
    const status = resolvedKey ? classifyPaidStatus(resolvedKey, effectivePricing) : "unknown"
    // Cold-cache grace: when the live catalog is completely empty there is no
    // pricing evidence at all, so an unknown-priced static default is allowed
    // (the provider cache is warmed during startup and the next attempt
    // resolves through the free-only dynamic pool). A known-paid default is
    // NEVER allowed, and an unknown default is not allowed once the catalog is
    // warm (fail closed).
    const coldCacheGrace = dynamicLivePoolEmpty && status === "unknown" && resolvedKey !== undefined
    if (status !== "free" && !coldCacheGrace) {
      const reason = resolvedKey
        ? `the only static fallback "${resolvedKey}" is not provably free (${status})`
        : "no free candidate could be resolved from the live catalog"
      return categoryResolutionError(
        `FREE_WORKER_POOL_EXHAUSTED: ${reason}. ` +
        `Ordinary children are free-only; connect a free provider or add an explicit free model pin, then retry. ` +
        `The master must not take over the implementation and must not fall back to a paid child.`,
      )
    }
    if (coldCacheGrace) {
      log("[delegate-task] free-pool cold cache: using static category default until the catalog warms", {
        category: args.category,
        model: resolvedKey,
      })
    }
  }

  const categoryPromptAppend = resolveCategoryPromptAppendForModel(
    args.category!,
    actualModel,
    resolved.promptAppend,
    userCategories?.[args.category!]?.prompt_append,
  )

  if (!categoryModel && !actualModel && !isModelResolutionSkipped) {
    const categoryNames = Object.keys(enabledCategories)
    return categoryResolutionError(`Model not configured for category "${args.category}".

Configure in one of:
1. OpenCode: Set "model" in opencode.json
2. Oh-My-OpenCode: Set category model in .omo/omo.jsonc
3. Provider: Connect a provider with available models

Current category: ${args.category}
Available categories: ${categoryNames.join(", ")}`)
  }

  const resolvedModel = actualModel?.toLowerCase()
  const isUnstableAgent = resolved.config.is_unstable_agent ?? (resolvedModel ? resolvedModel.includes("gemini") || resolvedModel.includes("minimax") : false)

  const defaultProviderID = categoryModel?.providerID
    ?? parseModelString(actualModel ?? "")?.providerID
    ?? "opencode"
  const configuredFallbackChain = buildFallbackChainFromModels(
    normalizedConfiguredFallbackModels,
    defaultProviderID,
  )
  const canonicalModelChain = hasCanonicalModels
    ? buildFallbackChainFromModels(resolved.config.models, defaultProviderID)
    : undefined

  // Canonical model entries carry settings for both the primary and fallback rungs.
  // Legacy fallback-only settings are promoted only when resolution selected a fallback.
  const effectiveEntry = categoryModel
    ? hasCanonicalModels
      ? (canonicalModelChain
          ? findMostSpecificFallbackEntry(categoryModel.providerID, categoryModel.modelID, canonicalModelChain)
          : undefined)
      : matchedFallback
        ? (
            fallbackEntry
            ?? (configuredFallbackChain
              ? findMostSpecificFallbackEntry(categoryModel.providerID, categoryModel.modelID, configuredFallbackChain)
              : undefined)
          )
        : undefined
    : undefined

  if (categoryModel && effectiveEntry) {
    categoryModel = applyFallbackEntrySettings({
      categoryModel,
      effectiveEntry,
      variantOverride: userCategories?.[args.category!]?.variant,
    })
  }

  if (categoryModel) {
    const key = `${categoryModel.providerID}/${categoryModel.modelID}`
    if (!isModelEnabled(key, enableState)) {
      return categoryResolutionError(`Resolved model "${key}" for category "${args.category!}" uses a disabled provider or model.`)
    }
  }

  return {
    agentToUse: SISYPHUS_JUNIOR_AGENT,
    categoryModel,
    categoryPromptAppend,
    maxPromptTokens: resolved.config.max_prompt_tokens,
    modelInfo,
    actualModel,
    isUnstableAgent,
    // Don't use a hardcoded fallback chain when resolution was skipped or explicit
    fallbackChain: configuredFallbackChain ?? undefined,
  }
}
