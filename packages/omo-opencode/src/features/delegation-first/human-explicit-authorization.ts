/**
 * Human explicit authorization — delegation-first is an orchestration policy,
 * not a security boundary. When the actual human instructs the root
 * orchestrator to perform a scoped action, the watchdog must not force
 * delegation for that same action.
 *
 * This module is the single source for the claim/grant model and its
 * conservative user-message detector. Grants are session-bound, scoped, and
 * auditable; tool input alone can never mint a grant.
 */

export const HUMAN_AUTHORIZATION_SOURCE = "human_explicit" as const

export type HumanAuthorizationScopeKind = "path-prefix" | "task-label"

export type HumanExplicitAuthorization = {
  id: string
  source: typeof HUMAN_AUTHORIZATION_SOURCE
  scope: string
  scopeKind: HumanAuthorizationScopeKind
  reason: string
  grantedAtMs: number
  allowedTools?: string[]
}

export type HumanAuthorizationClaim = {
  scope: string
  reason: string
}

export type HumanAuthorizationAction = {
  tool?: string
  target?: string
  command?: string
}

function normalizePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^['"]|['"]$/g, "")
  const withoutDot = normalized.startsWith("./") ? normalized.slice(2) : normalized
  return withoutDot.replace(/\/+/g, "/").replace(/\/$/, "") || "/"
}

function isPathUnder(candidate: string, prefix: string): boolean {
  const nCandidate = normalizePath(candidate)
  const nPrefix = normalizePath(prefix)
  if (nCandidate === nPrefix) return true
  // ensure prefix boundary
  if (nCandidate.startsWith(nPrefix + "/")) return true
  // for absolute/relative mismatch, also check suffix containment for backward compat
  // but primary check is prefix; caller may also allow substring for bash commands
  return false
}

