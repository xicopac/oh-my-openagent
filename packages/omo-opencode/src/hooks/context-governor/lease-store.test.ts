import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createLeaseStore,
  encodeSessionId,
  LeaseRecordSchema,
} from "./lease-store"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lease-store-test-"))
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

const NOW = "2026-09-14T10:00:00.000Z"
const SESSION_ID = "ses_abc/123 with:funky"

function baseGrantInput() {
  return {
    context_size_at_grant: 140000,
    reason: "active_evidence_comparison" as const,
    retained_ranges: [{ from: 0, to: 100, label: "diff_A" }],
    extra_tokens: 30000,
    turns: 3,
    now: NOW,
  }
}

describe("encodeSessionId", () => {
  test("#given a session id with path separators and spaces #when encoded #then the result is filesystem-safe", () => {
    // when
    const encoded = encodeSessionId(SESSION_ID)

    // then
    expect(encoded).not.toContain("/")
    expect(encoded).not.toContain(" ")
    expect(encoded).not.toContain(":")
    expect(encoded.length).toBeGreaterThan(0)
  })
})

describe("createLeaseStore / grantLease", () => {
  test("#given a valid grant #when called #then active lease + one ndjson line are written", () => {
    // given
    const store = createLeaseStore(dir)

    // when
    const result = store.grantLease(SESSION_ID, baseGrantInput())

    // then
    expect(result.granted).toBe(true)
    if (result.granted) {
      expect(result.record.reason).toBe("active_evidence_comparison")
      expect(result.record.context_size_at_grant).toBe(140000)
      expect(result.record.turns).toBe(3)
      expect(result.record.extra_tokens).toBe(30000)
      expect(result.record.renewal_count).toBe(0)
      expect(result.record.renewed_at).toBeNull()
      expect(result.record.granted_at).toBe(NOW)
      expect(result.record.granted_by).toBe("twin")
      expect(result.record.forced).toBe(false)
      expect(result.record.lease_id.startsWith("lease-")).toBe(true)
    }

    const active = store.getActiveLease(SESSION_ID)
    expect(active).not.toBeNull()
    expect(active?.reason).toBe("active_evidence_comparison")

    const encoded = encodeSessionId(SESSION_ID)
    const ndjsonPath = join(dir, ".omo/context-twin", encoded, "leases.ndjson")
    expect(existsSync(ndjsonPath)).toBe(true)
    const lines = readFileSync(ndjsonPath, "utf-8").trim().split("\n")
    expect(lines.length).toBe(1)
  })

  test("#given a grant with granted_by=forced #when called #then the record reflects it", () => {
    // given
    const store = createLeaseStore(dir)

    // when
    const result = store.grantLease(SESSION_ID, {
      ...baseGrantInput(),
      granted_by: "forced",
    })

    // then
    expect(result.granted).toBe(true)
    if (result.granted) {
      expect(result.record.granted_by).toBe("forced")
    }
  })

  test("#given a grant with an invalid reason #when called #then it is rejected AND no files are created", () => {
    // given
    const store = createLeaseStore(dir)

    // when
    const result = store.grantLease(SESSION_ID, {
      ...baseGrantInput(),
      // deliberate cast: exercising the runtime guard
      reason: "not_a_real_reason" as unknown as ReturnType<
        typeof baseGrantInput
      >["reason"],
    })

    // then
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.reason_invalid).toBe(true)
    }

    const encoded = encodeSessionId(SESSION_ID)
    const sessionDir = join(dir, ".omo/context-twin", encoded)
    expect(existsSync(sessionDir)).toBe(false)
    expect(existsSync(join(sessionDir, "leases.ndjson"))).toBe(false)
    expect(existsSync(join(sessionDir, "active-lease.json"))).toBe(false)
  })
})

