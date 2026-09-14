import { describe, expect, test } from "bun:test"

import { anchorRange, decodeAnchor, encodeAnchor } from "./anchors"
import type { Anchor } from "./capsule-schema"

describe("encodeAnchor / decodeAnchor", () => {
  test("#given a session_entries anchor with range #when encoded #then it uses type:ref:from:to shape", () => {
    // given
    const a: Anchor = { type: "session_entries", ref: "ses_abc", range: { from: 341, to: 356 } }

    // when
    const s = encodeAnchor(a)

    // then
    expect(s).toBe("session_entries:ses_abc:341:356")
  })

  test("#given a session_entries anchor without range #when encoded #then it is type:ref only", () => {
    // given
    const a: Anchor = { type: "session_entries", ref: "ses_abc" }

    // when
    const s = encodeAnchor(a)

    // then
    expect(s).toBe("session_entries:ses_abc")
  })

  test("#given a file anchor with line range #when encoded #then type:path:from:to", () => {
    // given
    const a: Anchor = { type: "file", ref: "src/a.ts", range: { from: 10, to: 20 } }

    // when
    const s = encodeAnchor(a)

    // then
    expect(s).toBe("file:src/a.ts:10:20")
  })

  test("#given a commit anchor #when encoded #then type:ref", () => {
    // given
    const a: Anchor = { type: "commit", ref: "abc1234" }

    // when
    const s = encodeAnchor(a)

    // then
    expect(s).toBe("commit:abc1234")
  })

  test("#given a plan anchor #when encoded #then type:path", () => {
    // given
    const a: Anchor = { type: "plan", ref: ".omo/plans/x.md" }

    // when
    const s = encodeAnchor(a)

    // then
    expect(s).toBe("plan:.omo/plans/x.md")
  })

  test("#given an artifact anchor #when encoded #then type:path", () => {
    // given
    const a: Anchor = { type: "artifact", ref: ".omo/evidence/x/README.md" }

    // when
    const s = encodeAnchor(a)

    // then
    expect(s).toBe("artifact:.omo/evidence/x/README.md")
  })

  test("#given a task_id anchor #when encoded #then type:ref", () => {
    // given
    const a: Anchor = { type: "task_id", ref: "bg_abc" }

    // when
    const s = encodeAnchor(a)

    // then
    expect(s).toBe("task_id:bg_abc")
  })

  test("#given a child_session anchor #when encoded #then type:ref", () => {
    // given
    const a: Anchor = { type: "child_session", ref: "ses_xyz" }

    // when
    const s = encodeAnchor(a)

    // then
    expect(s).toBe("child_session:ses_xyz")
  })

  test("#given an anchor with a note #when encoded #then note is appended after # separator", () => {
    // given
    const a: Anchor = { type: "commit", ref: "abc1234", note: "hotfix" }

    // when
    const s = encodeAnchor(a)

    // then
    expect(s).toBe("commit:abc1234 #hotfix")
  })

  test("#given a session_entries anchor with range and note #when encoded #then range then note", () => {
    // given
    const a: Anchor = { type: "session_entries", ref: "ses_abc", range: { from: 5, to: 9 }, note: "delta" }

    // when
    const s = encodeAnchor(a)

    // then
    expect(s).toBe("session_entries:ses_abc:5:9 #delta")
  })

  test("#given every anchor variant #when encoded then decoded #then the result is deeply equal to input (roundtrip)", () => {
    // given
    const inputs: readonly Anchor[] = [
      { type: "session_entries", ref: "ses_abc", range: { from: 341, to: 356 } },
      { type: "session_entries", ref: "ses_abc" },
      { type: "session_cursor", ref: "ses_abc", range: { from: 1, to: 40 } },
      { type: "file", ref: "src/a.ts", range: { from: 10, to: 20 } },
      { type: "file", ref: "packages/x/y.ts" },
      { type: "commit", ref: "abc1234" },
      { type: "plan", ref: ".omo/plans/x.md" },
      { type: "artifact", ref: ".omo/evidence/x/README.md" },
      { type: "task_id", ref: "bg_abc" },
      { type: "child_session", ref: "ses_xyz" },
      { type: "commit", ref: "deadbeef", note: "revert" },
      { type: "session_entries", ref: "ses_1", range: { from: 0, to: 0 }, note: "boot" },
    ]

    // when + then
    for (const a of inputs) {
      const s = encodeAnchor(a)
      const back = decodeAnchor(s)
      expect(back).toEqual(a)
    }
  })
})

describe("decodeAnchor error handling", () => {
  test("#given an empty string #when decoded #then null", () => {
    expect(decodeAnchor("")).toBeNull()
  })

  test("#given a string with no colon #when decoded #then null", () => {
    expect(decodeAnchor("garbage")).toBeNull()
  })

  test("#given an unknown anchor type #when decoded #then null", () => {
    expect(decodeAnchor("mystery:foo")).toBeNull()
  })

  test("#given a session_entries anchor with reversed numeric range #when decoded #then null (numeric tail is validated)", () => {
    expect(decodeAnchor("session_entries:ses_abc:20:10")).toBeNull()
  })

  test("#given a ref containing colons but no numeric tail #when decoded #then the whole tail is the ref (paths may contain colons)", () => {
    const back = decodeAnchor("session_entries:ses_abc:not:num")
    expect(back).toEqual({ type: "session_entries", ref: "ses_abc:not:num" })
  })

  test("#given random junk #when decoded #then null (never throws)", () => {
    expect(() => decodeAnchor(":::")).not.toThrow()
    expect(decodeAnchor(":::")).toBeNull()
  })
})

describe("anchorRange", () => {
  test("#given a session_entries anchor with numeric range #when queried #then returns {from,to}", () => {
    // given
    const a: Anchor = { type: "session_entries", ref: "ses_abc", range: { from: 341, to: 356 } }

    // when
    const r = anchorRange(a)

    // then
    expect(r).toEqual({ from: 341, to: 356 })
  })

  test("#given a session_entries anchor without a range #when queried #then null", () => {
    // given
    const a: Anchor = { type: "session_entries", ref: "ses_abc" }

    // when
    const r = anchorRange(a)

    // then
    expect(r).toBeNull()
  })

  test("#given a commit anchor #when queried #then null", () => {
    expect(anchorRange({ type: "commit", ref: "abc1234" })).toBeNull()
  })
})

describe("encodeAnchor + decodeAnchor preserve notes", () => {
  test("#given an anchor with note #when roundtripped #then note is preserved verbatim", () => {
    // given
    const a: Anchor = { type: "plan", ref: ".omo/plans/x.md", note: "phase-2 gate" }

    // when
    const back = decodeAnchor(encodeAnchor(a))

    // then
    expect(back).toEqual(a)
  })
})
