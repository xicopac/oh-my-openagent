import { posix } from "node:path"

import type { GruntToolHint } from "../grunt-guard"

export type MaterializationScopeCategory = "materialization"

export type MaterializationScopeDecision = {
  allowed: boolean
  category?: MaterializationScopeCategory
  reason?: string
}

type MaterializationHint = GruntToolHint & {
  materialization?: boolean
}

export const MATERIALIZATION_PATH_MARKERS = [
  ".omo/handoffs/",
  ".omo/evidence/",
  ".omo/state/",
  ".omo/plans/",
] as const

const MATERIALIZATION_DIRECTORIES = new Set(["handoffs", "evidence", "state", "plans"])

function normalizePath(value: string): string | null {
  let normalized = value.trim().replaceAll("\\", "/")
  if (normalized.length === 0 || normalized.includes("\0") || /[\r\n]/.test(normalized)) return null
  if (
    normalized.length >= 2
    && ((normalized.startsWith("'") && normalized.endsWith("'"))
      || (normalized.startsWith('"') && normalized.endsWith('"')))
  ) {
    normalized = normalized.slice(1, -1)
  }
  normalized = posix.normalize(normalized)
  if (normalized === ".." || normalized.startsWith("../")) return null
  return normalized
}

export function isMaterializationPath(value: string | undefined): boolean {
  if (!value) return false
  const normalized = normalizePath(value)
  if (!normalized) return false
  const segments = normalized.split("/").filter(Boolean)
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === ".omo" && MATERIALIZATION_DIRECTORIES.has(segments[index + 1] ?? "")) {
      return true
    }
  }
  return false
}

function allow(category: MaterializationScopeCategory, reason: string): MaterializationScopeDecision {
  return { allowed: true, category, reason }
}

function deny(reason: string): MaterializationScopeDecision {
  return { allowed: false, reason }
}

function tokenizeMechanicalCommand(command: string): string[] | null {
  if (/[`$*?\[\]{}<>]/.test(command)) return null
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

function pathArguments(words: readonly string[]): string[] {
  return words.filter((word) => word !== "--" && !word.startsWith("-"))
}

function isMechanicalSegment(segment: string): boolean {
  const words = tokenizeMechanicalCommand(segment.trim())
  if (!words || words.length === 0) return false
  const [command, ...args] = words

  if (command === "mkdir") {
    if (args.some((arg) => arg.startsWith("-") && arg !== "-p" && arg !== "--parents")) return false
    const targets = pathArguments(args)
    return targets.length > 0 && targets.every(isMaterializationPath)
  }

  if (["stat", "sha256sum", "sha1sum", "md5sum", "ls", "cat", "head", "tail"].includes(command ?? "")) {
    const targets = pathArguments(args)
    return targets.length > 0 && targets.every(isMaterializationPath)
  }

  if (command === "cp" || command === "mv") {
    const targets = pathArguments(args)
    if (targets.length < 2) return false
    if (command === "mv") return targets.every(isMaterializationPath)
    return isMaterializationPath(targets[targets.length - 1])
  }

  return false
}

function allBashSegmentsAllowed(command: string): MaterializationScopeDecision {
  if (command.includes("|") || command.includes("&")) {
    return deny("materialization_requires_mechanical_command")
  }
  const segments = command
    .split(/(?:;|\r?\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean)

  if (segments.length === 0 || !segments.every(isMechanicalSegment)) {
    return deny("materialization_requires_mechanical_command")
  }
  return allow("materialization", "materialization_command")
}

export function evaluateMaterializationScope(
  tool: string | undefined,
  hint: MaterializationHint = {},
): MaterializationScopeDecision {
  const name = (tool ?? "").trim().toLowerCase()

  if (name === "task" || name === "call_omo_agent" || name.startsWith("team_")) {
    return deny("materialization_never_delegates")
  }

  if (name === "write" || name === "edit") {
    return isMaterializationPath(hint.target)
      ? allow("materialization", "materialization_write")
      : deny("materialization_target_outside_allowed_paths")
  }

  if (name === "apply_patch") {
    const targets = hint.materializationTargets ?? []
    if (hint.materializationDestructive === true) {
      return deny("materialization_patch_delete_denied")
    }
    return targets.length > 0 && targets.every(isMaterializationPath)
      ? allow("materialization", "materialization_patch")
      : deny("materialization_target_outside_allowed_paths")
  }

  if (name === "mkdir") {
    return isMaterializationPath(hint.target)
      ? allow("materialization", "materialization_directory")
      : deny("materialization_target_outside_allowed_paths")
  }

  if (name === "bash") return allBashSegmentsAllowed(hint.command ?? "")

  if (name === "read") {
    return isMaterializationPath(hint.target)
      ? allow("materialization", "materialization_verify")
      : deny("materialization_target_outside_allowed_paths")
  }

  return deny("materialization_scope_tool_denied")
}
