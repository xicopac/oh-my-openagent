import { describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  capsulePath,
  decodeSessionId,
  encodeSessionId,
  readCapsule,
  updateCapsule,
  writeCapsule,
} from "./capsule-store"

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omo-capsule-store-"))
}

describe("encodeSessionId / decodeSessionId", () => {
  test("#given a session id with unsafe characters #when encoded+decoded #then roundtrips exactly", () => {
    // given
    const raw = "ses_test/with:weird?chars and spaces"

    // when
    const encoded = encodeSessionId(raw)
    const decoded = decodeSessionId(encoded)

    // then: encoded form contains no path separators
    expect(encoded.includes("/")).toBe(false)
    expect(encoded.includes(":")).toBe(false)
    expect(decoded).toBe(raw)
  })

  test("#given invalid base64url input #when decoded #then throws a clear Error", () => {
    // given: an obviously non-base64url string with characters outside the alphabet
    // when + then
    expect(() => decodeSessionId("!!!not-base64url!!!")).toThrow(
      /invalid session id/i,
    )
  })
})

describe("capsulePath", () => {
  test("#given a session id #when capsulePath is composed #then it contains the encoded id and not the raw", () => {
    // given
    const raw = "ses_test/dangerous"
    const dir = "/tmp/omo-capsule-store-fixture"

    // when
    const path = capsulePath(dir, raw)

    // then
    expect(path.endsWith("/capsule.json")).toBe(true)
    expect(path.includes(encodeSessionId(raw))).toBe(true)
    expect(path.includes("ses_test/dangerous")).toBe(false)
  })
})

describe("readCapsule tolerance", () => {
  test("#given a missing capsule.json #when read #then returns null", () => {
    // given
    const dir = makeTmpDir()
    try {
      // when
      const result = readCapsule(dir, "ses_missing")

      // then
      expect(result).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("#given a corrupt capsule.json #when read #then returns null (no throw)", () => {
    // given
    const dir = makeTmpDir()
    const sessionId = "ses_corrupt"
    const path = capsulePath(dir, sessionId)
    mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true })
    writeFileSync(path, '{"capsule_revision": 1, "corrupt', "utf-8")
    try {
      // when
      const result = readCapsule(dir, sessionId)

      // then
      expect(result).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("writeCapsule bumps revision and deterministic hash", () => {
  test("#given two sequential writes #when finished #then revision increments and file is valid capsule", () => {
    // given
    const dir = makeTmpDir()
    const sessionId = "ses_bump"
    const now = new Date("2026-01-01T00:00:00.000Z")
    try {
      // when
      const first = writeCapsule(dir, sessionId, {}, { now })
      const second = writeCapsule(
        dir,
        sessionId,
        { user_goal: { objective: "ship T2", deliverables: [], constraints: [], non_goals: [], preferences: [], later_corrections: [] } },
        { now },
      )

      // then
      expect(first.capsule_revision).toBe(1)
      expect(second.capsule_revision).toBe(2)
      expect(second.session_id).toBe(sessionId)
      expect(second.user_goal.objective).toBe("ship T2")
      expect(second.capsule_hash.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("#given the same payload and injected now, into fresh dirs #when written #then capsule_hash matches", () => {
    // given
    const dirA = makeTmpDir()
    const dirB = makeTmpDir()
    const now = new Date("2026-02-02T02:02:02.000Z")
    const sessionId = "ses_hash"
    const payload = {
      current_work: {
        objective: "hash test",
        phase: "green",
        active_task: "T2",
        current_todo: "hash",
        next_intended_action: "assert",
        blocking_issue: "",
      },
    }
    try {
      // when
      const a = writeCapsule(dirA, sessionId, payload, { now })
      const b = writeCapsule(dirB, sessionId, payload, { now })

      // then
      expect(a.capsule_hash).toBe(b.capsule_hash)
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})

describe("writeCapsule sweeps stale tmp leftovers", () => {
  test("#given a stray capsule.json.tmp-<hex> leftover #when writeCapsule runs #then leftover is removed", () => {
    // given
    const dir = makeTmpDir()
    const sessionId = "ses_sweep"
    const path = capsulePath(dir, sessionId)
    const parent = path.substring(0, path.lastIndexOf("/"))
    mkdirSync(parent, { recursive: true })
    writeFileSync(`${parent}/capsule.json.tmp-deadbeef`, "leftover", "utf-8")
    const now = new Date("2026-03-03T00:00:00.000Z")
    try {
      // when
      writeCapsule(dir, sessionId, {}, { now })

      // then
      const remaining = readdirSync(parent).sort()
      expect(remaining).toEqual(["capsule.json"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("updateCapsule", () => {
  test("#given an existing capsule #when patched via updateCapsule #then revision bumps exactly once", () => {
    // given
    const dir = makeTmpDir()
    const sessionId = "ses_update"
    const now = new Date("2026-04-04T00:00:00.000Z")
    try {
      // when
      const first = writeCapsule(dir, sessionId, {}, { now })
      const updated = updateCapsule(
        dir,
        sessionId,
        (cur) => ({
          ...cur,
          current_work: {
            ...cur.current_work,
            objective: "updated via patch",
          },
        }),
        { now },
      )

      // then
      expect(first.capsule_revision).toBe(1)
      expect(updated.capsule_revision).toBe(2)
      expect(updated.current_work.objective).toBe("updated via patch")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
