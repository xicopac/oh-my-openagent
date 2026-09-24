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

function normalizePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^['"]|['"]$/g, "")
  return normalized.startsWith("./") ? normalized.slice(2) : normalized
}

export function isMaterializationPath(value: string | undefined): boolean {
  if (!value) return false
  const normalized = normalizePath(value)
  const padded = normalized.startsWith("/") ? normalized : `/${normalized}`
  return MATERIALIZATION_PATH_MARKERS.some(
    (marker) => normalized.includes(marker) || padded.includes(marker),
  )
}

function allow(category: MaterializationScopeCategory, reason: string): MaterializationScopeDecision {
  return { allowed: true, category, reason }
}

function deny(reason: string): MaterializationScopeDecision {
  return { allowed: false, reason }
}

function allBashSegmentsAllowed(command: string): MaterializationScopeDecision {
  const segments = command
    .split(/(?:&&|\|\||;|\r?\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean)

  if (segments.length === 0) return deny("materialization_requires_mechanical_command")

  for (const segment of segments) {
    // Strip pipes for mechanical verification commands
    const pipelineParts = segment.split("|").map((p) => p.trim()).filter(Boolean)
    // If pipeline, every part must be mechanical; otherwise check single segment
    if (pipelineParts.length > 1) {
      const allMechanical = pipelineParts.every((part) => isMechanicalSegment(part))
      if (!allMechanical) return deny("materialization_requires_mechanical_command")
      continue
    }
    if (!isMechanicalSegment(segment)) return deny("materialization_requires_mechanical_command")
  }
  return allow("materialization", "materialization_command")
}

function isMechanicalSegment(segment: string): boolean {
  const s = segment.trim()
  // mkdir -p <materialization-path>
  if (/^mkdir\s+-p\s+/.test(s)) {
    const pathPart = s.replace(/^mkdir\s+-p\s+/, "").trim().replace(/^['"]|['"]$/g, "")
    // extract first path token (before space/flags)
    const target = pathPart.split(/\s+/)[0] ?? ""
    if (isMaterializationPath(target)) return true
    // Also check if raw segment contains marker anywhere (handles absolute)
    if (isMaterializationPath(s)) return true
    return false
  }
  // read/hash/stat/list commands where arg is materialization path
  if (/^(?:stat|sha256sum|sha1sum|md5sum|ls|cat|head|tail)\b/.test(s)) {
    if (isMaterializationPath(s)) return true
    return false
  }
  // mv / cp where destination is materialization path
  if (/^(?:mv|cp)\b/.test(s)) {
    // naive: check if destination (last path-like token) is materialization path
    // Also check if any marker present and destination contains it
    if (isMaterializationPath(s)) {
      // Need to ensure destination is materialization path, not just source
      // Split on whitespace, last token is dest
      const tokens = s.split(/\s+/).filter((t) => !t.startsWith("-") && t.length > 0)
      // tokens[0] is mv/cp, last is dest
      const dest = tokens[tokens.length - 1] ?? ""
      const cleaned = dest.replace(/^['"]|['"]$/g, "")
      if (isMaterializationPath(cleaned) || isMaterializationPath(s)) {
        // For safety: if s contains marker, we consider mv/cp allowed when dest is allowed
        // Check last token specifically
        if (isMaterializationPath(cleaned)) return true
        // Fallback: if s contains marker but dest extraction failed, deny
        return false
      }
    }
    return false
  }
  return false
}

export function evaluateMaterializationScope(
  tool: string | undefined,
  hint: MaterializationHint = {},
): MaterializationScopeDecision {
  if (hint.materialization !== true) {
    return deny("materialization_not_requested")
  }

  const name = (tool ?? "").trim().toLowerCase()

  // Never delegate/control tools
  if (name === "task" || name === "call_omo_agent" || name.startsWith("team_")) {
    return deny("materialization_never_delegates")
  }

  if (name === "write" || name === "edit") {
    return isMaterializationPath(hint.target)
      ? allow("materialization", "materialization_write")
      : deny("materialization_target_outside_allowed_paths")
  }

  if (name === "mkdir") {
    // mkdir tool with target path
    return isMaterializationPath(hint.target)
      ? allow("materialization", "materialization_directory")
      : deny("materialization_target_outside_allowed_paths")
  }

  if (name === "bash") {
    return allBashSegmentsAllowed(hint.command ?? "")
  }

  if (name === "read") {
    return isMaterializationPath(hint.target)
      ? allow("materialization", "materialization_verify")
      : deny("materialization_target_outside_allowed_paths")
  }

  return deny("materialization_scope_tool_denied")
}