function isActionCoveredByPathPrefix(actionPath: string, grantScope: string): boolean {
  const nGrant = normalizePath(grantScope)
  const normalized = actionPath.trim().replaceAll("\\", "/")
  // Direct path check
  if (isPathUnder(normalized, nGrant)) return true
  // For bash commands, check if the command string contains the granted prefix as a path substring
  if (normalized.includes(nGrant)) {
    // Ensure it's a path-like containment, not a random substring
    // If grant contains slash, containment is sufficient for bash
    if (nGrant.includes("/")) return true
  }
  // Also try extracting file-like tokens from command
  const tokens = normalized.split(/[\s"'`]+/).filter(Boolean)
  for (const tok of tokens) {
    if (isPathUnder(tok, nGrant)) return true
  }
  return false
}

export type HumanAuthorizationRegistry = {
  grant(sessionID: string, auth: HumanExplicitAuthorization): void
  coveringAuthorization(
    sessionID: string,
    claim: HumanAuthorizationClaim | undefined | null,
    action: HumanAuthorizationAction,
  ): HumanExplicitAuthorization | undefined
  authorizations(sessionID: string): readonly HumanExplicitAuthorization[]
  clear(sessionID?: string): void
}

export function createHumanAuthorizationRegistry(): HumanAuthorizationRegistry {
  const bySession = new Map<string, HumanExplicitAuthorization[]>()

  return {
    grant(sessionID, auth) {
      if (!sessionID || !auth || !auth.scope || !auth.reason) return
      const existing = bySession.get(sessionID) ?? []
      // dedupe by id
      if (existing.some((a) => a.id === auth.id)) return
      existing.push({ ...auth })
      bySession.set(sessionID, existing)
    },
    coveringAuthorization(sessionID, claim, action) {
      if (!claim || typeof claim.scope !== "string" || typeof claim.reason !== "string") return undefined
      const claimScope = claim.scope.trim()
      const claimReason = claim.reason.trim()
      if (claimScope.length === 0 || claimReason.length === 0) return undefined
      const grants = bySession.get(sessionID)
      if (!grants || grants.length === 0) return undefined
      for (const grant of grants) {
        if (grant.scopeKind === "path-prefix") {
          if (!isPathUnder(claimScope, grant.scope)) continue
          const ap = action.target ?? action.command
          if (!ap) continue
          if (!isActionCoveredByPathPrefix(ap, grant.scope)) continue
          // also ensure claim scope covers action
          if (!isActionCoveredByPathPrefix(ap, claimScope) && !isPathUnder(ap, claimScope)) {
            // if claim scope is narrower than grant, action must be inside claim scope too
            // but we already checked grant contains both; this adds strictness
            // allow if action inside grant and claim inside grant; still require action roughly inside claim
            // For conservative check, if action not inside claim, deny
            if (!isActionCoveredByPathPrefix(ap, claimScope)) continue
          }
          return grant
        }
        if (grant.scopeKind === "task-label") {
          if (claimScope !== grant.scope) continue
          if (!grant.allowedTools || grant.allowedTools.length === 0) continue
          const tool = (action.tool ?? "").toLowerCase()
          if (!tool) continue
          const allowed = grant.allowedTools.map((t) => t.toLowerCase())
          if (!allowed.includes(tool)) continue
          return grant
        }
      }
      return undefined
    },
    authorizations(sessionID) {
      return [...(bySession.get(sessionID) ?? [])]
    },
    clear(sessionID) {
      if (sessionID) bySession.delete(sessionID)
      else bySession.clear()
    },
  }
}

/**
 * Narrow, conservative helper: derive grants from an ACTUAL USER-ROLE message.
 * Only ever inspects user-role message text; returns [] for any other role or
 * when the phrasing is ambiguous. When in doubt, grant nothing.
 *
 * Detected phrasings (case-insensitive):
 * - "i authorize ..." / "i explicitly authorize"
 * - "you may directly ..." / "you are authorized to directly"
 * - "fix the watchdog yourself" (watchdog/control-plane task-label)
 * - "load and continue <path>" (path-prefix for that handoff)
 * - "do not delegate" / "without delegating" + scoped path/command mention
 *
 * Scoped extraction is conservative: a task-label grant carries an explicit
 * allowedTools whitelist so it cannot widen into arbitrary exploration.
 */
export function deriveHumanAuthorizationsFromUserMessage(message: {
  role: string
  content: string
}): HumanExplicitAuthorization[] {
  if (message.role !== "user") return []
  const text = message.content ?? ""
  if (text.trim().length === 0) return []
  const lower = text.toLowerCase()

  const hasExplicitAuthorizationPhrase =
    lower.includes("i authorize") ||
    lower.includes("i explicitly authorize") ||
    lower.includes("human explicit authorization") ||
    lower.includes("you may directly") ||
    lower.includes("you are authorized to directly") ||
    lower.includes("you are authorized to") && lower.includes("directly") ||
    lower.includes("do not delegate") ||
    lower.includes("without delegating") ||
    lower.includes("without delegation") ||
    lower.includes("proceed directly") ||
    lower.includes("perform this action directly") ||
    lower.includes("load and continue") ||
    lower.includes("fix the watchdog yourself")

  if (!hasExplicitAuthorizationPhrase) return []

  const grants: HumanExplicitAuthorization[] = []
  const now = Date.now()

  // Task-label: fix the watchdog yourself => watchdog/control-plane
  if (lower.includes("fix the watchdog yourself")) {
    grants.push({
      id: `human-${now}-watchdog`,
      source: HUMAN_AUTHORIZATION_SOURCE,
      scope: "watchdog/control-plane",
      scopeKind: "task-label",
      reason: "fix the watchdog yourself — direct control-plane implementation",
      grantedAtMs: now,
      allowedTools: ["read", "edit", "write", "bash"],
    })
  }

  // Path-prefix: load and continue /path/handoff.md
  // Extract the path after "load and continue"
  const loadContinueMatch = text.match(/load\s+and\s+continue\s+([^\s"'`,;]+)/i)
  if (loadContinueMatch?.[1]) {
    const rawScope = loadContinueMatch[1].trim().replace(/^['"]|['"]$/g, "")
    if (rawScope.length > 0) {
      grants.push({
        id: `human-${now}-handoff-${rawScope.slice(0, 20)}`,
        source: HUMAN_AUTHORIZATION_SOURCE,
        scope: normalizePath(rawScope),
        scopeKind: "path-prefix",
        reason: `load and continue ${rawScope}`,
        grantedAtMs: now,
      })
    }
  }

  // Generic explicit path scopes: when the user says "read /exact/path" etc.
  // Only extract if the message also contains an authorization phrase (already checked)
  // and the path looks like an absolute or .omo/packages path.
  const pathRegex = /(?:^|\s)(?:read|write|edit|run|execute)?\s*([/][^\s"'`,;]+\.[^\s"'`,;]*|\.omo\/[^\s"'`,;]+|packages\/[^\s"'`,;]+)/g
  let m: RegExpExecArray | null
  // Only grant generic path scopes when the authorization phrase is highly explicit
  const highlyExplicit =
    lower.includes("i authorize") ||
    lower.includes("i explicitly authorize") ||
    lower.includes("human explicit authorization")
  if (highlyExplicit) {
    // Use a fresh regex instance
    const re = /(?:^|\s)(?:read|write|edit|run|execute)?\s*([/][^\s"'`,;]+\.[^\s"'`,;]*|\.omo\/[^\s"'`,;]+|packages\/[^\s"'`,;]+)/gi
    while ((m = re.exec(text)) !== null) {
      const raw = m[1]?.trim().replace(/^['"]|['"]$/g, "")
      if (!raw || raw.length < 2) continue
      const normalized = normalizePath(raw)
      // Avoid duplicating load-continue grant
      if (grants.some((g) => g.scope === normalized)) continue
      // Heuristic: must be a file/dir path, not a URL
      if (raw.startsWith("http")) continue
      grants.push({
        id: `human-${now}-path-${normalized.slice(0, 24).replaceAll("/", "-")}`,
        source: HUMAN_AUTHORIZATION_SOURCE,
        scope: normalized,
        scopeKind: "path-prefix",
        reason: `explicit human authorization for ${normalized}`,
        grantedAtMs: now,
      })
    }
    // Also handle "run <specific command>" quoting a command string
    const runMatch = text.match(/run\s+["']([^"']+)["']/i) ?? text.match(/run\s+`([^`]+)`/i)
    if (runMatch?.[1]) {
      const cmdScope = runMatch[1].trim()
      if (cmdScope.length > 0 && !grants.some((g) => g.scope === cmdScope)) {
        grants.push({
          id: `human-${now}-run-${cmdScope.slice(0, 16)}`,
          source: HUMAN_AUTHORIZATION_SOURCE,
          scope: cmdScope,
          scopeKind: "path-prefix",
          reason: `explicit human authorization to run ${cmdScope}`,
          grantedAtMs: now,
        })
      }
    }
  }

  // If highly explicit but no path extracted, do not grant task-label blindly —
  // keep it conservative: return what we have (possibly just watchdog if matched)
  // Filter out overly broad scopes like "/" or "packages"
  return grants.filter((g) => {
    const s = g.scope.trim()
    if (s === "/" || s === "." || s === "packages" || s === ".omo") return false
    return s.length >= 2
  })
}

/**
 * Hard safety check — first precedence level. Narrow, deny-only. Human
 * explicit authorization must NOT override it. This is not a delegation
 * policy; it is a genuine safety/integrity boundary.
 */
export function isHardSafetyViolation(
  tool: string | undefined,
  hint?: { target?: string; command?: string },
): string | null {
  const name = (tool ?? "").toLowerCase()
  const cmd = hint?.command ?? ""
  const target = hint?.target ?? ""

  // Destructive bash patterns
  if (name === "bash" && cmd) {
    const lowerCmd = cmd.toLowerCase()
    // rm -rf / or rm -rf /*
    if (/rm\s+.*-rf\s+.*\s\/\s*(?:&&|;|\|$)/.test(cmd) || /\brm\s+-rf\s+\/\*?(\s|$)/.test(cmd) || /\brm\s+-rf\s+\/\s/.test(cmd)) {
      return "hard_safety: destructive rm -rf root"
    }
    if (/\brm\s+-rf\s+\/\s*$/.test(cmd.trim())) return "hard_safety: destructive rm -rf root"
    // mkfs, dd to disk, shred, :(){:|:&};: fork bomb
    if (/\bmkfs\./.test(lowerCmd) || /\bmkfs\b/.test(lowerCmd)) return "hard_safety: mkfs blocked"
    if (/\bdd\s+.*of=\/dev\/(sda|nvme|hda)/.test(lowerCmd)) return "hard_safety: dd to block device"
    if (lowerCmd.includes(":(){:|:&};:")) return "hard_safety: fork bomb"
    if (/\bchmod\s+.*777\s+\/\b/.test(cmd)) return "hard_safety: chmod 777 root"
    if (/\bshutdown\b/.test(lowerCmd) || /\breboot\b/.test(lowerCmd) || /\bhalt\b/.test(lowerCmd)) return "hard_safety: shutdown/reboot"
    // Writing to /etc/passwd etc via bash redirect
    if (/>\s*\/etc\/(passwd|shadow|sudoers)/.test(cmd)) return "hard_safety: overwrite system file"
  }

  // Forbidden file targets for write/edit regardless of tool
  if (target) {
    const norm = normalizePath(target).toLowerCase()
    if (norm === "/etc/passwd" || norm === "/etc/shadow" || norm === "/etc/sudoers" || norm.endsWith("/etc/passwd") || norm.endsWith("/etc/shadow")) {
      return "hard_safety: forbidden system file target"
    }
  }

  return null
}
