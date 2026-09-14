import { describe, expect, test } from "bun:test"
import {
  hasForbiddenReasoningKeys,
  parseVerdict,
  type VerifierVerdict,
} from "./verdict"

describe("parseVerdict / SafeToCompactSchema", () => {
  test("#given a well-formed SAFE_TO_COMPACT payload #when parsed #then it is accepted with typed fields", () => {
    // given
    const raw = {
      verdict: "SAFE_TO_COMPACT",
      capsule_revision: 3,
      capsule_hash: "sha256:abc",
      cursor_covered: 42,
      anchor_count: 5,
      required_state_checks: ["todos_intact", "capsule_fresh"],
      missing_critical_state: false,
      generated_at: "2026-09-14T10:00:00Z",
    }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      const v: VerifierVerdict = parsed.verdict
      expect(v.verdict).toBe("SAFE_TO_COMPACT")
      if (v.verdict === "SAFE_TO_COMPACT") {
        expect(v.capsule_revision).toBe(3)
        expect(v.cursor_covered).toBe(42)
        expect(v.anchor_count).toBe(5)
        expect(v.required_state_checks).toEqual(["todos_intact", "capsule_fresh"])
        expect(v.missing_critical_state).toBe(false)
      }
    }
  })

  test("#given a SAFE payload with missing_critical_state=true #when parsed #then it is rejected", () => {
    // given
    const raw = {
      verdict: "SAFE_TO_COMPACT",
      capsule_revision: 1,
      capsule_hash: "sha256:z",
      cursor_covered: 0,
      anchor_count: 0,
      required_state_checks: [],
      missing_critical_state: true,
    }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(false)
  })

  test("#given a SAFE payload with unknown extra key #when parsed #then strict mode rejects it", () => {
    // given
    const raw = {
      verdict: "SAFE_TO_COMPACT",
      capsule_revision: 1,
      capsule_hash: "sha256:z",
      cursor_covered: 0,
      anchor_count: 0,
      missing_critical_state: false,
      mystery_field: 1,
    }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(false)
  })

  test("#given a SAFE payload without required_state_checks #when parsed #then it defaults to []", () => {
    // given
    const raw = {
      verdict: "SAFE_TO_COMPACT",
      capsule_revision: 1,
      capsule_hash: "sha256:z",
      cursor_covered: 0,
      anchor_count: 0,
      missing_critical_state: false,
    }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(true)
    if (parsed.ok && parsed.verdict.verdict === "SAFE_TO_COMPACT") {
      expect(parsed.verdict.required_state_checks).toEqual([])
    }
  })
})

describe("parseVerdict / CONTEXT_LEASE_REQUIRED", () => {
  test("#given a well-formed LEASE payload with an accepted reason #when parsed #then it is accepted", () => {
    // given
    const raw = {
      verdict: "CONTEXT_LEASE_REQUIRED",
      reason: "active_evidence_comparison",
      exact_raw_context_required:
        "raw diff of files A and B kept side by side for comparison",
      expected_safe_condition: "after the diff decision is written to notepad",
    }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.verdict.verdict).toBe("CONTEXT_LEASE_REQUIRED")
      if (parsed.verdict.verdict === "CONTEXT_LEASE_REQUIRED") {
        expect(parsed.verdict.reason).toBe("active_evidence_comparison")
      }
    }
  })

  test("#given a LEASE payload with an unknown reason string #when parsed #then it is rejected", () => {
    // given
    const raw = {
      verdict: "CONTEXT_LEASE_REQUIRED",
      reason: "some_made_up_reason",
      exact_raw_context_required: "x",
      expected_safe_condition: "y",
    }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(false)
  })

  test("#given a LEASE payload missing exact_raw_context_required #when parsed #then it is rejected", () => {
    // given
    const raw = {
      verdict: "CONTEXT_LEASE_REQUIRED",
      reason: "stale_capsule",
      expected_safe_condition: "y",
    }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(false)
  })

  test("#given a LEASE payload with empty exact_raw_context_required #when parsed #then it is rejected", () => {
    // given
    const raw = {
      verdict: "CONTEXT_LEASE_REQUIRED",
      reason: "stale_capsule",
      exact_raw_context_required: "",
      expected_safe_condition: "y",
    }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(false)
  })

  test("#given a LEASE payload with well-formed anchors #when parsed #then anchors flow through", () => {
    // given
    const raw = {
      verdict: "CONTEXT_LEASE_REQUIRED",
      reason: "simultaneous_raw_evidence_dependency",
      exact_raw_context_required: "raw tool outputs T1, T2 required together",
      expected_safe_condition: "after both diffs are compared",
      anchors: [
        { type: "session_entries", ref: "seq:100" },
      ],
    }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(true)
  })
})

