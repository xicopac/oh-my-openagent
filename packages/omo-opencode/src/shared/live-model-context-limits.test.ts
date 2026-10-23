import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  _resetMemCacheForTesting,
  writeProviderModelsCache,
} from "./connected-providers-cache"
import {
  _resetLiveModelContextLimitsForTesting,
  resolveLiveContextLimit,
} from "./live-model-context-limits"

const MODELS_JSON = {
  opencode: {
    models: {
      "deepseek-v4.1-flash": { limit: { context: 1_000_000 } },
      "no-limit-model": { id: "no-limit-model" },
    },
  },
}

function writeModelsJson(cacheHome: string): void {
  const dir = join(cacheHome, "opencode")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "models.json"), JSON.stringify(MODELS_JSON))
}

let cacheHome: string
const originalXdgCacheHome = process.env.XDG_CACHE_HOME

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "live-context-limit-"))
  process.env.XDG_CACHE_HOME = cacheHome
  _resetMemCacheForTesting()
  _resetLiveModelContextLimitsForTesting()
})

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome
  }
  _resetMemCacheForTesting()
  _resetLiveModelContextLimitsForTesting()
  try {
    rmSync(cacheHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe("resolveLiveContextLimit", () => {
  it("reads the context window from OpenCode's models.json", () => {
    // given OpenCode's models.dev cache carries the model's limit
    writeModelsJson(cacheHome)

    // when
    const limit = resolveLiveContextLimit("opencode", "deepseek-v4.1-flash")

    // then
    expect(limit).toBe(1_000_000)
  })

  it("returns null when the model is absent or carries no limit", () => {
    // given the cache has the model without a limit plus an unrelated model
    writeModelsJson(cacheHome)

    // when / then
    expect(resolveLiveContextLimit("opencode", "no-limit-model")).toBeNull()
    expect(resolveLiveContextLimit("opencode", "missing-model")).toBeNull()
  })

  it("returns null when no live source exists", () => {
    // given no provider-model cache and no models.json
    // when / then
    expect(resolveLiveContextLimit("opencode", "deepseek-v4.1-flash")).toBeNull()
  })

  it("prefers the plugin provider-model cache over models.json", () => {
    // given the plugin's live provider-model cache knows the model
    writeModelsJson(cacheHome)
    writeProviderModelsCache({
      connected: ["opencode"],
      models: {
        opencode: [{ id: "deepseek-v4.1-flash", limit: { context: 777_000 } }],
      },
    })

    // when
    const limit = resolveLiveContextLimit("opencode", "deepseek-v4.1-flash")

    // then
    expect(limit).toBe(777_000)
  })
})
