/**
 * Persistent negative model-availability (quarantine) store. The in-memory
 * availability cache lives and dies with one OpenCode process; this file-backed
 * store survives restarts so a model that returns "Model is disabled" is
 * remembered by a fresh process instead of being re-selected.
 *
 * Schema is versioned (`version: 1`) and reads are tolerant: a missing,
 * corrupt, or old-schema file yields an empty-but-valid store, never a throw.
 * Writes go through the shared atomic JSON writer so a crash mid-write can
 * never corrupt a previously-valid file.
 */

import { homedir } from "node:os"
import { join } from "node:path"

import { readJsonTolerant, writeAtomicJson } from "../../shared/atomic-fs"

export const MODEL_AVAILABILITY_FILE_NAME = "model-availability.json"

export type PersistedAvailabilityEntry = {
  provider?: string
  model: string
  reason: string
  classification: string
  firstFailureAt: string
  lastFailureAt: string
  retryAfterAt: string
  consecutiveFailures: number
}

export type PersistentAvailabilityData = {
  version: 1
  entries: Record<string, PersistedAvailabilityEntry>
}

/**
 * Resolve the persistent negative-availability store path.
 *
 * Precedence:
 *   1. explicit `override` (used by tests and DI call sites)
 *   2. `OMO_MODEL_AVAILABILITY_FILE` env var (used by QA sandboxes / tooling)
 *   3. `~/.omo/model-availability.json` (the user's OMA state directory),
 *      resolved via `process.env.HOME` when present so isolated test/e2e HOME
 *      overrides redirect the store instead of writing the real user home.
 *
 * Stored OUTSIDE the repository so quarantines survive session completion and
 * OpenCode restart without depending on the project checkout.
 */
export function resolveModelAvailabilityFilePath(override?: string): string {
  if (override) return override
  const env = process.env.OMO_MODEL_AVAILABILITY_FILE
  if (env && env.length > 0) return env
  // `os.homedir()` caches the OS home at process start and ignores later
  // `process.env.HOME` mutations (test-setup.ts and the e2e harness set an
  // isolated HOME). Honor `process.env.HOME` when present so those runs redirect
  // the store instead of writing the developer's real `~/.omo`; in production
  // HOME equals the real home, so behavior is unchanged.
  return join(process.env.HOME ?? homedir(), ".omo", MODEL_AVAILABILITY_FILE_NAME)
}

function isPersistentAvailabilityData(value: unknown): value is PersistentAvailabilityData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  if (data.version !== 1) return false
  if (data.entries === null || typeof data.entries !== "object" || Array.isArray(data.entries)) return false
  return true
}

/**
 * Tolerant loader: a missing, malformed, or non-matching-schema file yields an
 * empty-but-valid store. Never throws.
 */
export function loadPersistentAvailability(filePath: string): PersistentAvailabilityData {
  const parsed = readJsonTolerant(filePath)
  if (!isPersistentAvailabilityData(parsed)) return { version: 1, entries: {} }
  return parsed
}

/**
 * Atomic writer: replaces the file via a same-directory temp file + rename.
 * Never throws; write failures are surfaced via console.warn.
 */
export function savePersistentAvailability(filePath: string, data: PersistentAvailabilityData): void {
  try {
    writeAtomicJson(filePath, data)
  } catch (error) {
    console.warn(`[model-availability] failed to persist availability store to ${filePath}`, error)
  }
}

export type PersistentModelAvailability = {
  load(): PersistentAvailabilityData
  persist(data: PersistentAvailabilityData): void
}

/**
 * Read-once / memoized handle over the store file, mirroring the
 * json-file-cache-store pattern: the file is parsed once and cached in memory,
 * and every persist updates both the file and the memoized value.
 */
export function createPersistentModelAvailability(filePath: string): PersistentModelAvailability {
  let memoized: PersistentAvailabilityData | undefined

  return {
    load() {
      if (memoized) return memoized
      memoized = loadPersistentAvailability(filePath)
      return memoized
    },
    persist(data) {
      savePersistentAvailability(filePath, data)
      memoized = data
    },
  }
}