import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Filesystem-safe single path segment for a session id. Base64url-encodes the
 * raw id so it can never contain a path separator, `..`, a leading dot, or any
 * platform-reserved character. Mirrors the existing `encodeSessionId` used by
 * the context-twin capsule/lease stores so governance paths remain consistent
 * with the rest of the OMA runtime state layout.
 */
export function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

/**
 * Resolve the root directory of the persistent governance audit journal.
 *
 * Precedence:
 *   1. explicit `override` (used by tests and DI call sites)
 *   2. `OMO_GOVERNANCE_DIR` env var (used by QA sandboxes / tooling)
 *   3. `~/.omo/governance` (the user's OMA state directory)
 *
 * The journal is deliberately stored OUTSIDE the repository and OUTSIDE the
 * OpenCode data dir: it is OMA-owned runtime state that must survive session
 * completion and OpenCode restart.
 */
export function resolveGovernanceRoot(override?: string | null): string {
  if (override) return override
  const env = process.env.OMO_GOVERNANCE_DIR
  if (env && env.length > 0) return env
  return join(homedir(), ".omo", "governance")
}

/**
 * Directory holding a single session's journal, under
 * `<root>/<base64url(sessionID)>/`. Encoded first so the raw session id never
 * appears as a path segment (defense-in-depth against traversal and reserved
 * characters); the raw id is still recorded verbatim in the `session_id` field
 * of every event line.
 */
export function sessionJournalDir(root: string, sessionID: string): string {
  return join(root, encodeSegment(sessionID))
}

/**
 * Absolute path to a session's `events.jsonl` journal.
 */
export function sessionJournalPath(root: string, sessionID: string): string {
  return join(sessionJournalDir(root, sessionID), "events.jsonl")
}
