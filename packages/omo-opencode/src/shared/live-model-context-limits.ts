import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { findProviderModelMetadata } from "./connected-providers-cache"
import { getOpenCodeCacheDir } from "./data-path"
import { log } from "./logger"
import { isRecord } from "./record-type-guard"

/**
 * Live context-window resolution for models the static config-derived
 * `modelContextLimitsCache` does not know about (gateway models whose
 * `limit.context` only exists in live provider metadata).
 *
 * Sources, in priority order:
 *  1. The plugin's provider-model cache (`provider-models.json`), written from
 *     the live `client.provider.list()` result.
 *  2. OpenCode's own models.dev cache (`~/.cache/opencode/models.json`).
 *
 * Both are read at most once per process and are only consulted on a cache
 * miss, so the hot path stays allocation-free once resolved.
 */
let modelsJsonLimits: Map<string, number> | null | undefined

function readModelsJsonLimits(): Map<string, number> | null {
  if (modelsJsonLimits !== undefined) return modelsJsonLimits

  try {
    const file = join(getOpenCodeCacheDir(), "models.json")
    if (!existsSync(file)) {
      modelsJsonLimits = null
      return null
    }

    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"))
    const limits = new Map<string, number>()
    if (isRecord(parsed)) {
      for (const [providerID, providerRaw] of Object.entries(parsed)) {
        if (!isRecord(providerRaw)) continue
        const models = providerRaw.models
        if (!isRecord(models)) continue
        for (const [modelID, modelRaw] of Object.entries(models)) {
          if (!isRecord(modelRaw)) continue
          const limit = modelRaw.limit
          if (!isRecord(limit)) continue
          const context = limit.context
          if (typeof context === "number" && context > 0) {
            limits.set(`${providerID}/${modelID}`, context)
          }
        }
      }
    }

    modelsJsonLimits = limits
    return limits
  } catch (error) {
    log("[live-model-context-limits] failed to read OpenCode models.json", {
      error: error instanceof Error ? error.message : String(error),
    })
    modelsJsonLimits = null
    return null
  }
}

/**
 * Resolve a model's real context window from live provider metadata.
 * Returns a positive token count, or null when no live source knows the model.
 */
export function resolveLiveContextLimit(providerID: string, modelID: string): number | null {
  const metadataLimit = findProviderModelMetadata(providerID, modelID)?.limit?.context
  if (typeof metadataLimit === "number" && metadataLimit > 0) return metadataLimit

  const modelsJsonLimit = readModelsJsonLimits()?.get(`${providerID}/${modelID}`)
  if (typeof modelsJsonLimit === "number" && modelsJsonLimit > 0) return modelsJsonLimit

  return null
}

export function _resetLiveModelContextLimitsForTesting(): void {
  modelsJsonLimits = undefined
}
