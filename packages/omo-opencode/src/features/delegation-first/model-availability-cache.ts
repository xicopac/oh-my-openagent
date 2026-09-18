/**
 * Bounded negative-availability cache for provider/model routes. When a child
 * fails with `AI_APICallError: Model is disabled` (an availability failure, not
 * a reasoning failure), that model is marked unavailable so that concurrent and
 * subsequent workers do not keep re-hitting the same known-disabled model.
 *
 * Entries expire (TTL) because provider availability can change; the cache is
 * also size-bounded so it can never grow unboundedly. Pure and deterministic —
 * time is injected for tests, never read implicitly.
 *
 * When a `persistentFilePath` is provided, quarantines are also persisted to
 * disk so a fresh OpenCode process hydrates them at construction instead of
 * re-selecting a known-disabled model. The in-memory Map stays the hot cache;
 * disk is a write-through mirror hydrated once at construction.
 */

import { isModelDisabledError } from "../../shared/model-error-classifier"
import {
  createPersistentModelAvailability,
  type PersistedAvailabilityEntry,
  type PersistentAvailabilityData,
} from "./persistent-model-availability"

export type ModelAvailabilityCacheOptions = {
  /** How long an entry stays unavailable before it may be re-tried. */
  ttlMs?: number
  /** Hard cap on stored entries; oldest entries are evicted first. */
  maxEntries?: number
  /** When set, quarantines are persisted here and hydrated on construction. */
  persistentFilePath?: string
  /** Deterministic clock for tests; defaults to Date.now. */
  nowMs?: () => number
}

export type ModelAvailabilityCache = {
  markUnavailable(modelKey: string, reason: string, nowMs?: number): void
  isUnavailable(modelKey: string, nowMs?: number): boolean
  unavailableKeys(nowMs?: number): string[]
  clear(modelKey?: string): void
  size(): number
}

const DEFAULT_TTL_MS = 10 * 60 * 1000
// A disabled model is a catalog-level state, not a transient load signal: keep
// it quarantined far longer than ordinary availability failures.
const DEFAULT_DISABLED_QUARANTINE_TTL_MS = 12 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 200

type CacheEntry = {
  expiresAtMs: number
  persisted: PersistedAvailabilityEntry
}

function splitModelKey(modelKey: string): { provider?: string; model: string } {
  const slash = modelKey.indexOf("/")
  if (slash < 0) return { model: modelKey }
  return { provider: modelKey.slice(0, slash), model: modelKey.slice(slash + 1) }
}

export function createModelAvailabilityCache(
  options: ModelAvailabilityCacheOptions = {},
): ModelAvailabilityCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const disabledTtlMs = options.ttlMs ?? readDisabledQuarantineTtlMs()
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const now = options.nowMs ?? (() => Date.now())
  // modelKey -> entry metadata (hot cache; disk is a write-through mirror).
  const entries = new Map<string, CacheEntry>()

  const store = options.persistentFilePath
    ? createPersistentModelAvailability(options.persistentFilePath)
    : undefined

  function hydrate(): void {
    if (!store) return
    const at = now()
    for (const [key, entry] of Object.entries(store.load().entries)) {
      const retryAfter = Date.parse(entry.retryAfterAt)
      if (Number.isNaN(retryAfter) || retryAfter <= at) continue
      entries.set(key, { expiresAtMs: retryAfter, persisted: entry })
    }
  }

  function prune(atMs: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs <= atMs) entries.delete(key)
    }
  }

  function persist(atMs: number): void {
    if (!store) return
    // Mirror the hot cache exactly: drop expired entries before writing.
    prune(atMs)
    const record: Record<string, PersistedAvailabilityEntry> = {}
    for (const [key, entry] of entries) {
      record[key] = entry.persisted
    }
    const data: PersistentAvailabilityData = { version: 1, entries: record }
    store.persist(data)
  }

  hydrate()

  return {
    markUnavailable(modelKey, reason, nowMs) {
      const at = nowMs ?? now()
      const disabled = isModelDisabledError({ message: reason })
      const ttl = disabled ? disabledTtlMs : ttlMs
      const existing = entries.get(modelKey)
      // Evict oldest before insert to stay within the bound (Map preserves
      // insertion order, so the first key is the oldest).
      if (entries.size >= maxEntries && !entries.has(modelKey)) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
      const split = splitModelKey(modelKey)
      const persisted: PersistedAvailabilityEntry = {
        provider: split.provider,
        model: split.model,
        reason,
        classification: disabled ? "disabled" : "availability-failure",
        firstFailureAt: existing ? existing.persisted.firstFailureAt : new Date(at).toISOString(),
        lastFailureAt: new Date(at).toISOString(),
        retryAfterAt: new Date(at + ttl).toISOString(),
        consecutiveFailures: existing ? existing.persisted.consecutiveFailures + 1 : 1,
      }
      entries.set(modelKey, { expiresAtMs: at + ttl, persisted })
      persist(at)
    },
    isUnavailable(modelKey, nowMs) {
      const at = nowMs ?? now()
      prune(at)
      const entry = entries.get(modelKey)
      return entry !== undefined && entry.expiresAtMs > at
    },
    unavailableKeys(nowMs) {
      const at = nowMs ?? now()
      prune(at)
      return [...entries.keys()]
    },
    clear(modelKey) {
      if (modelKey) {
        entries.delete(modelKey)
      } else {
        entries.clear()
      }
      persist(now())
    },
    size() {
      return entries.size
    },
  }
}

function readDisabledQuarantineTtlMs(): number {
  const envMs = Number(process.env.OMO_MODEL_DISABLED_QUARANTINE_TTL_MS)
  if (Number.isFinite(envMs) && envMs > 0) return envMs
  return DEFAULT_DISABLED_QUARANTINE_TTL_MS
}
