import type { OhMyOpenCodeConfig } from "./config"
import type { ModelCacheState } from "./plugin-state"
import type { PluginContext, TmuxConfig } from "./plugin/types"

import type { SubagentSessionCreatedEvent } from "./features/background-agent"
import { BackgroundManager } from "./features/background-agent"
import type { MonitorManager } from "./features/monitor"
import { createMonitorManager } from "./features/monitor"
import { SkillMcpManager } from "./features/skill-mcp-manager"
import { cleanupSessionTeamRuns } from "./features/team-mode/team-runtime/session-cleanup"
import { lookupTeamSession } from "./features/team-mode/team-session-registry"
import { TuiStateMirror } from "./features/tui-sidebar/mirror-manager"
import { createModelFallbackControllerAccessor } from "./hooks/model-fallback"
import { initTaskToastManager } from "./features/task-toast-manager"
import {
  selectTmuxManagerEnvironmentPredicate,
  TmuxSessionManager,
} from "./features/tmux-subagent"
import * as openclawRuntimeDispatch from "./openclaw/runtime-dispatch"
import { registerManagerForCleanup } from "./features/background-agent/process-cleanup"
import { createConfigHandler } from "./plugin-handlers"
import { log } from "./shared"
import { createGovernanceAuditWriter } from "./shared/governance-audit"
import { markServerRunningInProcess } from "./shared/tmux/tmux-utils/server-health"
import type { ModelFallbackControllerAccessor } from "./hooks/model-fallback"
import { authorizeChildDispatch, createResourceGovernorRuntime, loadPricingCatalog, type ResourceGovernorRuntime } from "./hooks/resource-governor"
import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "./features/delegation-first"

type CreateManagersDeps = {
  BackgroundManagerClass: typeof BackgroundManager
  SkillMcpManagerClass: typeof SkillMcpManager
  TmuxSessionManagerClass: typeof TmuxSessionManager
  TuiStateMirrorClass: typeof TuiStateMirror
  createMonitorManagerFn: typeof createMonitorManager
  initTaskToastManagerFn: typeof initTaskToastManager
  registerManagerForCleanupFn: typeof registerManagerForCleanup
  cleanupSessionTeamRunsFn: typeof cleanupSessionTeamRuns
  createConfigHandlerFn: typeof createConfigHandler
  markServerRunningInProcessFn: typeof markServerRunningInProcess
}

const defaultCreateManagersDeps: CreateManagersDeps = {
  BackgroundManagerClass: BackgroundManager,
  SkillMcpManagerClass: SkillMcpManager,
  TmuxSessionManagerClass: TmuxSessionManager,
  TuiStateMirrorClass: TuiStateMirror,
  createMonitorManagerFn: createMonitorManager,
  initTaskToastManagerFn: initTaskToastManager,
  registerManagerForCleanupFn: registerManagerForCleanup,
  cleanupSessionTeamRunsFn: cleanupSessionTeamRuns,
  createConfigHandlerFn: createConfigHandler,
  markServerRunningInProcessFn: markServerRunningInProcess,
}

export type Managers = {
  tmuxSessionManager: TmuxSessionManager
  backgroundManager: BackgroundManager
  skillMcpManager: SkillMcpManager
  configHandler: ReturnType<typeof createConfigHandler>
  modelFallbackControllerAccessor: ModelFallbackControllerAccessor
  tuiStateMirror?: TuiStateMirror
  monitorManager?: MonitorManager
  /** Shared Resource Governor runtime; present when resource_governor.enabled. */
  resourceGovernorRuntime?: ResourceGovernorRuntime
  /** Delegation-first (ladder + watchdog + grunt guard) runtime; lives over the audit journal. */
  delegationFirstRuntime?: DelegationFirstRuntime
  /** Stops the periodic watchdog sweep timer (if started). */
  stopWatchdogSweep?: () => void
  /** Live OpenGateway pricing catalog (shared by the governor and delegation-first selection). */
  pricingCatalog?: ReturnType<typeof loadPricingCatalog>
}

