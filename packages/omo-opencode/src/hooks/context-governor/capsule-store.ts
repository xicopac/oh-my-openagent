import { createHash } from "node:crypto"

import {
  readJsonTolerant,
  sweepStaleTemps,
  writeAtomicJson,
} from "../../shared/atomic-fs"
import { CapsuleSchema, type Capsule } from "./capsule-schema"

/**
 * Base64url-encode a session id so it can be embedded in a filesystem path
 * without any traversal, colon, or space concern. Uses Node's built-in
 * base64url encoding (RFC 4648 §5): no `+`, `/`, or `=` padding.
 */
export function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url")
}

/**
 * Reverse of encodeSessionId. Throws a clear Error on input that is not
 * valid base64url; NEVER returns garbage. Detection is by encode-roundtrip:
 * base64url is unique per byte sequence, so re-encoding the decoded bytes
 * must reproduce the input exactly.
 */
export function decodeSessionId(encoded: string): string {
  const buf = Buffer.from(encoded, "base64url")
  const reEncoded = buf.toString("base64url")
  if (reEncoded !== encoded) {
    throw new Error(`invalid session id: not valid base64url (${encoded})`)
  }
  return buf.toString("utf8")
}

/**
 * Filesystem path where the capsule for `sessionId` lives, under
 * `${directory}/.omo/context-twin/<encoded>/capsule.json`. The session id
 * is base64url-encoded first so the raw id can NEVER appear as a path
 * segment (defense-in-depth against `../` and platform-specific reserved
 * characters).
 */
export function capsulePath(directory: string, sessionId: string): string {
  const encoded = encodeSessionId(sessionId)
  return `${directory}/.omo/context-twin/${encoded}/capsule.json`
}

/**
 * Load an existing capsule from disk, tolerating missing and malformed
 * files. Returns null when the file is missing, unparseable, or fails
 * schema validation (schema drift → treat as "no capsule").
 */
export function readCapsule(directory: string, sessionId: string): Capsule | null {
  const raw = readJsonTolerant(capsulePath(directory, sessionId))
  if (raw === null) return null
  const parsed = CapsuleSchema.safeParse(raw)
  if (!parsed.success) return null
  return parsed.data
}

export type WriteCapsuleOptions = {
  now?: Date
}

/**
 * Persist a capsule for `sessionId`. Merges `patch` over the existing
 * capsule (or a fully-defaulted skeleton when none exists), bumps
 * `capsule_revision`, stamps `updated_at`, and computes a deterministic
 * `capsule_hash` over the canonical serialization.
 *
 * writeCapsule is the ONE authority that increments `capsule_revision`;
 * callers that want a read-modify-write cycle should use `updateCapsule`
 * (which delegates here without double-incrementing).
 *
 * Writes are atomic and sweep stale `capsule.json.tmp-*` leftovers from
 * previous crashes before writing.
 */
export function writeCapsule(
  directory: string,
  sessionId: string,
  patch: Partial<Capsule> & { session_id?: string },
  options: WriteCapsuleOptions = {},
): Capsule {
  const existing = readCapsule(directory, sessionId) ?? CapsuleSchema.parse({})
  const now = options.now ?? new Date()

  const merged: Capsule = CapsuleSchema.parse({
    ...existing,
    ...patch,
    session_id: sessionId,
    capsule_revision: existing.capsule_revision + 1,
    updated_at: now.toISOString(),
    capsule_hash: "",
  })

  const hash = computeCapsuleHash(merged)
  const finalized: Capsule = { ...merged, capsule_hash: hash }

  const path = capsulePath(directory, sessionId)
  const parent = path.substring(0, path.lastIndexOf("/"))
  sweepStaleTemps(parent, "capsule.json")
  writeAtomicJson(path, finalized)
  return finalized
}

/**
 * Read-modify-write helper. Reads the current capsule (or a defaulted
 * skeleton), applies `patch`, and hands the result to writeCapsule. Because
 * writeCapsule owns revision incrementing, updateCapsule does NOT bump the
 * revision itself; the patch function should treat `capsule_revision` and
 * `capsule_hash` as write-through fields.
 */
export function updateCapsule(
  directory: string,
  sessionId: string,
  patch: (current: Capsule) => Capsule,
  options: WriteCapsuleOptions = {},
): Capsule {
  const current = readCapsule(directory, sessionId) ?? CapsuleSchema.parse({})
  const patched = patch(current)
  return writeCapsule(directory, sessionId, patched, options)
}

/**
 * SHA-256 hex over a canonical JSON serialization of the capsule with the
 * `capsule_hash` field zeroed (so the hash covers everything except itself)
 * and with all object keys sorted recursively. Same payload → same hash on
 * every host, regardless of insertion order.
 */
function computeCapsuleHash(capsule: Capsule): string {
  const withZeroHash: Capsule = { ...capsule, capsule_hash: "" }
  const canonical = stableStringify(withZeroHash)
  return createHash("sha256").update(canonical).digest("hex")
}

/**
 * Deterministic JSON.stringify: recursively sorts object keys, leaves
 * arrays in order, and stringifies primitives via `JSON.stringify`. Small
 * local helper - a full dependency for this is overkill.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const body = entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")
  return `{${body}}`
}
