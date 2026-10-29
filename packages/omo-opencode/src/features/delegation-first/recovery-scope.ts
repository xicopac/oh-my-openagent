/**
 * Delegation-recovery scope.
 *
 * While a root session is in `recovery_mode` the delegation control plane itself
 * is under repair, so the root is authorized to act DIRECTLY — but only inside
 * the delegation machinery and its supporting state. This module decides, with
 * no model call, whether an incoming tool call is inside that scope.
 *
 * The allowance matrix is deliberately narrow:
 *   - metadata/inspection commands (git status/log/rev-parse, pwd, ls, ps, ...)
 *   - reads of config/state files under `.omo/`, `.opencode/`, `.agents/`,
 *     `~/.config/opencode/` (governor config, omo config, skill/agent state)
 *   - repairs to the delegation/watchdog/supervisor source and to config/state
 *   - evidence writes under `/tmp` and `~/.omo`
 *   - the single machine-consumed recovery `task` probe (never ordinary delegation)
 *   - orchestration-unit cleanup (restart/stop the scoped opencode/omo/senpi systemd units;
 *     process-wide signals such as pkill are never in scope because they can kill another
 *     live session's host)
 *
 * Human-operated recovery procedure (when machine evidence has NOT promoted the
 * session to `recovery_mode`, e.g. a cold control plane): an operator explicitly
 * authorizes the repair and disables the delegation governor for the session.
 *   1. `grantHumanAuthorization(sessionID, { scope, reason })` (trusted channel),
 *      or set `resource_governor.enabled = false` in the session's omo config.
 *   2. Run the real recovery probe through `task`; verification/re-handoff exits
 *      recovery (`markRecoveryVerified` -> `reconcileStaleRecovery`/handoff).
 *   3. Re-enable the governor once delegation is observed healthy.
 * Recovery exits automatically once delegation is healthy again; no operator
 * action is required for the ordinary (evidence-driven) case.
 */

import type { GruntToolHint } from "../grunt-guard"

export type RecoveryScopeCategory =
  | "inspection"
  | "repair"
  | "validation"
  | "cleanup"
  | "verification"

export type RecoveryScopeDecision = {
  allowed: boolean
  category: RecoveryScopeCategory | null
  reason: string
}

type RecoveryHint = GruntToolHint & {
  recoveryProbe?: boolean
}

const CONTROL_TOOLS = new Map<string, RecoveryScopeCategory>([
  ["background_output", "inspection"],
  ["background_cancel", "cleanup"],
  ["session_list", "inspection"],
  ["session_read", "inspection"],
  ["session_search", "inspection"],
  ["session_info", "inspection"],
  ["todowrite", "inspection"],
  ["monitor_start", "inspection"],
  ["monitor_stop", "cleanup"],
  ["monitor_list", "inspection"],
  ["monitor_output", "inspection"],
  ["lsp_status", "inspection"],
  ["lsp_diagnostics", "validation"],
])

const RECOVERY_PATH_MARKERS = [
  "/.omo/",
  "/.opencode/",
  "/.agents/",
  "packages/omo-opencode/src/features/delegation-first",
  "packages/omo-opencode/src/features/worker-supervisor",
  "packages/omo-opencode/src/features/background-agent",
  "packages/omo-opencode/src/features/grunt-guard",
  "packages/omo-opencode/src/features/heavy-command-routing",
  "packages/omo-opencode/src/hooks/resource-governor",
  "packages/omo-opencode/src/hooks/runtime-fallback",
  "packages/omo-opencode/src/tools/delegate-task",
  "packages/omo-opencode/src/tools/background-task",
  "packages/omo-opencode/src/shared/governance-audit",
  "packages/omo-opencode/src/plugin",
  "packages/omo-opencode/src/hooks",
  "packages/omo-opencode/src/tools",
  "packages/omo-opencode/src/create-managers.ts",
  "packages/omo-opencode/src/create-tools.ts",
  "packages/delegate-core/",
  "packages/team-core/",
  "packages/senpi-task/src/",
  "script/e2e-routing",
  "script/agent/",
  "/proc/",
  "/sys/fs/cgroup/",
  "/run/user/",
  "/var/log/",
  "/tmp/",
  "/var/tmp/",
  "/.config/opencode/",
  "/tmp/oh-my-opencode",
] as const

const EXACT_RECOVERY_PATHS = new Set([
  ".omo",
  ".opencode",
  ".agents",
  "packages/omo-opencode/src/create-managers.ts",
  "packages/omo-opencode/src/create-tools.ts",
  "script/e2e-routing.ts",
])

const SAFE_VALIDATION_COMMANDS = [
  /^(?:env\s+\S+=\S+\s+)*bun\s+test(?:\s|$)/,
  /^(?:env\s+\S+=\S+\s+)*bun\s+run\s+(?:build|typecheck|typecheck:packages|test:e2e-routing|test:fast)(?:\s|$)/,
  /^(?:env\s+\S+=\S+\s+)*(?:tsgo|tsc)\s+/,
  /^bash\s+\.agents\/skills\/opencode-qa\/scripts\//,
] as const

