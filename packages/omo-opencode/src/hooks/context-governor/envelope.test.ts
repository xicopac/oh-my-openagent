import { describe, expect, test } from "bun:test"

import { encodeAnchor } from "./anchors"
import { CapsuleSchema, type Capsule } from "./capsule-schema"
import { buildCapsuleHead, SECTION_ORDER } from "./envelope"

function richFixture(): Capsule {
  return CapsuleSchema.parse({
    schema_version: 1,
    session_id: "ses_abc",
    capsule_revision: 7,
    capsule_hash: "h_deadbeef",
    updated_at: "2026-09-14T00:00:00Z",
    transcript_cursor: {
      last_entry_seq: 356,
      last_message_id: "msg_42",
      captured_at: "2026-09-14T00:00:00Z",
    },
    user_goal: {
      objective: "Ship the context governor",
      deliverables: ["capsule store", "envelope"],
      constraints: ["deterministic"],
      non_goals: [],
      preferences: [],
      later_corrections: [],
    },
    current_work: {
      objective: "Build envelope assembler",
      phase: "T5",
      active_task: "buildCapsuleHead",
      current_todo: "Golden test",
      next_intended_action: "Implement",
      blocking_issue: "",
    },
    plan_orchestration: {
      plan_path: ".omo/plans/ctx-governor.md",
      plan_identifier: "ctx-governor-v1",
      current_checklist_item: "T5",
      completed_tasks: ["T1", "T2"],
      pending_tasks: ["T6", "T7"],
      dependency_state: "clean",
      boulder_state: "active",
      child_sessions: [],
    },
    decisions: {
      items: [
        {
          text: "Use line-by-line assembly",
          rationale: "Whole-line invariant",
          source: {
            type: "session_entries",
            ref: "ses_abc",
            range: { from: 341, to: 356 },
          },
        },
        {
          text: "SECTION_ORDER is fixed",
          rationale: "",
        },
      ],
    },
    rejected_paths: {
      items: [
        {
          approach: "Truncate mid-line",
          rejection_reason: "Breaks parseability",
          evidence: "spec",
          source: {
            type: "file",
            ref: "src/x.ts",
            range: { from: 10, to: 20 },
          },
        },
      ],
    },
    code_repo_state: {
      changed_files: ["envelope.ts", "envelope.test.ts"],
      important_untouched: ["capsule-schema.ts"],
      commits: ["abc1234"],
      branches_worktrees: ["feature/dynamic-subagent-model-routing"],
      implementation_locations: ["packages/omo-opencode/src/hooks/context-governor/envelope.ts"],
      dirty_state: "modified",
    },
    verification: {
      tests_run: ["envelope.test.ts"],
      tests_passing: ["golden"],
      tests_failing: [],
      artifacts: [],
      qa_performed: ["bun test"],
      reviewer_findings: [],
      unresolved_reviewer_blockers: [],
    },
    subagent_findings: {
      items: [
        {
          text: "encodeAnchor already handles ranges",
          source: {
            type: "file",
            ref: "anchors.ts",
            range: { from: 31, to: 41 },
          },
        },
      ],
    },
    outstanding_delegated_work: ["T6 envelope wiring"],
    environment: {
      constraints: ["Bun strict TS"],
      provider_model_constraints: [],
      server_quirks: [],
      semantically_relevant_outputs: [],
    },
    risks_open_questions: {
      items: [
        { text: "Cursor msg field may be null", status: "open" },
        { text: "Deterministic ordering", status: "resolved" },
      ],
    },
    anchors: [
      {
        type: "session_entries",
        ref: "ses_abc",
        range: { from: 341, to: 356 },
      },
      { type: "commit", ref: "abc1234" },
    ],
  })
}

const EXPECTED_HEAD = [
  "schema_version: 1",
  "session_id: ses_abc",
  "revision: 7",
  "hash: h_deadbeef",
  "cursor: seq=356 msg=msg_42",
  "## user_goal",
  "- objective: Ship the context governor",
  "- deliverable: capsule store",
  "- deliverable: envelope",
  "- constraint: deterministic",
  "## current_work",
  "- objective: Build envelope assembler",
  "- phase: T5",
  "- active_task: buildCapsuleHead",
  "- current_todo: Golden test",
  "- next_intended_action: Implement",
  "## plan_orchestration",
  "- plan_path: .omo/plans/ctx-governor.md",
  "- plan_identifier: ctx-governor-v1",
  "- current_checklist_item: T5",
  "- completed_task: T1",
  "- completed_task: T2",
  "- pending_task: T6",
  "- pending_task: T7",
  "- dependency_state: clean",
  "- boulder_state: active",
  "## decisions",
  "- Use line-by-line assembly [rationale: Whole-line invariant] [src session_entries:ses_abc:341:356]",
  "- SECTION_ORDER is fixed",
  "## rejected_paths",
  "- Truncate mid-line [rejection: Breaks parseability] [evidence: spec] [src file:src/x.ts:10:20]",
  "## code_repo_state",
  "- changed_file: envelope.ts",
  "- changed_file: envelope.test.ts",
  "- important_untouched: capsule-schema.ts",
  "- commit: abc1234",
  "- branch_worktree: feature/dynamic-subagent-model-routing",
  "- implementation_location: packages/omo-opencode/src/hooks/context-governor/envelope.ts",
  "- dirty_state: modified",
  "## verification",
  "- test_run: envelope.test.ts",
  "- test_passing: golden",
  "- qa_performed: bun test",
  "## subagent_findings",
  "- encodeAnchor already handles ranges [src file:anchors.ts:31:41]",
  "## outstanding_delegated_work",
  "- T6 envelope wiring",
  "## environment",
  "- constraint: Bun strict TS",
  "## risks_open_questions",
  "- Cursor msg field may be null (open)",
  "- Deterministic ordering (resolved)",
  "## anchors",
  "- session_entries:ses_abc:341:356",
  "- commit:abc1234",
  "",
].join("\n")

