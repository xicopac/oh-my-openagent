/**
 * Deterministic semantic classifier for the hard worker-first gate. Distinguishes
 * harmless orchestration/metadata from broad delegable repository work, WITHOUT any
 * model call. Classification is cheap and conservative. Equivalent effects receive
 * the same class across native and shell spellings, while opaque/unknown execution
 * fails closed as implementation instead of silently becoming control-plane work.
 */

import type { GruntToolHint } from "./gate"
import { isMcpPrefixedTool } from "./detector"

/** Semantics of a bash `command` string (the `bash` tool's single argument). */
export type ShellSemantics =
  | "metadata"
  | "diagnostic"
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
const IMPLEMENTATION_TOOL_NAMES = new Set(["edit", "write", "multiedit", "apply_patch", "mkdir"])
const BROAD_TOOL_NAMES = new Set(["glob", "webfetch", "websearch"])
const NARROW_TOOL_NAMES = new Set(["read"])
const SHELL_TOOL_NAMES = new Set(["bash", "interactive_bash"])

const CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "background_output",
  "background_cancel",
  "session_list",
  "session_read",
  "session_search",
  "session_info",
  "skill",
  "skill_mcp",
  "look_at",
  "todowrite",
  "todo_write",
  "question",
  "ask_user_question",
  "create_goal",
  "update_goal",
  "get_goal",
  "monitor_start",
  "monitor_stop",
  "monitor_list",
  "monitor_output",
  "task_create",
  "task_get",
  "task_list",
  "task_update",
  "lsp_status",
  "lsp_diagnostics",
  "lsp_goto_definition",
  "lsp_find_references",
  "lsp_symbols",
  "lsp_prepare_rename",
  "lsp_rename",
  "lsp_install_decision",
])

