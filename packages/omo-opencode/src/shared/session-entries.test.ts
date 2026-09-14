import { describe, expect, test } from "bun:test"

import {
  type SessionEntriesPage,
  type SessionEntryRow,
  sessionEntriesSince,
  toSessionEntryRows,
} from "./session-entries"

/**
 * Utility: build a page of synthetic rows for paging tests. `cursor` is the
 * absolute cursor position; the row emits at least `charsPerRow` of text
 * so we can exercise the total-chars cap.
 */
function makeRow(cursor: number, charsPerRow = 100): SessionEntryRow {
  return {
    cursor,
    type: "message",
    role: "assistant",
    text: "x".repeat(charsPerRow),
  }
}

describe("sessionEntriesSince", () => {
  test("#given rows and since=-1 #when paged with default caps #then all rows are returned (no truncation)", () => {
    // given
    const rows: SessionEntryRow[] = Array.from({ length: 10 }, (_, i) => makeRow(i, 50))

    // when
    const page = sessionEntriesSince(rows, -1)

    // then
    expect(page.entries).toHaveLength(10)
    expect(page.entries[0]?.cursor).toBe(0)
    expect(page.entries[9]?.cursor).toBe(9)
    expect(page.next_since).toBe(9)
    expect(page.hidden).toBe(0)
    expect(page.truncated).toBe(false)
  })

  test("#given since=3 #when paged #then only rows with cursor > 3 are returned", () => {
    // given
    const rows: SessionEntryRow[] = Array.from({ length: 8 }, (_, i) => makeRow(i, 20))

    // when
    const page = sessionEntriesSince(rows, 3)

    // then
    expect(page.entries.map((r) => r.cursor)).toEqual([4, 5, 6, 7])
    expect(page.next_since).toBe(7)
  })

  test("#given no rows after since #when paged #then next_since equals since and entries is empty", () => {
    // given
    const rows: SessionEntryRow[] = Array.from({ length: 4 }, (_, i) => makeRow(i, 10))

    // when
    const page = sessionEntriesSince(rows, 3)

    // then
    expect(page.entries).toHaveLength(0)
    expect(page.next_since).toBe(3)
    expect(page.truncated).toBe(false)
  })

  test("#given rows exceed the rows cap #when paged #then truncated=true and next_since = cursor of last included row", () => {
    // given
    const rows: SessionEntryRow[] = Array.from({ length: 12 }, (_, i) => makeRow(i, 10))

    // when
    const page = sessionEntriesSince(rows, -1, { rows: 5 })

    // then
    expect(page.entries).toHaveLength(5)
    expect(page.entries.map((r) => r.cursor)).toEqual([0, 1, 2, 3, 4])
    expect(page.next_since).toBe(4)
    expect(page.truncated).toBe(true)
  })

  test("#given walking pages by next_since #when the walk terminates #then every row is visited exactly once", () => {
    // given
    const rows: SessionEntryRow[] = Array.from({ length: 12 }, (_, i) => makeRow(i, 10))
    const seen: number[] = []
    let since = -1
    let guard = 0

    // when
    while (guard < 20) {
      guard += 1
      const page = sessionEntriesSince(rows, since, { rows: 5 })
      if (page.entries.length === 0) break
      for (const r of page.entries) seen.push(r.cursor)
      if (!page.truncated) break
      since = page.next_since
    }

    // then
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  test("#given total char cap is smaller than one row #when paged #then at least one row is still emitted (never split a row)", () => {
    // given
    const rows: SessionEntryRow[] = [makeRow(0, 500)]

    // when
    const page = sessionEntriesSince(rows, -1, { chars: 100 })

    // then
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]?.text?.length).toBe(500)
  })

  test("#given rows whose cumulative chars exceed the caps.chars budget #when paged #then the page stops before crossing the budget and marks truncated", () => {
    // given
    const rows: SessionEntryRow[] = Array.from({ length: 6 }, (_, i) => makeRow(i, 200))

    // when
    const page = sessionEntriesSince(rows, -1, { chars: 500 })

    // then
    // First row (200) fits. Second row (200, cumulative 400) fits. Third (200, cumulative 600) trips the cap.
    expect(page.entries).toHaveLength(2)
    expect(page.entries.map((r) => r.cursor)).toEqual([0, 1])
    expect(page.next_since).toBe(1)
    expect(page.truncated).toBe(true)
  })

  test("#given empty-text rows between since and the first non-empty row #when paged #then those rows are counted in hidden", () => {
    // given
    const rows: SessionEntryRow[] = [
      { cursor: 0, type: "system" },
      { cursor: 1, type: "system", text: "" },
      { cursor: 2, type: "message", role: "user", text: "hello" },
      { cursor: 3, type: "message", role: "assistant", text: "hi" },
    ]

    // when
    const page = sessionEntriesSince(rows, -1)

    // then
    expect(page.entries.map((r) => r.cursor)).toEqual([2, 3])
    expect(page.hidden).toBe(2)
  })

  test("#given an empty input #when paged #then an empty page is returned with next_since = since", () => {
    // when
    const page: SessionEntriesPage = sessionEntriesSince([], 7)

    // then
    expect(page.entries).toHaveLength(0)
    expect(page.next_since).toBe(7)
    expect(page.hidden).toBe(0)
    expect(page.truncated).toBe(false)
  })
})

