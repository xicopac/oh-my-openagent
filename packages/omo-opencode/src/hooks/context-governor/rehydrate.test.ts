import { describe, expect, test } from "bun:test"

import type { Anchor } from "./capsule-schema"
import {
  type RehydrateCaps,
  type RehydrateResult,
  type SessionMessagesFetcher,
  context_rehydrate,
} from "./rehydrate"

/**
 * Build a fake fetcher that always returns the same fixture, starting at
 * cursor 0. The fixture uses the SDK v1.18 message shape so the mapper
 * path is exercised end-to-end.
 */
function fakeFetcher(fixture: readonly unknown[]): { fn: SessionMessagesFetcher; calls: number } {
  const state = { calls: 0 }
  const fn: SessionMessagesFetcher = async (_input) => {
    state.calls += 1
    return [...fixture]
  }
  return { fn, get calls() { return state.calls } }
}

const FIXTURE: readonly unknown[] = [
  { role: "user", parts: [{ type: "text", text: "one" }] },
  { role: "assistant", parts: [{ type: "text", text: "two" }] },
  { role: "user", parts: [{ type: "text", text: "three" }] },
  { role: "assistant", parts: [{ type: "text", text: "four" }] },
  { role: "user", parts: [{ type: "text", text: "five" }] },
]

describe("context_rehydrate — session-transcript anchors", () => {
  test("#given a session_entries anchor with a range #when rehydrated #then rows are clipped to that range", async () => {
    // given
    const { fn } = fakeFetcher(FIXTURE)
    const anchor: Anchor = { type: "session_entries", ref: "ses_x", range: { from: 1, to: 3 } }

    // when
    const result = await context_rehydrate({ anchor, fetcher: fn, sessionID: "ses_x" })

    // then
    expect(result.kind).toBe("session_range")
    expect(result.anchor).toEqual(anchor)
    expect(result.rows.map((r) => r.cursor)).toEqual([1, 2, 3])
    expect(result.rows.map((r) => r.text)).toEqual(["two", "three", "four"])
  })

  test("#given a session_cursor anchor with no range #when rehydrated #then rows are bounded by caps.rows", async () => {
    // given
    const { fn } = fakeFetcher(FIXTURE)
    const anchor: Anchor = { type: "session_cursor", ref: "ses_x" }
    const caps: RehydrateCaps = { rows: 2 }

    // when
    const result = await context_rehydrate({ anchor, fetcher: fn, sessionID: "ses_x", caps })

    // then
    expect(result.kind).toBe("session_range")
    expect(result.rows).toHaveLength(2)
  })

  test("#given a range that extends past the fetched window #when rehydrated #then only the available subset is returned (clip semantics, never throws)", async () => {
    // given
    const { fn } = fakeFetcher(FIXTURE)
    const anchor: Anchor = { type: "session_entries", ref: "ses_x", range: { from: 3, to: 99 } }

    // when
    const result = await context_rehydrate({ anchor, fetcher: fn, sessionID: "ses_x" })

    // then
    expect(result.kind).toBe("session_range")
    expect(result.rows.map((r) => r.cursor)).toEqual([3, 4])
  })

  test("#given a range entirely before the fetched window #when rehydrated #then no rows are returned (clip semantics)", async () => {
    // given
    const { fn } = fakeFetcher(FIXTURE)
    const anchor: Anchor = { type: "session_entries", ref: "ses_x", range: { from: 100, to: 200 } }

    // when
    const result = await context_rehydrate({ anchor, fetcher: fn, sessionID: "ses_x" })

    // then
    expect(result.kind).toBe("session_range")
    expect(result.rows).toHaveLength(0)
  })

  test("#given caps.chars is tight #when rehydrated #then output is bounded by the char budget", async () => {
    // given
    const bigFixture = Array.from({ length: 10 }, (_, i) => ({
      role: "assistant" as const,
      parts: [{ type: "text", text: "x".repeat(300) }],
    }))
    const { fn } = fakeFetcher(bigFixture)
    const anchor: Anchor = { type: "session_cursor", ref: "ses_x" }

    // when
    const result = await context_rehydrate({
      anchor,
      fetcher: fn,
      sessionID: "ses_x",
      caps: { rows: 100, chars: 700 },
    })

    // then
    // First row (300) fits. Second row (300, cumulative 600) fits. Third trips the 700 budget.
    expect(result.rows).toHaveLength(2)
  })

  test("#given the range is a single index #when rehydrated #then exactly one row is returned", async () => {
    // given
    const { fn } = fakeFetcher(FIXTURE)
    const anchor: Anchor = { type: "session_entries", ref: "ses_x", range: { from: 2, to: 2 } }

    // when
    const result = await context_rehydrate({ anchor, fetcher: fn, sessionID: "ses_x" })

    // then
    expect(result.rows.map((r) => r.cursor)).toEqual([2])
    expect(result.rows[0]?.text).toBe("three")
  })
})