/** Semantics of a bash `command` string (the `bash` tool's single argument). */
const DISCOVERY_COMMANDS: RegExp[] = [
  /\bgrep\s+-[a-zA-Z]*[Rr]\b/,          // grep -R / grep -r / rgrep
  /(^|\s)grep\b/,
  /(^|\s)(rg|ripgrep|ack|ag|fd|tree|locate)\b/,
  /(^|\s)find\b/,
  /\bls\s+.*-R\b/,                       // ls -R (recursive)
  /\bfind\b.*-type\s+f/,
  /for\s+\w+\s+in\s+\$\(find\b/,
]

const INVESTIGATION_COMMANDS: RegExp[] = [
  /(^|\s)(strace|gdb|lldb)\s/,
  /(^|\s)(tail\s+-f|debugfs)\s/,
  /\bssh\s+.*(gdb|strace|tcpdump)\b/,
]

const DIAGNOSTIC_COMMANDS: RegExp[] = [
  /^docker\s+(inspect|logs|ps|top|diff)\b/,
  /^docker\s+compose\b.*\blogs\b/,
  /^kubectl\s+(logs|describe|get)\b/,
  /^(journalctl|ps|pgrep|pstree|ss|netstat|lsof|df|du|free|uptime|vmstat|iostat)\b/,
  /^systemctl\s+(status|show|is-active|is-failed)\b/,
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
  /^(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|ln|install|truncate|tee|dd|patch)\b/,
  /^(docker|kubectl)\s+exec\b/,
  /^(python|python3|node|nodejs|deno|ruby|php|osascript)\b(?!\s+(-v|--version|-V)\b)/,
  /^(bun|npx|pnpm|yarn)\s+(-e|--eval)\b/,
  /\bcat\s+<<\s*['"]?[-A-Za-z0-9_]+['"]?\s*>\s*\S+/,
]

const METADATA_COMMANDS: RegExp[] = [
  /^git\s+(status|log|diff|show|rev-parse|describe|shortlog|blame|reflog|ls-files|check-ignore)\b/,
  /^git\s+(--version|help)\b/,
  /^git\s+branch(?:\s+(?:--show-current|--list|-l|-a|-r|-v|-vv|--contains|--merged|--no-merged)\b)*\s*$/,
  /^git\s+remote(?:\s+-v|\s+get-url\b.*)?\s*$/,
  /^git\s+config\s+(--get|--get-all|--get-regexp|--list|--show-origin)\b/,
  /^git\s+worktree\s+list\b/,
  /^git\s+tag\s+(--list|-l)\b/,
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
  /^(cat|less)\s+(?:--\s+)?\/?[A-Za-z0-9_.\-/]+\s*$/,
  /^(head|tail)\s+(?:(?:-n\s+|-)[0-9]+\s+)?\/?[A-Za-z0-9_.\-/]+\s*$/,
  /^sed\s+(?:-n\s+)?(?:['"]?[^'"\s]+['"]?\s+)?[A-Za-z0-9_.\-/]+\s*$/,
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

const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "dash", "ksh"])
const SIMPLE_WRAPPERS = new Set(["command", "exec", "nohup", "time"])
const ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=/

const SHELL_SEMANTICS_PRIORITY: Record<ShellSemantics, number> = {
  control: 0,
  metadata: 1,
  diagnostic: 2,
  narrow_read: 3,
  test_build: 4,
  implementation: 5,
  discovery: 6,
  investigation: 7,
}

function tokenizeShellWords(command: string): string[] | null {
  const words: string[] = []
  let word = ""
  let quote: "'" | '"' | null = null
  let escaped = false

  const flush = (): void => {
    if (word.length > 0) words.push(word)
    word = ""
  }

  for (const char of command) {
    if (escaped) {
      word += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    word += char
  }

  if (escaped || quote !== null) return null
  flush()
  return words
}

function unwrapShellSegment(command: string): string | null {
  let current = command.trim()
  for (let depth = 0; depth < 8; depth += 1) {
    const words = tokenizeShellWords(current)
    if (!words || words.length === 0) return words ? "" : null

    while (words.length > 0 && ASSIGNMENT_TOKEN.test(words[0] ?? "")) words.shift()
    const executable = words[0]
    if (!executable) return ""

    if (executable === "sudo") return null

    if (executable === "env") {
      words.shift()
      while (words.length > 0) {
        const token = words[0] ?? ""
        if (ASSIGNMENT_TOKEN.test(token) || token === "--") {
          words.shift()
          continue
        }
        if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
          if (words.length < 2) return null
          words.splice(0, 2)
          continue
        }
        if (token.startsWith("--unset=") || token.startsWith("--chdir=")) {
          words.shift()
          continue
        }
        if (token.startsWith("-")) return null
        break
      }
      current = words.join(" ")
      continue
    }

    if (SIMPLE_WRAPPERS.has(executable)) {
      words.shift()
      while ((words[0] ?? "").startsWith("-")) words.shift()
      current = words.join(" ")
      continue
    }

    if (executable === "timeout") {
      words.shift()
      while ((words[0] ?? "").startsWith("-")) {
        const option = words.shift() ?? ""
        if (option === "-k" || option === "--kill-after" || option === "-s" || option === "--signal") {
          if (words.length === 0) return null
          words.shift()
        }
      }
      if (words.length < 2) return null
      words.shift()
      current = words.join(" ")
      continue
    }

    if (executable === "nice") {
      words.shift()
      if (words[0] === "-n" || words[0] === "--adjustment") {
        if (words.length < 3) return null
        words.splice(0, 2)
      } else if ((words[0] ?? "").startsWith("--adjustment=")) {
        words.shift()
      }
      current = words.join(" ")
      continue
    }

    if (executable === "stdbuf") {
      words.shift()
      while (/^-[ioe]/.test(words[0] ?? "")) words.shift()
      current = words.join(" ")
      continue
    }

    if (executable === "setsid") {
      words.shift()
      while ((words[0] ?? "").startsWith("-")) words.shift()
      current = words.join(" ")
      continue
    }

    if (SHELL_EXECUTABLES.has(executable)) {
      let commandIndex = -1
      for (let index = 1; index < words.length; index += 1) {
        const token = words[index] ?? ""
        if (token === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(token)) {
          commandIndex = index + 1
          break
        }
      }
      if (commandIndex < 0 || commandIndex >= words.length) return null
      current = words[commandIndex] ?? ""
      continue
    }

    return current
  }
  return null
}

function stripSafeRedirects(command: string): string {
  return command
    .replace(/\s+2\s*>\s*\/dev\/null(?=\s|$)/g, " ")
    .replace(/\s+2\s*>\s*&\s*1(?=\s|$)/g, " ")
    .replace(/\s+1\s*>\s*\/dev\/null(?=\s|$)/g, " ")
}

function scanShellSegments(command: string): { segments: string[]; opaque: boolean } {
  const segments: string[] = []
  let segment = ""
  let quote: "'" | '"' | null = null
  let escaped = false

  const flush = (): void => {
    const trimmed = segment.trim()
    if (trimmed) segments.push(trimmed)
    segment = ""
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ""
    const next = command[index + 1] ?? ""
    if (escaped) {
      segment += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      segment += char
      escaped = true
      continue
    }
    if (quote !== null) {
      segment += char
      if (char === quote) quote = null
      else if (quote === '"' && (char === "`" || (char === "$" && next === "("))) {
        return { segments: [], opaque: true }
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      segment += char
      continue
    }
    if (char === "`" || ((char === "$" || char === "<" || char === ">") && next === "(")) {
      return { segments: [], opaque: true }
    }
    if (char === "<" || char === ">") return { segments: [], opaque: true }
    if (char === ";" || char === "\n" || char === "|" || (char === "&" && next === "&")) {
      flush()
      if ((char === "|" || char === "&") && next === char) index += 1
      continue
    }
    segment += char
  }

  if (escaped || quote !== null) return { segments: [], opaque: true }
  flush()
  return { segments, opaque: false }
}

function classifySimpleSegment(command: string): ShellSemantics {
  if (firstMatch(command, INVESTIGATION_COMMANDS)) return "investigation"
  if (firstMatch(command, DISCOVERY_COMMANDS)) return "discovery"
  if (firstMatch(command, TEST_BUILD_COMMANDS)) return "test_build"
  if (firstMatch(command, IMPLEMENTATION_COMMANDS)) return "implementation"
  if (firstMatch(command, DIAGNOSTIC_COMMANDS)) return "diagnostic"
  if (firstMatch(command, METADATA_COMMANDS)) return "metadata"
  if (isMultiFileCat(command)) return "discovery"
  if (firstMatch(command, NARROW_READ_COMMANDS)) return "narrow_read"
  return "implementation"
}

/**
 * Classify a raw bash command string into a semantic bucket. Deterministic and
 * wrapper-aware. Shell substitutions, malformed quoting, redirection to a file,
 * and commands whose effects are not known are classified as implementation.
 */
export function classifyShellCommand(command: string | undefined): ShellSemantics {
  if (!command || command.length === 0) return "control"
  const scan = scanShellSegments(stripSafeRedirects(command.trim()))
  if (scan.opaque) return "implementation"

  let mostRestrictive: ShellSemantics = "control"
  for (const raw of scan.segments) {
    const unwrapped = unwrapShellSegment(raw)
    if (unwrapped === null) return "implementation"
    const innerScan = scanShellSegments(stripSafeRedirects(unwrapped))
    if (innerScan.opaque) return "implementation"
    for (const inner of innerScan.segments) {
      const semantics = classifySimpleSegment(inner)
      if (SHELL_SEMANTICS_PRIORITY[semantics] > SHELL_SEMANTICS_PRIORITY[mostRestrictive]) {
        mostRestrictive = semantics
      }
    }
  }
  return mostRestrictive
}

const SHELL_TO_OPERATION: Record<ShellSemantics, OperationClass> = {
  metadata: "metadata",
  diagnostic: "metadata",
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

  // MCP-prefixed tools are opaque to the classifier. An MCP `task`/`call_omo_agent`
  // alias is still delegation; every other MCP tool is treated as broad so a root
  // session cannot use an MCP bridge to bypass the delegation gate.
  if (isMcpPrefixedTool(name)) {
    const bare = name.replace(/^mcp[_-]+/i, "")
    if (DELEGATION_TOOL_NAMES.has(bare)) return "delegation"
    return isKnownOperationTool(bare) ? classifyOperation(bare, hint) : "broad"
  }

  // `interactive_bash` must be classified through the shell semantic classifier,
  // same as `bash`, so root cannot bypass the gate through interactive bash.
  if (name === "interactive_bash") {
    return hint?.command ? SHELL_TO_OPERATION[classifyShellCommand(hint.command)] : "broad"
  }

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

  if (IMPLEMENTATION_TOOL_NAMES.has(name)) return "implementation"

  if (name === "webfetch" || name === "websearch") return "broad"

  return "implementation"
}

/** True when an `mcp_` prefix is a compatibility alias for a known local tool. */
export function isKnownOperationTool(tool: string | undefined): boolean {
  const name = (tool ?? "").toLowerCase()
  return DELEGATION_TOOL_NAMES.has(name)
    || CONTROL_TOOL_NAMES.has(name)
    || IMPLEMENTATION_TOOL_NAMES.has(name)
    || BROAD_TOOL_NAMES.has(name)
    || NARROW_TOOL_NAMES.has(name)
    || SHELL_TOOL_NAMES.has(name)
    || name === "grep"
    || name.startsWith("team_")
}
