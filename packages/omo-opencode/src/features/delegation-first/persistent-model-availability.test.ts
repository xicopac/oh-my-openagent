import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { createModelAvailabilityCache } from "./model-availability-cache"
import {
  loadPersistentAvailability,
  resolveModelAvailabilityFilePath,
  savePersistentAvailability,
  type PersistentAvailabilityData,
} from "./persistent-model-availability"

const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_DISABLED_QUARANTINE_TTL_MS = 12 * 60 * 60 * 1000

const tempDirs: string[] = []
function tempFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return join(dir, "model-availability.json")
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function readStore(filePath: string): PersistentAvailabilityData {
  return JSON.parse(readFileSync(filePath, "utf-8")) as PersistentAvailabilityData
}

describe("persistent model-availability store (process-restart survival)", () => {
  test("A: a model marked unavailable in one process is still unavailable in a fresh process on the same file", () => {
    //#given
    const file = tempFile("persist-a-")
    const clock = () => 0
    const first = createModelAvailabilityCache({ persistentFilePath: file, nowMs: clock, ttlMs: 60_000 })

    //#when
    first.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)

    //#then
    const fresh = createModelAvailabilityCache({ persistentFilePath: file, nowMs: clock, ttlMs: 60_000 })
    expect(fresh.isUnavailable("opencode/claude-haiku-4-5", 0)).toBe(true)
    expect(fresh.unavailableKeys(0)).toContain("opencode/claude-haiku-4-5")
  })

  test("B: the persisted file carries provider/model/reason/classification/timestamps/retryAfterAt/consecutiveFailures", () => {
    //#given
    const file = tempFile("persist-b-")
    const first = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 0, ttlMs: 60_000 })

    //#when
    first.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)

    //#then
    const entry = readStore(file).entries["opencode/claude-haiku-4-5"]
    expect(entry).toBeDefined()
    expect(entry?.provider).toBe("opencode")
    expect(entry?.model).toBe("claude-haiku-4-5")
    expect(entry?.reason).toBe("Model is disabled")
    expect(entry?.classification).toBe("disabled")
    expect(entry?.firstFailureAt).toBe("1970-01-01T00:00:00.000Z")
    expect(entry?.lastFailureAt).toBe("1970-01-01T00:00:00.000Z")
    expect(entry?.retryAfterAt).toBe("1970-01-01T00:01:00.000Z")
    expect(entry?.consecutiveFailures).toBe(1)
  })

  test("C: an unrelated catalog refresh (reload/rewrite of the store) keeps the quarantine while retryAfterAt is in the future", () => {
    //#given
    const file = tempFile("persist-c-")
    const first = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 0, ttlMs: 60_000 })
    first.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)

    //#when: simulate an unrelated write to the store (catalog refresh) mid-quarantine
    savePersistentAvailability(file, loadPersistentAvailability(file))
    const afterRefresh = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 30_000, ttlMs: 60_000 })

    //#then
    expect(afterRefresh.isUnavailable("opencode/claude-haiku-4-5", 30_000)).toBe(true)
    expect(afterRefresh.unavailableKeys(30_000)).toContain("opencode/claude-haiku-4-5")
  })

  test("D: once injected now passes retryAfterAt the entry is gone from a fresh process", () => {
    //#given
    const file = tempFile("persist-d-")
    const first = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 0, ttlMs: 10_000 })
    first.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)

    //#when
    const expired = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 10_001, ttlMs: 10_000 })

    //#then
    expect(expired.isUnavailable("opencode/claude-haiku-4-5")).toBe(false)
    expect(expired.unavailableKeys()).not.toContain("opencode/claude-haiku-4-5")
  })

  test("E: clear(modelKey) removes the entry from disk and from a fresh process", () => {
    //#given
    const file = tempFile("persist-e-")
    const first = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 0, ttlMs: 60_000 })
    first.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)
    expect(readStore(file).entries["opencode/claude-haiku-4-5"]).toBeDefined()

    //#when
    first.clear("opencode/claude-haiku-4-5")

    //#then
    expect(readStore(file).entries["opencode/claude-haiku-4-5"]).toBeUndefined()
    const fresh = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 0, ttlMs: 60_000 })
    expect(fresh.unavailableKeys(0)).not.toContain("opencode/claude-haiku-4-5")
  })

  test("F: a corrupt or wrong-shape state file yields an empty store and is repaired by the next persist", () => {
    //#given: malformed JSON
    const malformed = tempFile("persist-f-malformed-")
    writeFileSync(malformed, "{not-json")

    //#when
    const fromMalformed = createModelAvailabilityCache({ persistentFilePath: malformed, nowMs: () => 0, ttlMs: 60_000 })
    fromMalformed.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)

    //#then
    expect(fromMalformed.unavailableKeys(0)).toContain("opencode/claude-haiku-4-5")
    const repairedMalformed = readStore(malformed)
    expect(repairedMalformed.version).toBe(1)
    expect(repairedMalformed.entries["opencode/claude-haiku-4-5"]).toBeDefined()

    //#given: wrong-shape JSON (not the expected schema)
    const wrongShape = tempFile("persist-f-wrongshape-")
    writeFileSync(wrongShape, JSON.stringify({ foo: 1 }))

    //#when
    const fromWrongShape = createModelAvailabilityCache({ persistentFilePath: wrongShape, nowMs: () => 0, ttlMs: 60_000 })
    const emptyKeys = fromWrongShape.unavailableKeys(0)

    //#then
    expect(emptyKeys).toEqual([])
    savePersistentAvailability(wrongShape, { version: 1, entries: {} })
    expect(readStore(wrongShape)).toEqual({ version: 1, entries: {} })
  })

  test("G: an explicit temp path never reads/writes the default ~/.omo store, and env override wins over the default", () => {
    //#given
    const defaultPath = join(homedir(), ".omo", "model-availability.json")
    const defaultExistedBefore = existsSync(defaultPath)
    const file = tempFile("persist-g-")
    const cache = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 0, ttlMs: 60_000 })
    cache.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)

    //#when: only the explicit temp path was touched
    const defaultExistedAfter = existsSync(defaultPath)

    //#then
    expect(defaultExistedAfter).toBe(defaultExistedBefore)
    expect(existsSync(file)).toBe(true)
    expect(cache.unavailableKeys(0)).toContain("opencode/claude-haiku-4-5")
  })

  test("G2: resolveModelAvailabilityFilePath precedence: override > env > HOME-based default", () => {
    //#given
    const override = tempFile("persist-g2-override-")
    const envPath = tempFile("persist-g2-env-")
    const defaultPath = join(process.env.HOME ?? homedir(), ".omo", "model-availability.json")

    //#when
    process.env.OMO_MODEL_AVAILABILITY_FILE = envPath

    //#then
    expect(resolveModelAvailabilityFilePath(override)).toBe(override)
    expect(resolveModelAvailabilityFilePath()).toBe(envPath)

    //#when: env cleared falls back to the default
    delete process.env.OMO_MODEL_AVAILABILITY_FILE

    //#then
    expect(resolveModelAvailabilityFilePath()).toBe(defaultPath)
  })

  test("G3: resolveModelAvailabilityFilePath honors process.env.HOME when set", () => {
    //#given
    const originalHome = process.env.HOME
    const homeDir = mkdtempSync(join(tmpdir(), "persist-g3-home-"))
    tempDirs.push(homeDir)
    delete process.env.OMO_MODEL_AVAILABILITY_FILE

    try {
      //#when: HOME redirected (test-setup / e2e harness style)
      process.env.HOME = homeDir
      const resolved = resolveModelAvailabilityFilePath()

      //#then
      expect(resolved).toBe(join(homeDir, ".omo", "model-availability.json"))
    } finally {
      //#after: restore HOME
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })

  test("H: the regression — a fresh process sees X disabled without any new markUnavailable call", () => {
    //#given
    const file = tempFile("persist-h-")
    const instanceA = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 0, ttlMs: 60_000 })
    instanceA.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)

    //#when: fresh instance B, same file, zero markUnavailable calls on B
    const instanceB = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 0, ttlMs: 60_000 })

    //#then
    expect(instanceB.unavailableKeys(0)).toContain("opencode/claude-haiku-4-5")
  })
})

