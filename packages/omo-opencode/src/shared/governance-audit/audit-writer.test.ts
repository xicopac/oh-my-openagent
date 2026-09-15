import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "./audit-writer"
import { sessionJournalPath, encodeSegment } from "./paths"
import { pruneGovernanceJournals, DEFAULT_RETENTION } from "./retention"

let root: string
let cleanup: Array<() => void>

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "governance-audit-"))
  cleanup.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  })
  return dir
}

function readJournal(sessionID: string): Array<Record<string, unknown>> {
  const raw = readFileSync(sessionJournalPath(root, sessionID), "utf-8")
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

beforeEach(() => {
  cleanup = []
  root = tempRoot()
})

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

describe("createGovernanceAuditWriter", () => {
  it("creates the session journal on first event and writes valid single-line JSON", async () => {
    const writer = createGovernanceAuditWriter({ root, now: () => new Date("2026-09-15T00:00:00.000Z") })
    writer.write("ses-abc-123", { subsystem: "context_governor", event: "session_init", enabled: true })
    await writer.flush()

    const path = sessionJournalPath(root, "ses-abc-123")

    const raw = readFileSync(path, "utf-8")
    const lines = raw.split("\n").filter((line) => line.length > 0)
    const record = JSON.parse(lines[0]) as Record<string, unknown>

    expect(lines.length).toBe(1)
    expect(record.timestamp).toBe("2026-09-15T00:00:00.000Z")
    expect(record.session_id).toBe("ses-abc-123")
    expect(record.subsystem).toBe("context_governor")
    expect(record.event).toBe("session_init")
    expect(record.enabled).toBe(true)
  })

  it("appends multiple events as separate newline-delimited lines in order", async () => {
    const writer = createGovernanceAuditWriter({ root, now: () => new Date("2026-09-15T00:00:00.000Z") })
    writer.write("ses-order", { event: "a", n: 1 })
    writer.write("ses-order", { event: "b", n: 2 })
    writer.write("ses-order", { event: "c", n: 3 })
    await writer.flush()

    const records = readJournal("ses-order")
    expect(records.map((r) => r.n)).toEqual([1, 2, 3])
    expect(records.map((r) => r.event)).toEqual(["a", "b", "c"])
  })

  it("does not corrupt JSONL under parallel event writes", async () => {
    const writer = createGovernanceAuditWriter({ root })
    const writes: Array<Promise<void>> = []
    for (let n = 0; n < 200; n += 1) {
      writes.push(
        Promise.resolve().then(() => {
          writer.write("ses-parallel", { subsystem: "context_governor", event: "assessment", n })
        }),
      )
    }
    await Promise.all(writes)
    await writer.flush()

    const records = readJournal("ses-parallel")
    expect(records.length).toBe(200)
    const allValid = records.every(
      (r) => typeof r.n === "number" && r.subsystem === "context_governor" && r.event === "assessment",
    )
    expect(allValid).toBe(true)
  })

  it("isolates writes per session and uses the real session id in each record", async () => {
    const writer = createGovernanceAuditWriter({ root })
    writer.write("ses-one", { event: "x" })
    writer.write("ses-two", { event: "y" })
    await writer.flush()

    expect(readJournal("ses-one").map((r) => r.event)).toEqual(["x"])
    expect(readJournal("ses-two").map((r) => r.event)).toEqual(["y"])
    expect(readJournal("ses-one")[0].session_id).toBe("ses-one")
    expect(readJournal("ses-two")[0].session_id).toBe("ses-two")
  })

  it("appends to the correct journal when a session resumes", async () => {
    const first = createGovernanceAuditWriter({ root })
    first.write("ses-resume", { event: "session_init" })
    await first.flush()

    const second = createGovernanceAuditWriter({ root })
    second.write("ses-resume", { event: "assessment", decision: "compact" })
    await second.flush()

    const records = readJournal("ses-resume")
    expect(records.map((r) => r.event)).toEqual(["session_init", "assessment"])
  })

  it("swallows writer failures and reports them via onError without throwing", async () => {
    const blocker = join(root, "blocker")
    writeFileSync(blocker, "i am a file, not a directory")
    const errors: unknown[] = []
    const writer = createGovernanceAuditWriter({
      root: join(blocker, "sub"),
      onError: (error) => errors.push(error),
    })

    expect(() => writer.write("ses-fail", { event: "assessment" })).not.toThrow()
    await writer.flush()

    expect(errors.length).toBeGreaterThan(0)
  })

  it("drops sensitive keys before writing", async () => {
    const writer = createGovernanceAuditWriter({ root })
    writer.write("ses-secret", {
      event: "assessment",
      decision: "distill",
      prompt: "SECRET USER PROMPT",
      output: "full model response",
      api_key: "sk-live-abc",
    })
    await writer.flush()

    const record = readJournal("ses-secret")[0]
    expect(record).not.toHaveProperty("prompt")
    expect(record).not.toHaveProperty("output")
    expect(record).not.toHaveProperty("api_key")
    expect(record.decision).toBe("distill")
    expect(record.event).toBe("assessment")
  })

  it("supports a resource governor event through the same writer", async () => {
    const writer = createGovernanceAuditWriter({ root })
    writer.write("ses-rg", {
      subsystem: "resource_governor",
      event: "resource-plan-created",
      difficulty: "low",
    })
    await writer.flush()

    const record = readJournal("ses-rg")[0]
    expect(record.subsystem).toBe("resource_governor")
    expect(record.event).toBe("resource-plan-created")
    expect(record.difficulty).toBe("low")
  })

  it("supports a worker supervisor event through the same writer", async () => {
    const writer = createGovernanceAuditWriter({ root })
    writer.write("ses-ws", {
      subsystem: "worker_supervisor",
      event: "worker-nudged",
      worker_id: "worker-1",
    })
    await writer.flush()

    const record = readJournal("ses-ws")[0]
    expect(record.subsystem).toBe("worker_supervisor")
    expect(record.event).toBe("worker-nudged")
    expect(record.worker_id).toBe("worker-1")
  })

  it("creates writes with restrictive 0600 file permissions", async () => {
    const writer = createGovernanceAuditWriter({ root })
    writer.write("ses-perm", { event: "session_init" })
    await writer.flush()

    const path = sessionJournalPath(root, "ses-perm")
    const stat = statSync(path)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})

describe("paths", () => {
  it("encodes the session id into a traversal-safe path segment", () => {
    const segment = encodeSegment("ses/../evil")
    expect(segment).not.toContain("/")
    expect(segment).not.toContain("..")
  })
})

describe("pruneGovernanceJournals", () => {
  it("removes only governance session dirs, not foreign files", () => {
    const sessionDir = join(root, encodeSegment("ses-old"))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, "events.jsonl"), "{}\n")
    const old = new Date(Date.now() - 60 * 86_400_000)
    utimesSync(sessionDir, old, old)

    const foreignFile = join(root, "notes.txt")
    writeFileSync(foreignFile, "do not touch")

    pruneGovernanceJournals(root, { ...DEFAULT_RETENTION, max_age_days: 30 }, new Date())

    expect(existsSync(foreignFile)).toBe(true)
    expect(existsSync(sessionDir)).toBe(false)
  })

  it("drops the oldest session dirs past max_sessions and preserves the youngest", () => {
    const young = encodeSegment("ses-young")
    const old = encodeSegment("ses-old")
    for (const name of [old, young]) {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "events.jsonl"), "{}\n")
    }
    const oldTime = new Date(Date.now() - 10 * 86_400_000)
    utimesSync(join(root, old), oldTime, oldTime)

    pruneGovernanceJournals(root, { ...DEFAULT_RETENTION, max_sessions: 1, max_age_days: 1000 }, new Date())

    expect(existsSync(join(root, old))).toBe(false)
    expect(existsSync(join(root, young))).toBe(true)
  })

  it("bounds a journal to max_file_bytes by keeping the newest half of lines", () => {
    const dir = join(root, encodeSegment("ses-bytes"))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "events.jsonl")
    const lines: string[] = []
    for (let n = 0; n < 100; n += 1) {
      lines.push(JSON.stringify({ n, padding: "x".repeat(200) }))
    }
    writeFileSync(file, `${lines.join("\n")}\n`)

    pruneGovernanceJournals(
      root,
      { ...DEFAULT_RETENTION, max_sessions: 100, max_age_days: 1000, max_file_bytes: 5000 },
      new Date(),
    )

    const after = readFileSync(file, "utf-8").split("\n").filter((l) => l.length > 0)
    expect(after.length).toBeLessThan(lines.length)
    expect(after.length).toBeGreaterThan(0)
    expect(JSON.parse(after[0].split("\n")[0]).n).toBeGreaterThan(0)
  })

  it("returns 0 and touches nothing when the root does not exist", () => {
    const removed = pruneGovernanceJournals(join(root, "does-not-exist"))
    expect(removed).toBe(0)
  })
})
