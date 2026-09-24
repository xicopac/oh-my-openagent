import { classifyShellCommand } from "../grunt-guard"
import { classifyToolSegment, PRIORITY } from "./patterns"

export type ResourceClass = "light" | "build" | "test" | "gradle" | "emulator" | "heavy"

export interface NormalizedCommand {
  command: string
  timeoutSec?: number
}

const TIMEOUT_WRAPPER_RE = /^timeout\s+(?:-[a-zA-Z0-9]+\s+)*(\d+(?:\.\d+)?[smhd]?)\s+/
const TIMEOUT_VALUE_RE = /^(\d+(?:\.\d+)?)([smhd]?)$/
const SHELL_COMMAND_RE = /^(?:bash|sh)\s+-c\s+(.*)$/s
const CD_PREFIX_RE = /^cd\s+\S+\s*(?:&&|;)\s+/
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELL_WRAPPERS = new Set(["sudo", "nice", "nohup", "time"])
const CONTROL_PLANE_TOOLS = new Set([
  "sleep", "true", "false", "date", "uptime", "time", "ps", "pstree", "top", "htop",
])
const OPTIONS_WITH_VALUES = new Set([
  "-u",
  "--user",
  "-g",
  "--group",
  "-n",
  "--adjustment",
  "--unset",
  "-S",
  "--split-string",
])

function parseTimeoutValue(raw: string): number | undefined {
  const match = raw.match(TIMEOUT_VALUE_RE)
  const numeric = match?.[1]
  if (numeric === undefined) return undefined
  const value = Number(numeric)
  if (!Number.isFinite(value) || value <= 0) return undefined
  const unit = match?.[2] ?? ""
  const multiplier = unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86400 : 1
  const rounded = Math.round(value * multiplier)
  return rounded > 0 ? Math.min(rounded, 86400) : undefined
}

function unwrapShellCommand(command: string): string {
  const match = command.match(SHELL_COMMAND_RE)
  const rest = match?.[1]?.trim() ?? ""
  if (!rest) return command
  const first = rest[0]
  const last = rest[rest.length - 1]
  if ((first === "'" || first === '"') && first === last) return rest.slice(1, -1)
  return /&&|;|\n/.test(rest) ? command : rest
}

export function stripGnuTimeout(command: string): string {
  const trimmed = command.trim()
  const timeoutMatch = trimmed.match(TIMEOUT_WRAPPER_RE)
  if (!timeoutMatch) return trimmed
  return trimmed.slice(timeoutMatch[0].length).trimStart()
}

export function normalizeShellCommand(command: string): NormalizedCommand {
  const timeoutSec = parseTimeoutValue(command.trim().match(TIMEOUT_WRAPPER_RE)?.[1] ?? "")
  const withoutTimeout = stripGnuTimeout(command)
  const normalized = unwrapShellCommand(withoutTimeout).replace(CD_PREFIX_RE, "").trim()
  return timeoutSec === undefined ? { command: normalized } : { command: normalized, timeoutSec }
}

function optionConsumesValue(option: string): boolean {
  return !option.includes("=") && OPTIONS_WITH_VALUES.has(option)
}

function wrapperTokenStart(tokens: readonly string[], wrapper: "env" | "shell"): number {
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index] ?? ""
    if (token.startsWith("-")) {
      index += 1
      if (optionConsumesValue(token) && index < tokens.length) index += 1
      continue
    }
    if (wrapper === "env" && ASSIGNMENT_RE.test(token)) {
      index += 1
      continue
    }
    break
  }
  return index
}

function stripLeadingWrappers(segment: string): string {
  let tokens = segment.trim().split(/\s+/).filter(Boolean)
  while (tokens.length > 0) {
    const first = (tokens[0] ?? "").toLowerCase()
    if (first === "env") {
      tokens = tokens.slice(wrapperTokenStart(tokens, "env"))
      continue
    }
    if (SHELL_WRAPPERS.has(first)) {
      tokens = tokens.slice(wrapperTokenStart(tokens, "shell"))
      continue
    }
    break
  }
  return tokens.join(" ")
}

function parseToolAndArgs(segment: string): { tool: string; args: string[] } | null {
  const stripped = stripLeadingWrappers(segment)
  const unwrapped = /^(?:bash|sh)\s+-c\s+/.test(stripped) ? unwrapShellCommand(stripped) : stripped
  const tokens = unwrapped.split(/\s+/).filter(Boolean)
  const firstToken = tokens[0]
  if (firstToken === undefined) return null
  const tool = firstToken.startsWith("./") ? firstToken.slice(2) : firstToken
  return { tool, args: tokens.slice(1) }
}

function isLightShellCommand(command: string): boolean {
  const semantics = classifyShellCommand(command)
  return semantics === "metadata" || semantics === "narrow_read"
}

function isControlPlaneCommand(command: string): boolean {
  const segments = command.split(/&&|;|\n/)
  for (const segment of segments) {
    const parsed = parseToolAndArgs(segment)
    if (parsed === null) return false
    if (!CONTROL_PLANE_TOOLS.has(parsed.tool)) return false
  }
  return true
}

export function classifyResourceCommand(command: string): ResourceClass {
  if (isLightShellCommand(command)) return "light"
  const normalized = normalizeShellCommand(command)
  if (isLightShellCommand(normalized.command)) return "light"

  let best: ResourceClass | null = null
  let bestPriority = 0
  for (const segment of normalized.command.split(/&&|;|\n/)) {
    const parsed = parseToolAndArgs(segment)
    if (!parsed) continue
    const kind = classifyToolSegment(parsed.tool, parsed.args)
    if (!kind) continue
    const priority = PRIORITY[kind]
    if (priority > bestPriority) {
      best = kind
      bestPriority = priority
    }
  }
  if (best !== null) return best
  if (isControlPlaneCommand(normalized.command)) return "light"
  return "heavy"
}
