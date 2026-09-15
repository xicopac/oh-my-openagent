import type { OpencodeClient } from "./types"
import { log } from "../../shared/logger"
import { isRecord } from "../../shared/record-type-guard"
import * as connectedProvidersCache from "../../shared/connected-providers-cache"
import type { ModelPricing, PricingCatalog } from "../../hooks/resource-governor/pricing"
import type { ModelCapabilityInfo } from "../../features/delegation-first"
import {
  computeModelEnableState,
  filterEnabledModelKeys,
  type ModelEnableState,
} from "../../shared/model-enable-state"

type ModelListClient = OpencodeClient & {
  model: { list: () => Promise<unknown> }
}

function hasModelList(client: OpencodeClient): client is ModelListClient {
  return "model" in client && isRecord(client.model) && typeof client.model.list === "function"
}

function isModelRow(value: unknown): value is { provider: string; id: string } {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string"
}

function extractModelRows(result: unknown): Array<{ provider: string; id: string; cost?: unknown }> {
  const rows = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.data) ? result.data : []
  return rows.filter(isModelRow)
}

function extractModelPricing(cost: unknown): ModelPricing | undefined {
  if (!isRecord(cost)) return undefined
  const input = cost["input"]
  const output = cost["output"]
  if (typeof input !== "number" || typeof output !== "number") return undefined
  const cacheRaw = cost["cache"]
  const cache = isRecord(cacheRaw) ? cacheRaw : undefined
  const cacheRead = typeof cache?.["read"] === "number" ? (cache["read"] as number) : 0
  const cacheWrite = typeof cache?.["write"] === "number" ? (cache["write"] as number) : 0
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite }
}

export { extractModelPricing as extractModelPricingForTest }

/** Read the workspace enable state from OpenCode's live config (best-effort). */
export async function getEnabledModelState(client: OpencodeClient): Promise<ModelEnableState> {
  const cfgClient = client as OpencodeClient & { config?: { get?: () => Promise<unknown> } }
  try {
    const raw = await cfgClient.config?.get?.()
    const data = isRecord(raw) && isRecord(raw.data) ? raw.data : raw
    return computeModelEnableState(data)
  } catch (err) {
    log("[delegate-task] client.config.get failed; treating all models enabled", { error: String(err) })
    return computeModelEnableState(undefined)
  }
}

type ModelInfoResult = { models: Set<string>; pricing: PricingCatalog; modelInfo: Map<string, ModelCapabilityInfo> }

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined
}

function readVision(capabilities: Record<string, unknown> | undefined, modalities: unknown): boolean | undefined {
  if (isRecord(capabilities)) {
    const input = capabilities.input
    if (isRecord(input)) {
      const image = (input as Record<string, unknown>).image
      if (typeof image === "boolean") return image
    }
  }
  if (isRecord(modalities)) {
    const input = modalities.input
    if (Array.isArray(input)) return input.includes("image")
  }
  return undefined
}

function modelInfoFromMetadata(metadata: unknown): ModelCapabilityInfo | undefined {
  if (!isRecord(metadata)) return undefined
  const limit = isRecord(metadata.limit) ? metadata.limit : undefined
  const context = readNumber(limit?.context)
  const modalities = metadata.modalities
  const capabilities = metadata.capabilities
  const toolCall = typeof metadata.tool_call === "boolean" ? metadata.tool_call : (isRecord(capabilities) && typeof capabilities.toolcall === "boolean" ? capabilities.toolcall : undefined)
  const reasoning = typeof metadata.reasoning === "boolean" ? metadata.reasoning : undefined
  const vision = readVision(isRecord(capabilities) ? capabilities : undefined, modalities)
  const info: ModelCapabilityInfo = {}
  if (context !== undefined) info.context_limit = context
  if (vision !== undefined) info.vision = vision
  if (toolCall !== undefined) info.tool_call = toolCall
  if (reasoning !== undefined) info.reasoning = reasoning
  return Object.keys(info).length > 0 ? info : undefined
}

export async function getAvailableModelsForDelegateTask(client: OpencodeClient): Promise<Set<string>> {
  const { models } = await getModelsWithPricingForDelegateTask(client)
  return models
}

export async function getModelsWithPricingAndMetadataForDelegateTask(client: OpencodeClient): Promise<ModelInfoResult> {
  const base = await getModelsWithPricingForDelegateTask(client)
  const modelInfo = new Map<string, ModelCapabilityInfo>()

  const providerModelsCache = connectedProvidersCache.readProviderModelsCache()
  if (providerModelsCache?.models) {
    for (const [providerID, entries] of Object.entries(providerModelsCache.models)) {
      for (const entry of entries as Array<string | Record<string, unknown>>) {
        if (typeof entry === "string") continue
        const id = typeof entry.id === "string" ? entry.id : undefined
        if (!id) continue
        const info = modelInfoFromMetadata(entry)
        if (info) modelInfo.set(`${providerID}/${id}`, info)
      }
    }
  }

  return { models: base.models, pricing: base.pricing, modelInfo }
}

/**
 * Live model + pricing discovery for delegate-task. Merges the connected
 * provider-models cache and the live `client.model.list()` result, and derives
 * authoritative per-model pricing from the live cost (USD per 1M tokens). A
 * model is genuinely $0 only when the live cost reports input AND output as 0.
 */
export async function getModelsWithPricingForDelegateTask(
  client: OpencodeClient,
): Promise<{ models: Set<string>; pricing: PricingCatalog }> {
  const providerModelsCache = connectedProvidersCache.readProviderModelsCache()
  const pricing: Record<string, ModelPricing> = {}

  if (providerModelsCache?.models) {
    const connected = new Set(providerModelsCache.connected)
    const models = new Set<string>()
    for (const [providerID, entries] of Object.entries(providerModelsCache.models)) {
      if (!connected.has(providerID)) continue
      for (const item of entries as Array<string | { id?: string }>) {
        const modelID = typeof item === "string" ? item : item?.id
        if (!modelID) continue
        models.add(`${providerID}/${modelID}`)
      }
    }
    return { models, pricing }
  }

  const connectedProviders = connectedProvidersCache.readConnectedProvidersCache()
  if (!connectedProviders || connectedProviders.length === 0) {
    return { models: new Set(), pricing }
  }

  if (!hasModelList(client)) {
    return { models: new Set(), pricing }
  }

  try {
    const result = await client.model.list()
    const rows = extractModelRows(result)
    const connected = new Set(connectedProviders)
    const models = new Set<string>()
    for (const row of rows) {
      if (!connected.has(row.provider)) continue
      const key = `${row.provider}/${row.id}`
      models.add(key)
      const cost = extractModelPricing((row as { cost?: unknown }).cost)
      if (cost) pricing[key] = cost
    }
    return { models, pricing }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    log("[delegate-task] client.model.list failed", { error: errorMessage })
    return { models: new Set(), pricing }
  }
}
