import type { ModelRoutingConfig } from "../config/schema"
import { log } from "../shared/logger"

/**
 * AUTHORITATIVE MASTER MODEL.
 *
 * The root/master session model is OpenCode's top-level `config.model`. OMO
 * already carries an explicit master tier in `~/.omo/omo.jsonc`
 * (`model_routing.tiers.master`), but before this module that tier only shaped
 * delegated children (`model_tier: "master"`) and never the root session. That
 * mismatch is why "fixing" the master model in omo.jsonc appeared to revert:
 * the real default kept coming from `opencode.json`, so any regeneration or
 * stale copy of that file silently restored an old model (DeepSeek V4 instead
 * of V4.1 Flash).
 *
 * The single source of truth for the master default is now:
 *
 *   [opencode].model_routing.tiers.master = { model, inherit_parent: false }
 *
 * `resolveConfiguredMasterModel` is pure so it can be regression-tested without
 * a plugin runtime. `applyConfiguredMasterModel` mutates the OpenCode config in
 * place at config-load time, on every server start, so restart, new shell, new
 * tmux session, compaction, watchdog recovery, and config regeneration all
 * converge on the same model. It is a no-op when no explicit master pin exists,
 * which keeps the plugin from overriding a user who deliberately wants to
 * inherit OpenCode's model.
 */
export function resolveConfiguredMasterModel(
  modelRouting: ModelRoutingConfig | undefined,
): string | undefined {
  const master = modelRouting?.tiers?.master
  if (!master) return undefined
  if (master.inherit_parent !== false) return undefined
  const model = master.model
  if (typeof model !== "string") return undefined
  const trimmed = model.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function applyConfiguredMasterModel(
  config: Record<string, unknown>,
  pluginConfig: { model_routing?: ModelRoutingConfig } | undefined,
): string | undefined {
  const configured = resolveConfiguredMasterModel(pluginConfig?.model_routing)
  if (!configured) return undefined
  const previous = typeof config.model === "string" ? config.model : undefined
  if (previous === configured) return configured
  config.model = configured
  log("[master-model-authority] applied configured master model", {
    model: configured,
    previous: previous ?? null,
  })
  return configured
}