describe("toSessionEntryRows (duck-typed mapper)", () => {
  test("#given a realistic SDK message with parts #when mapped #then role and joined text come through", () => {
    // given
    const raw = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          { type: "text", text: "Hello there" },
          { type: "text", text: "world" },
        ],
      },
    ]

    // when
    const rows = toSessionEntryRows(raw)

    // then
    expect(rows).toHaveLength(1)
    expect(rows[0]?.role).toBe("assistant")
    // With multiple parts each is labeled `[<type>]`; single line join is fine.
    expect(rows[0]?.text).toContain("Hello there")
    expect(rows[0]?.text).toContain("world")
    expect(rows[0]?.text).toContain("[text]")
    expect(rows[0]?.type).toBe("text")
  })

  test("#given an SDK message where role is nested in info #when mapped #then info.role wins", () => {
    // given
    const raw = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "hi" }],
      },
    ]

    // when
    const rows = toSessionEntryRows(raw)

    // then
    expect(rows[0]?.role).toBe("user")
    expect(rows[0]?.text).toBe("hi")
  })

  test("#given a plugin-event-shaped row #when mapped #then top-level text and type are used directly", () => {
    // given
    const raw = [{ type: "custom_message", role: "system", text: "boot" }]

    // when
    const rows = toSessionEntryRows(raw)

    // then
    expect(rows[0]).toMatchObject({ type: "custom_message", role: "system", text: "boot" })
  })

  test("#given no role anywhere #when mapped #then role is 'unknown'", () => {
    // given
    const raw = [{ type: "custom", text: "orphan" }]

    // when
    const rows = toSessionEntryRows(raw)

    // then
    expect(rows[0]?.role).toBe("unknown")
  })

  test("#given text exceeds row_chars #when mapped #then text is truncated with an ellipsis marker and a note", () => {
    // given
    const raw = [{ type: "message", role: "assistant", text: "y".repeat(500) }]

    // when
    const rows = toSessionEntryRows(raw, 0, { row_chars: 100 })

    // then
    const text = rows[0]?.text
    expect(text).toBeDefined()
    expect(text!.length).toBeLessThan(500)
    expect(text).toContain("\u2026")
  })

  test("#given a start cursor #when mapped #then row cursors are assigned relative to it", () => {
    // given
    const raw = [
      { type: "message", role: "user", text: "a" },
      { type: "message", role: "assistant", text: "b" },
    ]

    // when
    const rows = toSessionEntryRows(raw, 100)

    // then
    expect(rows[0]?.cursor).toBe(100)
    expect(rows[1]?.cursor).toBe(101)
  })

  test("#given garbage inputs #when mapped #then it never throws and returns an unknown-typed row per item", () => {
    // given
    const raw: unknown[] = [null, undefined, 42, "str", { junk: true }]

    // when + then
    let rows: readonly SessionEntryRow[] = []
    expect(() => {
      rows = toSessionEntryRows(raw)
    }).not.toThrow()
    expect(rows).toHaveLength(5)
    for (const r of rows) {
      expect(typeof r.cursor).toBe("number")
      // Each row has a string type; the mapper never crashes.
      expect(typeof r.type).toBe("string")
    }
  })

  test("#given an empty raw array #when mapped #then an empty row list is returned", () => {
    expect(toSessionEntryRows([])).toEqual([])
  })

  test("#given a single-part message #when mapped #then the text is unlabeled (no [type] prefix)", () => {
    // given
    const raw = [{ role: "assistant", parts: [{ type: "text", text: "hello" }] }]

    // when
    const rows = toSessionEntryRows(raw)

    // then
    expect(rows[0]?.text).toBe("hello")
    expect(rows[0]?.text?.startsWith("[")).toBe(false)
  })

  test("#given a message with parts[0].type but no top-level type #when mapped #then row.type falls back to parts[0].type", () => {
    // given
    const raw = [{ role: "user", parts: [{ type: "reasoning", text: "thought" }] }]

    // when
    const rows = toSessionEntryRows(raw)

    // then
    expect(rows[0]?.type).toBe("reasoning")
  })
})