describe("createLeaseStore / renewLease", () => {
  test("#given an active lease #when renewed under the cap #then renewal_count becomes 1 and ndjson has 2 lines", () => {
    // given
    const store = createLeaseStore(dir)
    store.grantLease(SESSION_ID, baseGrantInput())

    // when
    const outcome = store.renewLease(SESSION_ID, {
      maxRenewals: 1,
      currentContextSize: 165000,
      now: "2026-09-14T10:05:00.000Z",
    })

    // then
    expect(outcome).toBe("renewed")
    const active = store.getActiveLease(SESSION_ID)
    expect(active?.renewal_count).toBe(1)
    expect(active?.renewed_at).toBe("2026-09-14T10:05:00.000Z")
    expect(active?.context_size_at_grant).toBe(165000)

    const encoded = encodeSessionId(SESSION_ID)
    const ndjsonPath = join(dir, ".omo/context-twin", encoded, "leases.ndjson")
    const lines = readFileSync(ndjsonPath, "utf-8").trim().split("\n")
    expect(lines.length).toBe(2)
  })

  test("#given a lease already at max renewals #when renewed again #then cap_reached and count stays at 1", () => {
    // given
    const store = createLeaseStore(dir)
    store.grantLease(SESSION_ID, baseGrantInput())
    const first = store.renewLease(SESSION_ID, {
      maxRenewals: 1,
      currentContextSize: 165000,
      now: "2026-09-14T10:05:00.000Z",
    })
    expect(first).toBe("renewed")

    // when
    const second = store.renewLease(SESSION_ID, {
      maxRenewals: 1,
      currentContextSize: 170000,
      now: "2026-09-14T10:10:00.000Z",
    })

    // then
    expect(second).toBe("cap_reached")
    const active = store.getActiveLease(SESSION_ID)
    expect(active?.renewal_count).toBe(1)
  })

  test("#given no active lease #when renewed #then no_active_lease is returned", () => {
    // given
    const store = createLeaseStore(dir)

    // when
    const outcome = store.renewLease(SESSION_ID, {
      maxRenewals: 1,
      currentContextSize: 165000,
      now: NOW,
    })

    // then
    expect(outcome).toBe("no_active_lease")
  })
})

describe("createLeaseStore / expireLease", () => {
  test("#given an active lease #when expired #then active file is removed and an expired ndjson line is appended", () => {
    // given
    const store = createLeaseStore(dir)
    store.grantLease(SESSION_ID, baseGrantInput())

    // when
    const removed = store.expireLease(SESSION_ID)

    // then
    expect(removed).toBe(true)
    expect(store.getActiveLease(SESSION_ID)).toBeNull()
    const encoded = encodeSessionId(SESSION_ID)
    const ndjsonPath = join(dir, ".omo/context-twin", encoded, "leases.ndjson")
    const lines = readFileSync(ndjsonPath, "utf-8").trim().split("\n")
    expect(lines.length).toBe(2)
    const last = JSON.parse(lines[1] ?? "{}") as { kind?: string }
    expect(last.kind).toBe("expired")
  })

  test("#given no active lease #when expired #then false is returned and no file is written", () => {
    // given
    const store = createLeaseStore(dir)

    // when
    const removed = store.expireLease(SESSION_ID)

    // then
    expect(removed).toBe(false)
  })
})

describe("createLeaseStore / getActiveLease corruption tolerance", () => {
  test("#given a corrupt active-lease.json #when getActiveLease is called #then null is returned", () => {
    // given
    const store = createLeaseStore(dir)
    store.grantLease(SESSION_ID, baseGrantInput())
    const encoded = encodeSessionId(SESSION_ID)
    const activePath = join(
      dir,
      ".omo/context-twin",
      encoded,
      "active-lease.json",
    )
    writeFileSync(activePath, "{this is not: json", "utf-8")

    // when
    const active = store.getActiveLease(SESSION_ID)

    // then
    expect(active).toBeNull()
  })

  test("#given an active-lease.json that is valid JSON but not a valid record #when getActiveLease is called #then null is returned", () => {
    // given
    const store = createLeaseStore(dir)
    store.grantLease(SESSION_ID, baseGrantInput())
    const encoded = encodeSessionId(SESSION_ID)
    const activePath = join(
      dir,
      ".omo/context-twin",
      encoded,
      "active-lease.json",
    )
    writeFileSync(activePath, JSON.stringify({ what: "ever" }), "utf-8")

    // when
    const active = store.getActiveLease(SESSION_ID)

    // then
    expect(active).toBeNull()
  })
})

describe("LeaseRecordSchema", () => {
  test("#given an unknown key in a lease record #when parsed #then strict mode rejects it", () => {
    // given
    const store = createLeaseStore(dir)
    const result = store.grantLease(SESSION_ID, baseGrantInput())
    expect(result.granted).toBe(true)
    if (!result.granted) return

    // when
    const parsed = LeaseRecordSchema.safeParse({
      ...result.record,
      mystery: 1,
    })

    // then
    expect(parsed.success).toBe(false)
  })
})