export function createManagers(args: {
  ctx: PluginContext
  pluginConfig: OhMyOpenCodeConfig
  tmuxConfig: TmuxConfig
  modelCacheState: ModelCacheState
  backgroundNotificationHookEnabled: boolean
  runtimeSkillSourceUrl?: string
  deps?: Partial<CreateManagersDeps>
}): Managers {
  const { ctx, pluginConfig, tmuxConfig, modelCacheState, backgroundNotificationHookEnabled, runtimeSkillSourceUrl } = args
  const deps = { ...defaultCreateManagersDeps, ...args.deps }

  // Only mark the server as in-process when the SDK actually exposes a
  // serverUrl. `tmuxConfig.enabled` alone is not proof of a running server —
  // a vanilla `opencode` session (no `opencode serve`/`opencode web`) leaves
  // `ctx.serverUrl` undefined, and marking it running would make
  // `isServerRunning` short-circuit to true. That bypasses the guard in
  // `createTeamLayout` and lets it spawn tmux panes whose `opencode attach`
  // command then fails because nothing is actually listening on the
  // fallback port (issue #3894).
  if (tmuxConfig.enabled && ctx.serverUrl) {
    deps.markServerRunningInProcessFn()
  }
  const tmuxSessionManager = new deps.TmuxSessionManagerClass(ctx, tmuxConfig, {
    isInsideTmux: selectTmuxManagerEnvironmentPredicate(tmuxConfig.isolation),
  }, {
    // Team-mode members get their tmux panes from team-layout-tmux, which
    // owns the lifecycle via runtimeState.tmuxLayout. Telling the subagent
    // manager to ignore those sessions prevents the polling loop from racing
    // pane closes against team-layout and stops them from being surfaced
    // twice in the subagent panel.
    shouldSkipSession: (sessionId) => lookupTeamSession(sessionId) !== undefined,
  })
  const modelFallbackControllerAccessor = createModelFallbackControllerAccessor()
  const governanceAudit = pluginConfig.resource_governor?.enabled
    ? createGovernanceAuditWriter({})
    : undefined
  const pricingCatalog = loadPricingCatalog()
  const resourceGovernorRuntime = pluginConfig.resource_governor?.enabled
    ? createResourceGovernorRuntime({
        config: pluginConfig.resource_governor,
        pricing: pricingCatalog,
        activeChildCount: (sessionID) =>
          (backgroundManager?.getTasksByParentSession(sessionID) ?? [])
            .filter((t) => t.status === "running" || t.status === "pending")
            .length,
        audit: governanceAudit,
        onEvent: (sessionID, event, detail) => {
          log(`[resource-governor] ${event}`, { sessionID, ...(detail ?? {}) })
        },
      })
    : undefined

  const delegationLadderCfg = pluginConfig.resource_governor?.delegation_ladder
  const watchdogCfg = pluginConfig.resource_governor?.watchdog
  const delegationFirstRuntime = pluginConfig.resource_governor?.enabled
    ? createDelegationFirstRuntime(governanceAudit, {
        ladder: delegationLadderCfg
          ? {
            max_attempts_per_tier: delegationLadderCfg.max_attempts_per_tier,
            max_free_attempts_total: delegationLadderCfg.max_free_attempts_total,
            escalate_after_attempts: delegationLadderCfg.escalate_after_attempts,
          }
          : undefined,
        watchdog: watchdogCfg
          ? {
            startupGraceMs: watchdogCfg.startup_grace_ms,
            quietStallThresholdMs: watchdogCfg.quiet_stall_threshold_ms,
            wedgedThresholdMs: watchdogCfg.wedged_threshold_ms,
          }
          : undefined,
        pricing: pricingCatalog,
      })
    : undefined

  // Periodic metadata-only watchdog sweep. Each check reads progress counters
  // only and makes zero model calls, so the sweep is effectively free.
  let stopWatchdogSweep: (() => void) | undefined
  if (delegationFirstRuntime && watchdogCfg?.enabled !== false) {
    const sweepIntervalMs = Math.max(watchdogCfg?.quiet_stall_threshold_ms ?? 180_000, 5_000) / 6
    const timer = setInterval(() => {
      try {
        delegationFirstRuntime.checkAllWatchdogs()
      } catch (error) {
        log("[create-managers] watchdog sweep error:", { error })
      }
    }, sweepIntervalMs)
    if (typeof timer.unref === "function") timer.unref()
    stopWatchdogSweep = () => {
      clearInterval(timer)
    }
  }
  let backgroundManager: BackgroundManager | undefined
  let tuiStateMirror: TuiStateMirror | undefined

  const monitorManager = pluginConfig.monitor?.enabled
    ? deps.createMonitorManagerFn({
      pluginContext: { client: ctx.client, directory: ctx.directory },
      config: pluginConfig.monitor,
    })
    : undefined

  const cleanupTeamModeRuns = async (): Promise<void> => {
    if (!pluginConfig.team_mode?.enabled) return
    const report = await deps.cleanupSessionTeamRunsFn({
      config: pluginConfig.team_mode,
      tmuxMgr: tmuxSessionManager,
      bgMgr: backgroundManager,
    })
    if (report.cleanedTeamRunIds.length > 0 || report.errors.length > 0) {
      log("[create-managers] team-mode session cleanup complete", report)
    }
  }

  deps.registerManagerForCleanupFn({
    shutdown: async () => {
      tuiStateMirror?.stop()
      stopWatchdogSweep?.()
      await cleanupTeamModeRuns().catch((error) => {
        log("[create-managers] team-mode cleanup error during process shutdown:", error)
      })
      await tmuxSessionManager.cleanup().catch((error) => {
        log("[create-managers] tmux cleanup error during process shutdown:", error)
      })
      await monitorManager?.shutdown().catch((error) => {
        log("[create-managers] monitor cleanup error during process shutdown:", error)
      })
    },
  })

  backgroundManager = new deps.BackgroundManagerClass({
    pluginContext: ctx,
    config: pluginConfig.background_task,
    tmuxConfig,
    onSubagentSessionCreated: async (event: SubagentSessionCreatedEvent) => {
        log("[create-managers] onSubagentSessionCreated callback received", {
          sessionID: event.sessionID,
          parentID: event.parentID,
          title: event.title,
        })

        delegationFirstRuntime?.attachChildSession(event.parentID, event.sessionID)

        await tmuxSessionManager.onSessionCreated({
          type: "session.created",
          properties: {
            info: {
              id: event.sessionID,
              parentID: event.parentID,
              title: event.title,
            },
          },
        })

        if (pluginConfig.openclaw) {
          await openclawRuntimeDispatch.dispatchOpenClawEvent({
            config: pluginConfig.openclaw,
            rawEvent: "session.created",
            context: {
              sessionId: event.sessionID,
              projectPath: ctx.directory,
              tmuxPaneId: tmuxSessionManager.getTrackedPaneId?.(event.sessionID) ?? process.env.TMUX_PANE,
            },
          })
        }

        log("[create-managers] onSubagentSessionCreated callback completed")
    },
    onSubagentSessionDeleted: async (event: { sessionID: string }) => {
      log("[create-managers] onSubagentSessionDeleted callback received", {
        sessionID: event.sessionID,
      })

      delegationFirstRuntime?.watchdogTerminal(event.sessionID)
      delegationFirstRuntime?.detachChildSession(event.sessionID)

      await tmuxSessionManager.onSessionDeleted(event).catch((error) => {
        log("[create-managers] onSubagentSessionDeleted callback error:", {
          sessionID: event.sessionID,
          error: String(error),
        })
      })

      log("[create-managers] onSubagentSessionDeleted callback completed")
    },
    onShutdown: async () => {
      tuiStateMirror?.stop()
      stopWatchdogSweep?.()
      await cleanupTeamModeRuns().catch((error) => {
        log("[create-managers] team-mode cleanup error during shutdown:", error)
      })
      await tmuxSessionManager.cleanup().catch((error) => {
        log("[create-managers] tmux cleanup error during shutdown:", error)
      })
      await monitorManager?.shutdown().catch((error) => {
        log("[create-managers] monitor cleanup error during shutdown:", error)
      })
    },
    enableParentSessionNotifications: backgroundNotificationHookEnabled,
    modelFallbackControllerAccessor,
    authorizeChildDispatch: resourceGovernorRuntime
      ? (input) => authorizeChildDispatch(resourceGovernorRuntime, input)
      : undefined,
    resourceGovernorDefaultChildTokens: pluginConfig.resource_governor?.delegation.default_child_tokens,
    settleChildDispatch: resourceGovernorRuntime
      ? (sessionID, escrowID, status) => resourceGovernorRuntime.settleChild(sessionID, escrowID, status)
      : undefined,
    launchGuard: resourceGovernorRuntime?.launchGuard,
  })

  if (pluginConfig.tui?.sidebar?.enabled !== false) {
    tuiStateMirror = new deps.TuiStateMirrorClass({
      client: ctx.client,
      projectDir: ctx.directory,
      backgroundManager,
    })
    tuiStateMirror.start()
  }

  deps.initTaskToastManagerFn(ctx.client)

  const skillMcpManager = new deps.SkillMcpManagerClass()

  const configHandler = deps.createConfigHandlerFn({
    ctx: { directory: ctx.directory, client: ctx.client },
    pluginConfig,
    modelCacheState,
    runtimeSkillSourceUrl,
  })
  return {
    tmuxSessionManager,
    backgroundManager,
    skillMcpManager,
    configHandler,
    modelFallbackControllerAccessor,
    tuiStateMirror,
    monitorManager,
    resourceGovernorRuntime,
    delegationFirstRuntime,
    stopWatchdogSweep,
    pricingCatalog,
  }
}
