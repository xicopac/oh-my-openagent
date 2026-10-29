import type { ParentContext } from "./executor-types"
import type { DelegateTaskArgs, DelegateTaskToolOptions, DelegatedModelConfig } from "./types"
import { getEnabledModelState, getModelsWithPricingAndMetadataForDelegateTask } from "./available-models"
import { filterEnabledModelKeys } from "../../shared/model-enable-state"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { getAgentRoleRequirement, getCategoryRoleRequirement } from "../../shared/model-requirements"
import { parseModelString } from "../../shared/model-string-parser"
import { log } from "../../shared/logger"
import { reselectFreeWorker, type ModelCapabilityInfo, type WorkerCapabilityRequirement } from "../../features/delegation-first"
import { resolvedModelKey } from "../../hooks/resource-governor"
import type { PricingCatalog } from "../../hooks/resource-governor/pricing"
import { hasExplicitDispatchModelPin } from "./explicit-model-pin"

export type FreeFirstDispatchSelection = {
  categoryModel: DelegatedModelConfig | undefined
  modelID: string | null
  reselected: boolean
  freeCandidatesExhausted: boolean
}

function requiredCapability(input: {
  args: DelegateTaskArgs
  agentToUse: string
}): WorkerCapabilityRequirement | undefined {
  if (input.args.category) {
    return getCategoryRoleRequirement(input.args.category)?.required
  }
  return getAgentRoleRequirement(getAgentConfigKey(input.agentToUse))?.required
}

export async function reselectFreeFirstModel(input: {
  options: DelegateTaskToolOptions
  args: DelegateTaskArgs
  agentToUse: string
  categoryModel: DelegatedModelConfig | undefined
  parentModel: ParentContext["model"] | undefined
  modelInfoSource: string | undefined
}): Promise<FreeFirstDispatchSelection> {
  const resolvedModelID = input.categoryModel?.modelID
    ? resolvedModelKey(input.categoryModel.providerID, input.categoryModel.modelID)
    : null

  const explicitPin = hasExplicitDispatchModelPin({
    args: input.args,
    agentToUse: input.agentToUse,
    categories: input.options.userCategories,
    agentOverrides: input.options.agentOverrides,
    sisyphusJuniorModel: input.options.sisyphusJuniorModel,
    modelInfoSource: input.modelInfoSource,
  })
  if (explicitPin) {
    log("[delegate-task] free-first dispatch skipped: explicit pin", {
      resolvedModelID,
      agent: input.agentToUse,
      modelInfoSource: input.modelInfoSource,
      sisyphusJuniorModel: input.options.sisyphusJuniorModel ?? null,
    })
    return {
      categoryModel: input.categoryModel,
      modelID: resolvedModelID,
      reselected: false,
      freeCandidatesExhausted: false,
    }
  }

  let available = new Set<string>()
  let pricing: PricingCatalog | undefined = input.options.pricingCatalog
  let modelInfo = new Map<string, ModelCapabilityInfo>()
  if (input.options.availableModelsOverride) {
    available = input.options.availableModelsOverride
  } else {
    try {
      const live = await getModelsWithPricingAndMetadataForDelegateTask(input.options.client)
      available = live.models
      modelInfo = live.modelInfo
      pricing = input.options.pricingCatalog ? { ...input.options.pricingCatalog, ...live.pricing } : live.pricing
    } catch {
      available = new Set()
    }
  }

  const enableState = await getEnabledModelState(input.options.client)
  const unavailable = new Set(input.options.delegationFirstRuntime?.unavailableModels() ?? [])
  for (const modelKey of enableState.disabledModels) unavailable.add(modelKey)

  const mainModel = input.parentModel?.modelID
    ? resolvedModelKey(input.parentModel.providerID, input.parentModel.modelID)
    : undefined
  const required = requiredCapability({ args: input.args, agentToUse: input.agentToUse })

  const selection = reselectFreeWorker({
    ...(pricing === undefined ? {} : { pricing }),
    available: filterEnabledModelKeys(available, enableState),
    resolvedModelID,
    unavailable,
    modelInfo,
    ...(mainModel === undefined ? {} : { mainModel }),
    ...(required === undefined ? {} : { required }),
  })

  if (!selection.reselected || !selection.modelID) {
    log("[delegate-task] free-first dispatch kept resolved model", {
      resolvedModelID,
      available: available.size,
      freeCandidatesExhausted: selection.freeCandidatesExhausted,
      agent: input.agentToUse,
    })
    return {
      categoryModel: input.categoryModel,
      modelID: resolvedModelID,
      reselected: false,
      freeCandidatesExhausted: selection.freeCandidatesExhausted,
    }
  }

  const parsed = parseModelString(selection.modelID)
  if (!parsed) {
    log("[delegate-task] free-first re-selection produced an invalid model id; keeping resolved model", {
      from: resolvedModelID,
      to: selection.modelID,
    })
    return {
      categoryModel: input.categoryModel,
      modelID: resolvedModelID,
      reselected: false,
      freeCandidatesExhausted: selection.freeCandidatesExhausted,
    }
  }

  log("[delegate-task] free-first dispatch re-selection", {
    from: resolvedModelID,
    to: selection.modelID,
    agent: input.agentToUse,
    description: input.args.description,
  })

  return {
    categoryModel: parsed,
    modelID: selection.modelID,
    reselected: true,
    freeCandidatesExhausted: selection.freeCandidatesExhausted,
  }
}
