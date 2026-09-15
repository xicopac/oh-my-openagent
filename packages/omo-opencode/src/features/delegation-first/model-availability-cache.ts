/**
 * Bounded negative-availability cache for provider/model routes. When a child
 * fails with `AI_APICallError: Model is disabled` (an availability failure, not
 * a reasoning failure), that model is marked unavailable so that concurrent and
 * subsequent workers do not keep re-hitting the same known-disabled model.
 *
 * Entries expire (TTL) because provider availability can change; the cache is
 * also size-bounded so it can never grow unboundedly. Pure and deterministic —
 * time is injected for tests, never read implicitly.
 */

export type ModelAvailabilityCacheOptions = {
  /** How long an entry stays unavailable before it may be re-tried. */
  ttlMs?: number
  /** Hard cap on stored entries; oldest entries are evicted first. */
  maxEntries?: number
}

export type ModelAvailabilityCache = {
  markUnavailable(modelKey: string, reason: string, nowMs?: number): void
  isUnavailable(modelKey: string, nowMs?: number): boolean
  unavailableKeys(nowMs?: number): string[]
  clear(modelKey?: string): void
  size(): number
}

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 200

export function createModelAvailabilityCache(
  options: ModelAvailabilityCacheOptions = {},
): ModelAvailabilityCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  // modelKey -> expiresAtMs (epoch ms)
  const entries = new Map<string, number>()

  function prune(nowMs: number): void {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= nowMs) entries.delete(key)
    }
  }

  return {
    markUnavailable(modelKey, reason, nowMs) {
      const at = nowMs ?? Date.now()
      // Evict oldest before insert to stay within the bound (Map preserves
      // insertion order, so the first key is the oldest).
      if (entries.size >= maxEntries && !entries.has(modelKey)) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
      entries.set(modelKey, at + ttlMs)
      void reason
    },
    isUnavailable(modelKey, nowMs) {
      const at = nowMs ?? Date.now()
      prune(at)
      const expiresAt = entries.get(modelKey)
      return expiresAt !== undefined && expiresAt > at
    },
    unavailableKeys(nowMs) {
      const at = nowMs ?? Date.now()
      prune(at)
      return [...entries.keys()]
    },
    clear(modelKey) {
      if (modelKey) {
        entries.delete(modelKey)
      } else {
        entries.clear()
      }
    },
    size() {
      return entries.size
    },
  }
}
