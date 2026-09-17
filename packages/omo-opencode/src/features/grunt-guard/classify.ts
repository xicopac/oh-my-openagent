/**
 * Deterministic semantic classifier for the hard worker-first gate. Distinguishes
 * harmless orchestration/metadata from broad delegable repository work, WITHOUT any
 * model call. Classification is cheap, regex-only, and conservative: it only marks
 * an operation as delegable exploration when the signal is unambiguous — unknown
 * operations default to `control` so a false positive can never deadlock MAIN.
 */

import type { GruntToolHint } from "./gate"

/** Semantics of a bash `command` string (the `bash` tool's single argument). */
export type ShellSemantics =
  | "metadata"
  | "narrow_read"
  | "discovery"
  | "investigation"
  | "test_build"
  | "implementation"
  | "control"

/** Rolled-up operation class consumed by the worker-first state machine. */
export type OperationClass =
  | "control"
  | "metadata"
  | "narrow"
  | "broad"
  | "implementation"
  | "test_build"
  | "delegation"

const DELEGATION_TOOL_NAMES = new Set(["task", "call_omo_agent"])

const CONTROL_TOOL_NAMES = new Set([
  "background_output",
  "background_cancel",
  "session_list",
  "session_read",
  "session_search",
  "session_info",
  "skill",
  "skill_mcp",
  "todowrite",
  "todo_write",
  "question",
  "ask_user_question",
  "interactive_bash",
  "create_goal",
  "update_goal",
  "get_goal",
  "monitor_start",
  "monitor_stop",
  "monitor_list",
  "monitor_output",
  "look_at",
  "lsp_status",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "lsp_prepare_rename",
  "lsp_rename",
  "lsp_install_decision",
  "skill_mcp",
])

// Command keywords that unambiguously mean broad/recursive source discovery.
const DISCOVERY_COMMANDS: RegExp[] = [
  /\bgrep\s+-[a-zA-Z]*[Rr]\b/,          // grep -R / grep -r / rgrep
  /(^|\s)(rg|ripgrep|ack|ag|fd|tree|locate)\b/,
  /(^|\s)find\b/,
  /\bls\s+.*-R\b/,                       // ls -R (recursive)
  /\bfind\b.*-type\s+f/,
  /for\s+\w+\s+in\s+\$\(find\b/,
]

const INVESTIGATION_COMMANDS: RegExp[] = [
  /\bdocker\s+(inspect|logs|exec|ps|events|top|diff|stats|compose.*logs)\b/,
  /\bkubectl\s+(logs|describe|exec|get\s+-o\s+yaml)\b/,
  /(^|\s)(strace|gdb|lldb)\s/,
  /(^|\s)(journalctl|tail\s+-f|debugfs)\s/,
  /\bssh\s+.*(gdb|strace|tcpdump)\b/,
]

const TEST_BUILD_COMMANDS: RegExp[] = [
  /\bbun\s+(test|run\s+(build|test|typecheck|typecheck:packages))\b/,
  /\bnpm\s+(test|run\s+(build|test))\b/,
  /\byarn\s+(test|build)\b/,
  /\bpnpm\s+(test|build)\b/,
  /(^|\s)(jest|vitest|mocha|ava)\s/,
  /(^|\s)pytest\s/,
  /\bcargo\s+(test|build|check)\b/,
  /\bgo\s+(test|build)\b/,
  /(^|\s)(tsc|tsgo|npx\s+tsc)\s/,
  /\bmake\s+(test|build)\b/,
  /\bgcc\s/,
  /\bmvn\s+(test|package|compile)\b/,
]

const IMPLEMENTATION_COMMANDS: RegExp[] = [
  /\bsed\s+(-i|--in-place)\b/,
  /\bperl\s+(-pi|-pi\.\w+| -pie)\b/,
  /\bnpm\s+(install|i|add|ci)\s/,
  /\bbun\s+(add|install)\s/,
  /\bpip\s+install\b/,
  /\byarn\s+add\b/,
  /\bcargo\s+add\b/,
  /\bgo\s+get\b/,
  /\bmake\s+install\b/,
  /\bcat\s+<<\s*['"]?[-A-Za-z0-9_]+['"]?\s*>\s*\S+/,
  />\s*\/?[A-Za-z0-9_.\-/]+\s*\$?/,
]

const METADATA_COMMANDS: RegExp[] = [
  /^git\s+(status|log|diff|show|rev-parse|branch|remote|config|stash|tag|describe|shortlog|blame|mergetool|reflog|worktree|ls-files|check-ignore)\b/,
  /^git\s+(--version|init|help)\b/,
  /^git\s+diff\s+--stat\b/,
  /^pwd\s*$/,
  /^ls\b(?!.*-R)/,
  /^echo\s/,
  /^which\s/,
  /^(node|bun|deno|npm|yarn|pnpm|python|python3|go|rustc|cargo|java|git)\s+(-v|--version)\b/,
  /^whoami\s*$/,
  /^hostname\s*$/,
  /^uname\s/,
  /^env\s/,
  /^printenv\s/,
]

const NARROW_READ_COMMANDS: RegExp[] = [
  /^(cat|less|head|tail)\s+\/?[A-Za-z0-9_.\-/]+\s*$/,
  /^sed\s+(-n\s+)?(['"][^'"]*['"]\s+)?[A-Za-z0-9_.\-/]+\s*$/,
]

function firstMatch(command: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(command)) return true
  }
  return false
}