describe("parseVerdict / hidden reasoning walker", () => {
  test("#given a payload with a top-level chain_of_thought key #when parsed #then it is rejected before schema parse", () => {
    // given
    const raw = {
      verdict: "SAFE_TO_COMPACT",
      capsule_revision: 1,
      capsule_hash: "sha256:z",
      cursor_covered: 0,
      anchor_count: 0,
      missing_critical_state: false,
      chain_of_thought: "step 1: ...",
    }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toContain("hidden reasoning field rejected")
      expect(parsed.error).toContain("chain_of_thought")
    }
  })

  test("#given a completely unrelated verdict string with a hidden key #when parsed #then walker still fires first", () => {
    // given
    const raw = { verdict: "GARBAGE", scratchpad: {} }

    // when
    const parsed = parseVerdict(raw)

    // then
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toContain("hidden reasoning field rejected")
    }
  })
})

describe("hasForbiddenReasoningKeys walker", () => {
  test("#given null / primitive input #when walked #then returns null (no forbidden key)", () => {
    expect(hasForbiddenReasoningKeys(null)).toBeNull()
    expect(hasForbiddenReasoningKeys(42)).toBeNull()
    expect(hasForbiddenReasoningKeys("hello")).toBeNull()
    expect(hasForbiddenReasoningKeys(true)).toBeNull()
  })

  test("#given a top-level forbidden key #when walked #then returns that key name", () => {
    expect(hasForbiddenReasoningKeys({ chain_of_thought: "x" })).toBe("chain_of_thought")
    expect(hasForbiddenReasoningKeys({ scratchpad: {} })).toBe("scratchpad")
    expect(hasForbiddenReasoningKeys({ hidden_reasoning: "" })).toBe("hidden_reasoning")
    expect(hasForbiddenReasoningKeys({ internal_scratch: 1 })).toBe("internal_scratch")
    expect(hasForbiddenReasoningKeys({ reasoning_trace: [] })).toBe("reasoning_trace")
    expect(hasForbiddenReasoningKeys({ cot: 1 })).toBe("cot")
    expect(hasForbiddenReasoningKeys({ private_notes: 1 })).toBe("private_notes")
  })

  test("#given a deeply nested forbidden key inside a valid-looking envelope #when walked #then returns the offending key", () => {
    // given
    const nested = {
      verdict: "CONTEXT_LEASE_REQUIRED",
      reason: "stale_capsule",
      anchors: [
        { id: "a", details: { extra: { cot: "leak" } } },
      ],
    }

    // when
    const found = hasForbiddenReasoningKeys(nested)

    // then
    expect(found).toBe("cot")
  })

  test("#given a valid SAFE payload with no forbidden keys #when walked #then returns null", () => {
    // given
    const raw = {
      verdict: "SAFE_TO_COMPACT",
      capsule_revision: 1,
      capsule_hash: "sha256:z",
      cursor_covered: 0,
      anchor_count: 0,
      missing_critical_state: false,
      required_state_checks: ["a", "b"],
    }

    // when
    const found = hasForbiddenReasoningKeys(raw)

    // then
    expect(found).toBeNull()
  })
})