describe("SECTION_ORDER", () => {
  test("#given the exported order #when read #then it lists the 12 canonical sections in priority", () => {
    // given / when / then
    expect(SECTION_ORDER).toEqual([
      "user_goal",
      "current_work",
      "plan_orchestration",
      "decisions",
      "rejected_paths",
      "code_repo_state",
      "verification",
      "subagent_findings",
      "outstanding_delegated_work",
      "environment",
      "risks_open_questions",
      "anchors",
    ])
  })
})

describe("buildCapsuleHead - golden and determinism", () => {
  test("#given a rich fixture and maxChars=8000 #when built #then head matches exact golden string", () => {
    // given
    const cap = richFixture()

    // when
    const built = buildCapsuleHead(cap, 8000)

    // then
    expect(built.head).toBe(EXPECTED_HEAD)
    expect(built.omitted).toEqual([])
  })

  test("#given the same input twice #when built #then output is byte-identical", () => {
    // given
    const cap = richFixture()

    // when
    const a = buildCapsuleHead(cap, 8000)
    const b = buildCapsuleHead(cap, 8000)

    // then
    expect(a.head).toBe(b.head)
    expect(a.omitted).toEqual(b.omitted)
  })
})

describe("buildCapsuleHead - bound (whole-line semantics)", () => {
  test("#given a tight cap of 120 #when built #then head <= 120 chars and no line is truncated", () => {
    // given
    const cap = richFixture()

    // when
    const built = buildCapsuleHead(cap, 120)

    // then
    expect(built.head.length).toBeLessThanOrEqual(120)
    const allLines = EXPECTED_HEAD.split("\n")
    for (const line of built.head.split("\n")) {
      if (line === "") continue
      expect(allLines).toContain(line)
    }
  })
})

describe("buildCapsuleHead - omitted accounting", () => {
  test("#given 6 decisions and tight maxChars #when built #then omitted contains decisions with 0<count<6", () => {
    // given
    const base = richFixture()
    const cap = CapsuleSchema.parse({
      ...base,
      decisions: {
        items: [
          { text: "D1", rationale: "" },
          { text: "D2", rationale: "" },
          { text: "D3", rationale: "" },
          { text: "D4", rationale: "" },
          { text: "D5", rationale: "" },
          { text: "D6", rationale: "" },
        ],
      },
      // strip everything past decisions so we test decision truncation specifically
      rejected_paths: { items: [] },
      code_repo_state: {
        changed_files: [],
        important_untouched: [],
        commits: [],
        branches_worktrees: [],
        implementation_locations: [],
        dirty_state: "",
      },
      verification: {
        tests_run: [],
        tests_passing: [],
        tests_failing: [],
        artifacts: [],
        qa_performed: [],
        reviewer_findings: [],
        unresolved_reviewer_blockers: [],
      },
      subagent_findings: { items: [] },
      outstanding_delegated_work: [],
      environment: {
        constraints: [],
        provider_model_constraints: [],
        server_quirks: [],
        semantically_relevant_outputs: [],
      },
      risks_open_questions: { items: [] },
      anchors: [],
    })

    // Header (5 lines ~ 90 chars) + user_goal + current_work + plan_orchestration + "## decisions" title + a couple of decisions.
    // Choose a cap that fits header + some decisions but not all six.
    const cap_chars = 670

    // when
    const built = buildCapsuleHead(cap, cap_chars)

    // then
    expect(built.head.length).toBeLessThanOrEqual(cap_chars)
    const decisionsEntry = built.omitted.find((o) => o.section === "decisions")
    expect(decisionsEntry).toBeDefined()
    expect(decisionsEntry!.count).toBeGreaterThan(0)
    expect(decisionsEntry!.count).toBeLessThan(6)
  })
})

describe("buildCapsuleHead - empty capsule", () => {
  test("#given a bare capsule #when built #then head is header-only and omitted is empty", () => {
    // given
    const cap = CapsuleSchema.parse({})

    // when
    const built = buildCapsuleHead(cap, 8000)

    // then
    expect(built.omitted).toEqual([])
    expect(built.head).toBe(
      [
        "schema_version: 1",
        "session_id: ",
        "revision: 0",
        "hash: ",
        "cursor: seq=0 msg=",
        "",
      ].join("\n"),
    )
  })
})

describe("buildCapsuleHead - anchor rendering", () => {
  test("#given an anchor with a numeric range #when built #then encodeAnchor's exact string appears in head", () => {
    // given
    const cap = richFixture()
    const target = encodeAnchor({
      type: "session_entries",
      ref: "ses_abc",
      range: { from: 341, to: 356 },
    })

    // when
    const built = buildCapsuleHead(cap, 8000)

    // then
    expect(target).toBe("session_entries:ses_abc:341:356")
    expect(built.head).toContain("- " + target)
  })
})

describe("buildCapsuleHead - whole-line invariant fuzz", () => {
  test("#given maxChars swept from 10..800 #when built #then every emitted line is a complete expected line", () => {
    // given
    const cap = richFixture()
    const legalLines = new Set(EXPECTED_HEAD.split("\n"))

    // when / then
    for (let cap_chars = 10; cap_chars <= 800; cap_chars += 1) {
      const built = buildCapsuleHead(cap, cap_chars)
      expect(built.head.length).toBeLessThanOrEqual(cap_chars)
      for (const line of built.head.split("\n")) {
        expect(legalLines.has(line)).toBe(true)
      }
    }
  })
})
