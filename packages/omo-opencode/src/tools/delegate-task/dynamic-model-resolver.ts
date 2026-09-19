import {
  MODEL_TIERS,
  resolveModelBand,
  type ModelBand,
  type ModelBandCandidate,
  type ModelBandRequirement,
  type ModelTier,
} from "@oh-my-opencode/delegate-core"
import { filterEnabledModelKeys } from "../../shared/model-enable-state"
import { getModelsWithPricingAndMetadataForDelegateTask, getEnabledModelState } from "./available-models"
import { lookupPricing, type PricingCatalog } from "../../hooks/resource-governor"
import type { ModelCapabilityInfo } from "../../features/delegation-first"
import type { ModelRoutingConfig } from "../../config/schema"
import type { OpencodeClient } from "./types"

/**
 * Canonical dynamic worker-model resolver.
 *
 * This is the SINGLE authority for normal subagent/category model selection.
 * It maps role requirements onto the live enabled model pool:
 *
 *   role requirements
 *     -> live enabled model pool
 *     -> remove disabled/unavailable candidates
 *     -> capability filter
 *     -> economic/strength band (free -> cheap_paid -> strong_paid -> main_equiv)
 *     -> concrete provider/model
 *
 * It never consults the legacy `AGENT_MODEL_REQUIREMENTS` /
 * `CATEGORY_MODEL_REQUIREMENTS` concrete provider/model fallback chains, so a
 * disabled provider like `openai/*` or `anthropic/*` can never be resurrected.
 */

export type ResolveDynamicWorkerModelInput = {
  client: OpencodeClient
  /** Requested economic tier (fast/balanced/strong/master). */
  tier: ModelTier
  /** Capability/modality requirements applied before banding. */
  required?: ModelBandRequirement
  /** MAIN/parent concrete model in "provider/model" form. */
  mainModel?: string
  /** Per-tier explicit pins from model_routing.tiers.*.model. */
  pinned?: Partial<Record<ModelTier, string>>
  /** Test seam: override the live available-model set. */
  availableModelsOverride?: ReadonlySet<string>
  /** Static pricing catalog, merged with live pricing. */
  pricingCatalog?: PricingCatalog
  /** Additional unavailable model keys (runtime negative cache). */
  extraUnavailable?: Iterable<string>
  allowPaidWorkers?: boolean
}

export type DynamicWorkerResolution =
  | {
      kind: "resolved"
      model: string
      band: ModelBand
      requestedTier: ModelTier
      escalated: boolean
      usedMainModel: boolean
    }
  | { kind: "no-eligible-candidate"; livePoolEmpty: boolean }

/** Derive per-tier explicit model pins from `model_routing.tiers` config. */
export function buildModelRoutingPins(
  modelRouting: ModelRoutingConfig | undefined,
): Partial<Record<ModelTier, string>> {
  const pinned: Partial<Record<ModelTier, string>> = {}
  const tiers = modelRouting?.tiers
  if (!tiers) return pinned
  for (const t of MODEL_TIERS) {
    const entry = tiers[t]
    if (!entry) continue
    if (t === "master") {
      if (entry.inherit_parent === false && entry.model) pinned.master = entry.model
    } else if (entry.model) {
      pinned[t] = entry.model
    }
  }
  return pinned
}

export async function resolveDynamicWorkerModel(
  input: ResolveDynamicWorkerModelInput,
): Promise<DynamicWorkerResolution> {
  let available = new Set<string>()
  let pricing = input.pricingCatalog
  let candidateInfo = new Map<string, ModelCapabilityInfo>()
  if (input.availableModelsOverride) {
    available = new Set(input.availableModelsOverride)
  } else {
    const live = await getModelsWithPricingAndMetadataForDelegateTask(input.client)
    available = live.models
    candidateInfo = live.modelInfo
    pricing = input.pricingCatalog ? { ...input.pricingCatalog, ...live.pricing } : live.pricing
  }

  const enableState = await getEnabledModelState(input.client)
  const unavailable = new Set<string>(input.extraUnavailable ?? [])
  for (const modelKey of enableState.disabledModels) unavailable.add(modelKey)

  const enabled = filterEnabledModelKeys(available, enableState)
  for (const modelKey of available) {
    if (!enabled.has(modelKey)) unavailable.add(modelKey)
  }
  const mainPricing = input.mainModel && pricing ? lookupPricing(pricing, input.mainModel) : undefined

  const candidates: ModelBandCandidate[] = []
  for (const id of enabled) {
    if (unavailable.has(id)) continue
    const info = candidateInfo.get(id)
    candidates.push({
      model: id,
      pricing: pricing ? lookupPricing(pricing, id) : undefined,
      ...(info?.vision === undefined ? {} : { vision: info.vision }),
      ...(info?.tool_call === undefined ? {} : { tool_call: info.tool_call }),
      ...(info?.reasoning === undefined ? {} : { reasoning: info.reasoning }),
      ...(info?.context_limit === undefined ? {} : { context_limit: info.context_limit }),
    })
  }

  const resolved = resolveModelBand({
    requestedTier: input.tier,
    candidates,
    mainModel: input.mainModel,
    mainPricing,
    required: input.required,
    pinned: input.pinned,
    unavailable,
    allowPaidWorkers: input.allowPaidWorkers ?? false,
  })

  if (!resolved) {
    return { kind: "no-eligible-candidate", livePoolEmpty: candidates.length === 0 }
  }

  return {
    kind: "resolved",
    model: resolved.model,
    band: resolved.band,
    requestedTier: resolved.requestedTier,
    escalated: resolved.escalated,
    usedMainModel: resolved.usedMainModel,
  }
}