const SAFE_INSPECTION_COMMANDS = [
  /^git\s+(?:status|diff|log|show|branch|rev-parse|worktree)(?:\s|$)/,
  /^(?:ps|pgrep|pstree)(?:\s|$)/,
  /^systemctl(?:\s+--user)?\s+(?:status|show|is-active|list-units)(?:\s|$)/,
  /^journalctl(?:\s|$)/,
  /^docker\s+(?:ps|logs|inspect|top|stats)(?:\s|$)/,
  /^tmux\s+(?:ls|list-sessions|list-panes|capture-pane)(?:\s|$)/,
  /^opencode\s+(?:models|doctor|debug|db|session)(?:\s|$)/,
  /^(?:stat|readlink|realpath|pwd|whoami|id|hostname|uname|ls)(?:\s|$)/,
] as const

const SAFE_ORCHESTRATION_PROCESS_MUTATIONS = [
  /^systemctl(?:\s+--user)?\s+(?:restart|start|stop|reset-failed)\s+[\w@.-]*(?:opencode|omo|oh-my-openagent|senpi|lsp-daemon)[\w@.-]*(?:\.service)?$/,
] as const

function normalizePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^['"]|['"]$/g, "")
  return normalized.startsWith("./") ? normalized.slice(2) : normalized
}

function isRecoveryPath(value: string | undefined): boolean {
  if (!value) return false
  const normalized = normalizePath(value)
  if (EXACT_RECOVERY_PATHS.has(normalized)) return true
  const padded = normalized.startsWith("/") ? normalized : `/${normalized}`
  return RECOVERY_PATH_MARKERS.some((raw) => {
    const marker = raw.replace(/\/+$/, "")
    if (!marker) return false
    const withSlash = `${marker}/`
    // Relative forms: bare hint equals its marker, or extends under it.
    if (normalized === marker) return true
    if (normalized.startsWith(withSlash)) return true
    if (normalized.includes(withSlash)) return true
    // Absolute forms: same checks against the leading-slash-padded target,
    // plus a bare directory at the end of an absolute path.
    if (padded === marker) return true
    if (padded.startsWith(withSlash)) return true
    if (padded.includes(withSlash)) return true
    const markerSlashed = marker.startsWith("/") ? marker : `/${marker}`
    if (padded === markerSlashed) return true
    if (padded.startsWith(`${markerSlashed}/`)) return true
    if (padded.includes(`${markerSlashed}/`)) return true
    if (padded.endsWith(markerSlashed)) return true
    return false
  })
}

function allow(category: RecoveryScopeCategory, reason: string): RecoveryScopeDecision {
  return { allowed: true, category, reason }
}

function deny(reason: string): RecoveryScopeDecision {
  return { allowed: false, category: null, reason }
}

function commandMatches(command: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(command))
}

function allCommandSegmentsAllowed(command: string): RecoveryScopeDecision {
  const segments = command
    .split(/(?:&&|\|\||;|\r?\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean)

  if (segments.length === 0) return deny("empty_recovery_command")

  let category: RecoveryScopeCategory = "inspection"
  for (const segment of segments) {
    if (commandMatches(segment, SAFE_VALIDATION_COMMANDS)) {
      category = "validation"
      continue
    }
    if (commandMatches(segment, SAFE_INSPECTION_COMMANDS)) continue
    if (commandMatches(segment, SAFE_ORCHESTRATION_PROCESS_MUTATIONS)) {
      category = "cleanup"
      continue
    }

    const pipeline = segment.split("|").map((part) => part.trim()).filter(Boolean)
    const pipelineAllowed = pipeline.length > 1 && pipeline.every((part) =>
      commandMatches(part, SAFE_INSPECTION_COMMANDS)
      || /^(?:grep|rg|head|tail|sed\s+-n|awk|cut|sort|uniq|jq)(?:\s|$)/.test(part)
      || isRecoveryPath(part),
    )
    if (pipelineAllowed) continue

    if (isRecoveryPath(segment) && /^(?:ls|find|rg|grep|cat|head|tail|sed\s+-n|test)(?:\s|$)/.test(segment)) {
      continue
    }
    return deny("command_outside_delegation_recovery_scope")
  }

  return allow(category, `${category}_command`)
}

export function evaluateRecoveryScope(
  tool: string | undefined,
  hint: RecoveryHint = {},
): RecoveryScopeDecision {
  const name = (tool ?? "").trim().toLowerCase()

  if (name === "task") {
    return hint.recoveryProbe === true
      ? allow("verification", "authorized_recovery_probe")
      : deny("ordinary_delegation_is_not_recovery_verification")
  }
  if (name === "call_omo_agent") return deny("recovery_probe_requires_production_task_path")

  const controlCategory = CONTROL_TOOLS.get(name)
  if (controlCategory) return allow(controlCategory, `${controlCategory}_tool`)

  if (name === "read" || name === "grep" || name === "glob") {
    return isRecoveryPath(hint.target)
      ? allow("inspection", "recovery_path_inspection")
      : deny("target_outside_delegation_recovery_scope")
  }

  if (name === "edit" || name === "write") {
    return isRecoveryPath(hint.target)
      ? allow("repair", "recovery_path_repair")
      : deny("target_outside_delegation_recovery_scope")
  }

  if (name === "bash") {
    return allCommandSegmentsAllowed(hint.command ?? "")
  }

  return deny("tool_outside_delegation_recovery_scope")
}
