import { z } from "zod"

/**
 * Structured continuity capsule. Owned by the context-governor subsystem
 * (T2). Snake_case throughout; every array defaults to []; every optional
 * string defaults to "". Schema is strict so unexpected fields surface as
 * validation errors instead of silently persisting to disk.
 *
 * The capsule is the durable, machine-readable summary of a session that
 * survives compaction. Writes go through `capsule-store.writeCapsule`, which
 * owns revision bumping and hash computation.
 */

const AnchorTypeSchema = z.enum([
  "session_entries",
  "session_cursor",
  "file",
  "plan",
  "artifact",
  "commit",
  "task_id",
  "child_session",
])

const AnchorRangeSchema = z
  .object({
    from: z.number().nullable().optional(),
    to: z.number().nullable().optional(),
    label: z.string().optional(),
  })
  .strict()

export const AnchorSchema = z
  .object({
    type: AnchorTypeSchema,
    ref: z.string().min(1),
    range: AnchorRangeSchema.optional(),
    note: z.string().optional(),
  })
  .strict()

export type Anchor = z.infer<typeof AnchorSchema>

const TranscriptCursorSchema = z
  .object({
    last_entry_seq: z.number().int().default(0),
    last_message_id: z.string().nullable().default(null),
    captured_at: z.string().nullable().default(null),
  })
  .strict()

const UserGoalSchema = z
  .object({
    objective: z.string().default(""),
    deliverables: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    non_goals: z.array(z.string()).default([]),
    preferences: z.array(z.string()).default([]),
    later_corrections: z.array(z.string()).default([]),
  })
  .strict()

const CurrentWorkSchema = z
  .object({
    objective: z.string().default(""),
    phase: z.string().default(""),
    active_task: z.string().default(""),
    current_todo: z.string().default(""),
    next_intended_action: z.string().default(""),
    blocking_issue: z.string().default(""),
  })
  .strict()

const PlanOrchestrationSchema = z
  .object({
    plan_path: z.string().default(""),
    plan_identifier: z.string().default(""),
    current_checklist_item: z.string().default(""),
    completed_tasks: z.array(z.string()).default([]),
    pending_tasks: z.array(z.string()).default([]),
    dependency_state: z.string().default(""),
    boulder_state: z.string().default(""),
    child_sessions: z.array(z.string()).default([]),
  })
  .strict()

const DecisionItemSchema = z
  .object({
    text: z.string().min(1),
    rationale: z.string().default(""),
    source: AnchorSchema.optional(),
  })
  .strict()

const DecisionsSchema = z
  .object({
    items: z.array(DecisionItemSchema).default([]),
  })
  .strict()

const RejectedPathItemSchema = z
  .object({
    approach: z.string().min(1),
    rejection_reason: z.string().min(1),
    evidence: z.string().default(""),
    source: AnchorSchema.optional(),
  })
  .strict()

const RejectedPathsSchema = z
  .object({
    items: z.array(RejectedPathItemSchema).default([]),
  })
  .strict()

const CodeRepoStateSchema = z
  .object({
    changed_files: z.array(z.string()).default([]),
    important_untouched: z.array(z.string()).default([]),
    commits: z.array(z.string()).default([]),
    branches_worktrees: z.array(z.string()).default([]),
    implementation_locations: z.array(z.string()).default([]),
    dirty_state: z.string().default(""),
  })
  .strict()

const VerificationSchema = z
  .object({
    tests_run: z.array(z.string()).default([]),
    tests_passing: z.array(z.string()).default([]),
    tests_failing: z.array(z.string()).default([]),
    artifacts: z.array(z.string()).default([]),
    qa_performed: z.array(z.string()).default([]),
    reviewer_findings: z.array(z.string()).default([]),
    unresolved_reviewer_blockers: z.array(z.string()).default([]),
  })
  .strict()

const SubagentFindingItemSchema = z
  .object({
    text: z.string().min(1),
    source: AnchorSchema.optional(),
  })
  .strict()

const SubagentFindingsSchema = z
  .object({
    items: z.array(SubagentFindingItemSchema).default([]),
  })
  .strict()

const EnvironmentSchema = z
  .object({
    constraints: z.array(z.string()).default([]),
    provider_model_constraints: z.array(z.string()).default([]),
    server_quirks: z.array(z.string()).default([]),
    semantically_relevant_outputs: z.array(z.string()).default([]),
  })
  .strict()

const RiskItemSchema = z
  .object({
    text: z.string().min(1),
    status: z.enum(["open", "resolved", "blocked"]).default("open"),
  })
  .strict()

const RisksOpenQuestionsSchema = z
  .object({
    items: z.array(RiskItemSchema).default([]),
  })
  .strict()

export const CapsuleSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    session_id: z.string().default(""),
    capsule_revision: z.number().int().min(0).default(0),
    capsule_hash: z.string().default(""),
    updated_at: z.string().default(""),
    transcript_cursor: TranscriptCursorSchema.default(() =>
      TranscriptCursorSchema.parse({}),
    ),
    user_goal: UserGoalSchema.default(() => UserGoalSchema.parse({})),
    current_work: CurrentWorkSchema.default(() => CurrentWorkSchema.parse({})),
    plan_orchestration: PlanOrchestrationSchema.default(() =>
      PlanOrchestrationSchema.parse({}),
    ),
    decisions: DecisionsSchema.default(() => DecisionsSchema.parse({})),
    rejected_paths: RejectedPathsSchema.default(() =>
      RejectedPathsSchema.parse({}),
    ),
    code_repo_state: CodeRepoStateSchema.default(() =>
      CodeRepoStateSchema.parse({}),
    ),
    verification: VerificationSchema.default(() => VerificationSchema.parse({})),
    subagent_findings: SubagentFindingsSchema.default(() =>
      SubagentFindingsSchema.parse({}),
    ),
    outstanding_delegated_work: z.array(z.string()).default([]),
    environment: EnvironmentSchema.default(() => EnvironmentSchema.parse({})),
    risks_open_questions: RisksOpenQuestionsSchema.default(() =>
      RisksOpenQuestionsSchema.parse({}),
    ),
    anchors: z.array(AnchorSchema).default([]),
  })
  .strict()

export type Capsule = z.infer<typeof CapsuleSchema>

/**
 * Byte size of the JSON-serialized capsule. T5/T7 compare this against
 * `context_governor.capsule_full_max_bytes` to decide whether to truncate.
 */
export function measureCapsuleBytes(capsule: Capsule): number {
  return JSON.stringify(capsule).length
}
