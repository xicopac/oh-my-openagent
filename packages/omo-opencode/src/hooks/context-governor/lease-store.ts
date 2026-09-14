import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import {
  readJsonTolerant,
  writeAtomicJson,
  writeAtomicText,
} from "../../shared/atomic-fs"
import { encodeSessionId } from "./capsule-store"
import {
  isLeaseReasonCode,
  LEASE_REASON_CODES,
  type LeaseReasonCode,
} from "./lease-reasons"

export { encodeSessionId }

/**
 * Persistent store for over-budget context leases. One directory per session:
 *
 *   <directory>/.omo/context-twin/<encoded-session>/leases.ndjson
 *   <directory>/.omo/context-twin/<encoded-session>/active-lease.json
 *
 * The ndjson file is the append-only audit log (grants + renewals + expiries).
 * The `active-lease.json` file holds the current live record, or is absent
 * when no lease is active. Both writes go through the atomic-fs helpers.
 *
 * NOTE ON encodeSessionId: sourced from `./capsule-store` (T2). We re-export
 * it so downstream call sites can `import { encodeSessionId } from
 * "./lease-store"` when they only need the lease surface, but the encoder
 * itself has a single owner.
 */

const RetainedRangeSchema = z
  .object({
    from: z.number().int().min(0),
    to: z.number().int().min(0),
    label: z.string().default(""),
  })
  .strict()

const GrantedBySchema = z.enum(["main", "twin", "forced"])

export const LeaseRecordSchema = z
  .object({
    lease_id: z.string().min(1),
    session_id: z.string().default(""),
    context_size_at_grant: z.number().int().min(0),
    reason: z.enum(LEASE_REASON_CODES),
    retained_ranges: z.array(RetainedRangeSchema).default([]),
    extra_tokens: z.number().int().min(0),
    turns: z.number().int().min(0),
    granted_at: z.string(),
    renewed_at: z.string().nullable().default(null),
    renewal_count: z.number().int().min(0).default(0),
    expires_at: z.string(),
    granted_by: GrantedBySchema.default("twin"),
    forced: z.boolean().default(false),
    audit_hash: z.string().default(""),
  })
  .strict()

export type LeaseRecord = z.infer<typeof LeaseRecordSchema>
export type RetainedRange = z.infer<typeof RetainedRangeSchema>
export type GrantedBy = z.infer<typeof GrantedBySchema>

export type GrantLeaseInput = {
  context_size_at_grant: number
  reason: LeaseReasonCode
  retained_ranges: RetainedRange[]
  extra_tokens: number
  turns: number
  granted_by?: GrantedBy
  audit_hash?: string
  now?: string
}

export type GrantLeaseResult =
  | { granted: true; record: LeaseRecord }
  | { granted: false; reason_invalid: true }

export type RenewLeaseInput = {
  maxRenewals: number
  currentContextSize: number
  now?: string
}

export type RenewLeaseOutcome = "renewed" | "cap_reached" | "no_active_lease"

export type LeaseStore = {
  leasesPath: (sessionId: string) => string
  activeLeasePath: (sessionId: string) => string
  getActiveLease: (sessionId: string) => LeaseRecord | null
  grantLease: (sessionId: string, input: GrantLeaseInput) => GrantLeaseResult
  renewLease: (sessionId: string, input: RenewLeaseInput) => RenewLeaseOutcome
  expireLease: (sessionId: string) => boolean
}

function sessionDir(directory: string, sessionId: string): string {
  return join(directory, ".omo/context-twin", encodeSessionId(sessionId))
}

function fourHex(): string {
  const chars = "0123456789abcdef"
  let out = ""
  for (let i = 0; i < 4; i += 1) {
    out += chars[Math.floor(Math.random() * 16)]
  }
  return out
}