function isMultiFileCat(command: string): boolean {
  const trimmed = command.trim()
  if (!/^(cat|head|tail)\b/.test(trimmed)) return false
  // Count file-like tokens after the command (exclude flags).
  const tokens = trimmed.split(/\s+/).slice(1).filter((t) => !t.startsWith("-"))
  return tokens.length > 1
}

/**
 * Classify a raw bash command string into a semantic bucket. Deterministic and
 * regex-only. Priority: investigation > discovery > test_build > implementation >
 * metadata > narrow_read, with the multi-file cat refinement before narrow_read.
 */
export function classifyShellCommand(command: string | undefined): ShellSemantics {
  if (!command || command.length === 0) return "control"
  const trimmed = command.trim()

  if (firstMatch(trimmed, INVESTIGATION_COMMANDS)) return "investigation"
  if (firstMatch(trimmed, DISCOVERY_COMMANDS)) return "discovery"
  if (firstMatch(trimmed, TEST_BUILD_COMMANDS)) return "test_build"
  if (firstMatch(trimmed, IMPLEMENTATION_COMMANDS)) return "implementation"
  if (firstMatch(trimmed, METADATA_COMMANDS)) return "metadata"
  if (isMultiFileCat(trimmed)) return "discovery"
  if (firstMatch(trimmed, NARROW_READ_COMMANDS)) return "narrow_read"

  return "control"
}

const SHELL_TO_OPERATION: Record<ShellSemantics, OperationClass> = {
  metadata: "metadata",
  narrow_read: "narrow",
  discovery: "broad",
  investigation: "broad",
  test_build: "test_build",
  implementation: "implementation",
  control: "control",
}

/**
 * Classify an incoming root tool call (name + optional hint) into an operation
 * class. The `hint.command` carries the raw bash command for `bash` calls so the
 * semantic classifier can inspect it (MAIN must not bypass the gate through Bash).
 */
export function classifyOperation(tool: string | undefined, hint?: GruntToolHint): OperationClass {
  const name = (tool ?? "").toLowerCase()

  if (DELEGATION_TOOL_NAMES.has(name)) return "delegation"
  if (name.startsWith("team_")) return "control"

  if (CONTROL_TOOL_NAMES.has(name)) return "control"

  if (name === "bash") {
    return SHELL_TO_OPERATION[classifyShellCommand(hint?.command)]
  }

  if (name === "grep") {
    // A scoped grep (specific path) is a narrow lookup; an unscoped grep across
    // the whole working tree is broad discovery.
    return hint?.target ? "narrow" : "broad"
  }
  if (name === "glob") return "broad"
  if (name === "read") return "narrow"
  if (name === "session_read") return "control"

  if (name === "edit" || name === "write") return "implementation"

  return "control"
}
