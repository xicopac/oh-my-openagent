import { appendFileSync, chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import {
  resolveGovernanceRoot,
  sessionJournalPath,
} from "./paths"
import {
  DEFAULT_RETENTION,
  pruneGovernanceJournals,
  type RetentionPolicy,
} from "./retention"

/**
 * Persistent, zero-model-token governance audit journal.
 *
 * A writer is a thin, deterministic append-only facade over
 * `<root>/<sessionID>/events.jsonl`. It makes no model calls, performs no
 * summarization, and never asks an agent to report its own state: every event
 * is serialized directly from runtime values handed to `write`.
 *
 * Guarantees:
 *   - one event = one JSON object = one line (newline-delimited JSON)
 *   - writes are serialized per session (no interleaved/corrupted lines)
 *   - directories are created 0700, files 0600 (defense-in-depth)
 *   - sensitive keys are stripped defensively
 *   - a writer failure never propagates to the caller (log-and-drop)
 */

export type GovernanceAuditWriterOptions = {
  /** Explicit root override (tests). Defaults to `~/.omo/governance`. */
  root?: string | null
  /** Partial retention policy override. */
  retention?: Partial<RetentionPolicy>
  /** Injectable clock (tests). */
  now?: () => Date
  /** Error sink when an append fails; never consulted for the happy path. */
  onError?: (error: unknown, sessionID: string) => void
}

export type GovernanceAuditWriter = {
  /** Append one structured event for `sessionID`. Never throws. */
  write: (sessionID: string, fields: Record<string, unknown>) => void
  /** Absolute path to `sessionID`'s journal (whether or not it exists yet). */
  path: (sessionID: string) => string
  /** Drain all in-flight appends. Useful for tests and orderly shutdown. */
  flush: () => Promise<void>
}

/**
 * Keys that MUST never appear in an audit record. Matched case-insensitively
 * against the top-level field name. This is defense-in-depth: call sites are
 * already expected to pass only identifiers/counters/decisions, but a stray
 * prompt/response/token dump must not reach disk even on a bug.
 */
const SENSITIVE_KEYS = new Set([
  "prompt",
  "messages",
  "output",
  "content",
  "text",
  "transcript",
  "response",
  "api_key",
  "apikey",
  "token",
  "tokens",
  "secret",
  "password",
  "authorization",
  "auth",
  "credentials",
  "reasoning",
  "chain_of_thought",
  "hidden_reasoning",
  "internal_scratch",
  "scratchpad",
  "reasoning_trace",
  "cot",
  "private_notes",
])

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

export function createGovernanceAuditWriter(
  options: GovernanceAuditWriterOptions = {},
): GovernanceAuditWriter {
  const root = resolveGovernanceRoot(options.root)
  const retention: RetentionPolicy = { ...DEFAULT_RETENTION, ...options.retention }
  const nowFn = options.now ?? (() => new Date())

  // One-time best-effort retention sweep per writer instance (cheap readdir;
  // idempotent across co-existing writers sharing one root).
  pruneGovernanceJournals(root, retention, nowFn())

  // Per-session serialized append queues. Node is single-threaded, but events
  // from parallel workers/governor hooks can interleave at the await boundary,
  // so each session chains its appends through a promise to preserve ordering.
  const queues = new Map<string, Promise<void>>()

  function appendLine(path: string, line: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, line, { encoding: "utf-8", flag: "a", mode: 0o600 })
    // appendFileSync's mode only applies on file creation; tighten an existing
    // file's perms so a pre-created loose file is corrected on next append.
    try {
      chmodSync(path, 0o600)
    } catch {
      // best-effort; not safety-critical on every platform
    }
  }

  function enqueue(sessionID: string, line: string): void {
    const prev = queues.get(sessionID) ?? Promise.resolve()
    const next = prev.then(() => {
      try {
        appendLine(sessionJournalPath(root, sessionID), line)
      } catch (error) {
        options.onError?.(error, sessionID)
      }
    })
    queues.set(sessionID, next)
    // Release the resolved chain so the map does not grow unboundedly.
    const release = () => {
      if (queues.get(sessionID) === next) queues.delete(sessionID)
    }
    next.then(release, release)
  }

  return {
    write(sessionID, fields) {
      let line: string
      try {
        line = JSON.stringify({
          timestamp: nowFn().toISOString(),
          session_id: sessionID,
          ...sanitizeFields(fields),
        })
      } catch {
        return // non-serializable value; drop rather than crash the session
      }
      enqueue(sessionID, `${line}\n`)
    },
    path: (sessionID) => sessionJournalPath(root, sessionID),
    flush: async () => {
      const pending = Array.from(queues.values())
      queues.clear()
      await Promise.all(pending)
    },
  }
}
