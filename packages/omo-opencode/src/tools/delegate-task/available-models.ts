import type { OpencodeClient } from "./types"
import { log } from "../../shared/logger"
import { isRecord } from "../../shared/record-type-guard"
import * as connectedProvidersCache from "../../shared/connected-providers-cache"
import type { ModelPricing, PricingCatalog } from "../../hooks/resource-governor/pricing"

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

export async function getAvailableModelsForDelegateTask(client: OpencodeClient): Promise<Set<string>> {
  const { models } = await getModelsWithPricingForDelegateTask(client)
  return models
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