describe("model-availability cache TTL policy with persistence", () => {
  test("disabled-model failures get the long quarantine; other failures keep the 10min TTL", () => {
    //#given
    delete process.env.OMO_MODEL_DISABLED_QUARANTINE_TTL_MS
    const cache = createModelAvailabilityCache({ nowMs: () => 0 })
    cache.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)
    cache.markUnavailable("opencode/gpt-5.4", "provider overloaded", 0)

    //#when
    const disabledStillQuarantined = cache.isUnavailable("opencode/claude-haiku-4-5", DEFAULT_TTL_MS + 1)
    const ordinaryExpired = cache.isUnavailable("opencode/gpt-5.4", DEFAULT_TTL_MS + 1)
    const disabledExpired = cache.isUnavailable(
      "opencode/claude-haiku-4-5",
      DEFAULT_DISABLED_QUARANTINE_TTL_MS + 1,
    )

    //#then
    expect(disabledStillQuarantined).toBe(true)
    expect(ordinaryExpired).toBe(false)
    expect(disabledExpired).toBe(false)
  })

  test("re-marking an already-quarantined model increments consecutiveFailures and refreshes timestamps", () => {
    //#given
    const file = tempFile("persist-consecutive-")
    const cache = createModelAvailabilityCache({ persistentFilePath: file, nowMs: () => 0, ttlMs: 60_000 })
    cache.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)

    //#when
    cache.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 5_000)

    //#then
    const entry = readStore(file).entries["opencode/claude-haiku-4-5"]
    expect(entry?.consecutiveFailures).toBe(2)
    expect(entry?.firstFailureAt).toBe("1970-01-01T00:00:00.000Z")
    expect(entry?.lastFailureAt).toBe("1970-01-01T00:00:05.000Z")
    expect(entry?.retryAfterAt).toBe("1970-01-01T00:01:05.000Z")
  })

  test("env OMO_MODEL_DISABLED_QUARANTINE_TTL_MS overrides the disabled quarantine TTL", () => {
    //#given
    process.env.OMO_MODEL_DISABLED_QUARANTINE_TTL_MS = "5000"
    const cache = createModelAvailabilityCache({ nowMs: () => 0 })
    cache.markUnavailable("opencode/claude-haiku-4-5", "Model is disabled", 0)

    //#when
    const before = cache.isUnavailable("opencode/claude-haiku-4-5", 4_999)
    const after = cache.isUnavailable("opencode/claude-haiku-4-5", 5_001)

    //#then
    expect(before).toBe(true)
    expect(after).toBe(false)
  })
})