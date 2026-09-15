import { isRecord } from "@oh-my-opencode/utils"

/**
 * OpenCode config shape reduced to the fields that govern model enable state.
 * The workspace UI's green/grey toggle is encoded here: a provider may be
 * disabled outright, or a provider's model set narrowed via whitelist/blacklist,
 * or a single model marked disabled via status/enabled.
 */
export type ModelEnableConfig = {
  disabled_providers?: string[]
  enabled_providers?: string[]
  provider?: Record<
    string,
    {
      whitelist?: string[]
      blacklist?: string[]
      models?: Record<string, { status?: string; enabled?: boolean }>
    }
  >
}

export type ModelEnableState = {
  /** Providers the user disabled; every model under them is excluded. */
  disabledProviders: Set<string>
  /** Explicitly disabled model keys (provider/model); excluded regardless of provider. */
  disabledModels: Set<string>
  /** When non-empty, only these providers are enabled; all others are excluded. */
  enabledProviders: Set<string> | null
  /** Per-provider whitelist; when present, only listed models are enabled. */
  whitelists: Map<string, Set<string>>
  /** Per-provider blacklist; listed models are disabled. */
  blacklists: Map<string, Set<string>>
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Reduce an OpenCode config into the authoritative enable-state sets without
 * touching the user's configuration. Disabled providers/models are computed,
 * never re-enabled, and never routed around.
 */
export function computeModelEnableState(config: unknown): ModelEnableState {
  const cfg = isRecord(config) ? config : {}

  const disabledProviders = new Set<string>()
  const disabledModels = new Set<string>()
  let enabledProviders: Set<string> | null = null
  const whitelists = new Map<string, Set<string>>()
  const blacklists = new Map<string, Set<string>>()

  if (Array.isArray(cfg.disabled_providers)) {
    for (const entry of cfg.disabled_providers) {
      if (typeof entry === "string") disabledProviders.add(normalize(entry))
    }
  }

  if (Array.isArray(cfg.enabled_providers) && cfg.enabled_providers.length > 0) {
    enabledProviders = new Set<string>()
    for (const entry of cfg.enabled_providers) {
      if (typeof entry === "string") enabledProviders.add(normalize(entry))
    }
  }

  const providers = isRecord(cfg.provider) ? cfg.provider : {}
  for (const [providerID, providerRaw] of Object.entries(providers)) {
    if (!isRecord(providerRaw)) continue
    const providerKey = normalize(providerID)

    if (Array.isArray(providerRaw.whitelist)) {
      const set = new Set<string>()
      for (const entry of providerRaw.whitelist) {
        if (typeof entry === "string") set.add(normalize(entry))
      }
      whitelists.set(providerKey, set)
    }

    if (Array.isArray(providerRaw.blacklist)) {
      const set = new Set<string>()
      for (const entry of providerRaw.blacklist) {
        if (typeof entry === "string") set.add(normalize(entry))
      }
      blacklists.set(providerKey, set)
    }

    const models = isRecord(providerRaw.models) ? providerRaw.models : {}
    for (const [modelID, modelRaw] of Object.entries(models)) {
      if (!isRecord(modelRaw)) continue
      const status = typeof modelRaw.status === "string" ? modelRaw.status.toLowerCase() : undefined
      const enabled = typeof modelRaw.enabled === "boolean" ? modelRaw.enabled : undefined
      if (status === "disabled" || enabled === false || (status !== undefined && status !== "active" && status !== "beta")) {
        disabledModels.add(`${providerKey}/${normalize(modelID)}`)
      }
    }
  }

  return { disabledProviders, disabledModels, enabledProviders, whitelists, blacklists }
}

/**
 * Decide whether a single model key (provider/model) is enabled given the
 * computed enable state. A model is enabled only when its provider is not
 * disabled (and is inside enabled_providers when that allowlist is set), and
 * it is neither explicitly disabled nor blacklisted, and passes its provider's
 * whitelist when present.
 */
export function isModelEnabled(
  modelKey: string,
  state: ModelEnableState,
): boolean {
  const slash = modelKey.indexOf("/")
  if (slash <= 0) return false
  const provider = normalize(modelKey.slice(0, slash))
  const model = normalize(modelKey.slice(slash + 1))

  if (state.disabledProviders.has(provider)) return false
  if (state.enabledProviders !== null && !state.enabledProviders.has(provider)) return false
  if (state.disabledModels.has(`${provider}/${model}`)) return false

  const blacklist = state.blacklists.get(provider)
  if (blacklist?.has(model)) return false

  const whitelist = state.whitelists.get(provider)
  if (whitelist && !whitelist.has(model)) return false

  return true
}

export function filterEnabledModelKeys(
  models: ReadonlySet<string>,
  state: ModelEnableState,
): Set<string> {
  const enabled = new Set<string>()
  for (const modelKey of models) {
    if (isModelEnabled(modelKey, state)) enabled.add(modelKey)
  }
  return enabled
}