describe("context_rehydrate — non-transcript anchors", () => {
  test("#given a file anchor #when rehydrated #then result is unresolvable with a hint", async () => {
    // given
    const { fn } = fakeFetcher(FIXTURE)
    const anchor: Anchor = { type: "file", ref: "src/a.ts", range: { from: 1, to: 10 } }

    // when
    const result: RehydrateResult = await context_rehydrate({ anchor, fetcher: fn })

    // then
    expect(result.kind).toBe("unresolvable")
    expect(result.rows).toHaveLength(0)
    expect(result.anchor).toEqual(anchor)
    expect(result.source).toContain("read")
  })

  test("#given a plan/artifact/commit/task_id/child_session anchor #when rehydrated #then result is unresolvable", async () => {
    // given
    const { fn } = fakeFetcher(FIXTURE)
    const anchors: readonly Anchor[] = [
      { type: "plan", ref: ".omo/plans/x.md" },
      { type: "artifact", ref: ".omo/evidence/x/README.md" },
      { type: "commit", ref: "abc1234" },
      { type: "task_id", ref: "bg_abc" },
      { type: "child_session", ref: "ses_xyz" },
    ]

    // when + then
    for (const anchor of anchors) {
      const result = await context_rehydrate({ anchor, fetcher: fn })
      expect(result.kind).toBe("unresolvable")
      expect(result.rows).toHaveLength(0)
    }
  })
})

describe("context_rehydrate — fetcher error propagation", () => {
  test("#given a fetcher that rejects #when rehydrated #then the rejection propagates (contract: caller sees the raw failure)", async () => {
    // given
    const failing: SessionMessagesFetcher = async () => {
      throw new Error("boom")
    }
    const anchor: Anchor = { type: "session_entries", ref: "ses_x", range: { from: 0, to: 0 } }

    // when + then
    await expect(context_rehydrate({ anchor, fetcher: failing, sessionID: "ses_x" })).rejects.toThrow("boom")
  })
})

describe("context_rehydrate — fetcher call shape", () => {
  test("#given a session_entries anchor with a range #when rehydrated #then fetcher is called with limit bounded by range size and order='asc'", async () => {
    // given
    const seen: { sessionID: string; limit: number; order: "asc" | "desc" }[] = []
    const fetcher: SessionMessagesFetcher = async (input) => {
      seen.push({ sessionID: input.sessionID, limit: input.limit, order: input.order })
      return [...FIXTURE]
    }
    const anchor: Anchor = { type: "session_entries", ref: "ses_x", range: { from: 1, to: 3 } }

    // when
    await context_rehydrate({ anchor, fetcher, sessionID: "ses_x", caps: { rows: 50 } })

    // then
    expect(seen).toHaveLength(1)
    expect(seen[0]?.sessionID).toBe("ses_x")
    expect(seen[0]?.order).toBe("asc")
    // Range size = to - from + 1 = 3; min(3, caps.rows=50) = 3.
    expect(seen[0]?.limit).toBe(3)
  })

  test("#given no range and caps.rows unset #when rehydrated #then fetcher receives the default row cap as limit", async () => {
    // given
    const seen: { limit: number }[] = []
    const fetcher: SessionMessagesFetcher = async (input) => {
      seen.push({ limit: input.limit })
      return [...FIXTURE]
    }
    const anchor: Anchor = { type: "session_cursor", ref: "ses_x" }

    // when
    await context_rehydrate({ anchor, fetcher, sessionID: "ses_x" })

    // then
    // default caps.rows = 50 (session-entries paging default).
    expect(seen[0]?.limit).toBe(50)
  })

  test("#given a session anchor without an explicit sessionID #when rehydrated #then the fetcher receives the anchor.ref as sessionID", async () => {
    // given
    const seen: { sessionID: string }[] = []
    const fetcher: SessionMessagesFetcher = async (input) => {
      seen.push({ sessionID: input.sessionID })
      return [...FIXTURE]
    }
    const anchor: Anchor = { type: "session_entries", ref: "ses_from_anchor" }

    // when
    await context_rehydrate({ anchor, fetcher })

    // then
    expect(seen[0]?.sessionID).toBe("ses_from_anchor")
  })
})