function appendNdjson(filePath: string, line: string): void {
  let existing = ""
  try {
    existing = readFileSync(filePath, "utf-8")
  } catch {
    existing = ""
  }
  const suffix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n"
  writeAtomicText(filePath, `${existing}${suffix}${line}\n`)
}

export function createLeaseStore(directory: string): LeaseStore {
  const leasesPath = (sessionId: string): string =>
    join(sessionDir(directory, sessionId), "leases.ndjson")

  const activeLeasePath = (sessionId: string): string =>
    join(sessionDir(directory, sessionId), "active-lease.json")

  const getActiveLease = (sessionId: string): LeaseRecord | null => {
    const raw = readJsonTolerant(activeLeasePath(sessionId))
    if (raw === null) return null
    const parsed = LeaseRecordSchema.safeParse(raw)
    if (!parsed.success) return null
    return parsed.data
  }

  const grantLease = (
    sessionId: string,
    input: GrantLeaseInput,
  ): GrantLeaseResult => {
    if (!isLeaseReasonCode(input.reason)) {
      return { granted: false, reason_invalid: true }
    }

    const now = input.now ?? new Date().toISOString()
    // Wall-clock sanity cap; the authoritative enforcement (turn/token) lives
    // in T9. Kept informational here so downstream tools can prune obviously
    // stale records without needing lease-store internals.
    const expiresAt = new Date(new Date(now).getTime() + 3_600_000).toISOString()

    const encoded = encodeSessionId(sessionId)
    const leaseId = `lease-${encoded}-${now}-${fourHex()}`

    const record: LeaseRecord = {
      lease_id: leaseId,
      session_id: sessionId,
      context_size_at_grant: input.context_size_at_grant,
      reason: input.reason,
      retained_ranges: input.retained_ranges,
      extra_tokens: input.extra_tokens,
      turns: input.turns,
      granted_at: now,
      renewed_at: null,
      renewal_count: 0,
      expires_at: expiresAt,
      granted_by: input.granted_by ?? "twin",
      forced: (input.granted_by ?? "twin") === "forced",
      audit_hash: input.audit_hash ?? "",
    }

    // Validate own construction under the schema before touching disk so we
    // never persist a record that could not be read back.
    const validated = LeaseRecordSchema.parse(record)

    const ndjsonPath = leasesPath(sessionId)
    const activePath = activeLeasePath(sessionId)

    appendNdjson(ndjsonPath, JSON.stringify(validated))
    writeAtomicJson(activePath, validated)

    return { granted: true, record: validated }
  }

  const renewLease = (
    sessionId: string,
    input: RenewLeaseInput,
  ): RenewLeaseOutcome => {
    const active = getActiveLease(sessionId)
    if (active === null) return "no_active_lease"
    if (active.renewal_count >= input.maxRenewals) return "cap_reached"

    const now = input.now ?? new Date().toISOString()
    const renewed: LeaseRecord = {
      ...active,
      context_size_at_grant: input.currentContextSize,
      renewed_at: now,
      renewal_count: active.renewal_count + 1,
    }

    const validated = LeaseRecordSchema.parse(renewed)

    appendNdjson(leasesPath(sessionId), JSON.stringify(validated))
    writeAtomicJson(activeLeasePath(sessionId), validated)
    return "renewed"
  }

  const expireLease = (sessionId: string): boolean => {
    const active = getActiveLease(sessionId)
    if (active === null) return false

    const at = new Date().toISOString()
    appendNdjson(
      leasesPath(sessionId),
      JSON.stringify({ kind: "expired", lease_id: active.lease_id, at }),
    )
    const activePath = activeLeasePath(sessionId)
    try {
      if (existsSync(activePath)) {
        rmSync(activePath, { force: true })
      }
    } catch {
      // best-effort; the active-lease file is derived state, the ndjson is
      // the source of truth for auditing.
    }
    return true
  }

  return {
    leasesPath,
    activeLeasePath,
    getActiveLease,
    grantLease,
    renewLease,
    expireLease,
  }
}
