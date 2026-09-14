/**
 * Deterministic, size-bounded capsule-head envelope assembler (T5).
 *
 * `buildCapsuleHead` reduces a structured `Capsule` (owned by
 * `./capsule-schema`) to a compact human/model-readable head string plus a
 * per-section `omitted` count of items that did not fit under `maxChars`.
 *
 * Guarantees:
 *   - PURE: same (capsule, maxChars) input yields byte-identical output.
 *     No clocks, RNG, or locale-sensitive formatting.
 *   - WHOLE-LINE bound: assembles line-by-line; when the next candidate
 *     line would push length past `maxChars`, that section stops and every
 *     unrendered item is counted into `omitted`. Lines are NEVER split or
 *     truncated mid-content.
 *   - FIXED section priority: see `SECTION_ORDER`. Sections with no
 *     content render nothing (not even a title).
 *
 * This module is pure string assembly - no I/O, no SDK, no client.
 */

import { encodeAnchor } from "./anchors"
import type { Anchor, Capsule } from "./capsule-schema"

export const SECTION_ORDER = [
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
] as const

export type SectionName = (typeof SECTION_ORDER)[number]

export type CapsuleHead = {
  head: string
  omitted: readonly { section: string; count: number }[]
}

type Section = {
  name: SectionName
  /** Item lines in the order they would render. Section title is added by the assembler. */
  lines: readonly string[]
}

/**
 * Build a size-bounded capsule head. See module doc for guarantees.
 */
export function buildCapsuleHead(capsule: Capsule, maxChars: number): CapsuleHead {
  const headerLines = renderHeader(capsule)
  const sections = SECTION_ORDER.map((name) => ({
    name,
    lines: renderSection(name, capsule),
  }))

  const emitted: string[] = []
  const omitted: { section: string; count: number }[] = []
  let used = 0
  let stopped = false

  // Header is always required. If even the header does not fit we still emit
  // as many complete header lines as possible; whole-line invariant holds.
  for (const line of headerLines) {
    const cost = line.length + 1 // trailing newline
    if (used + cost > maxChars) {
      stopped = true
      break
    }
    emitted.push(line)
    used += cost
  }

  for (const section of sections) {
    if (section.lines.length === 0) continue

    if (stopped) {
      omitted.push({ section: section.name, count: section.lines.length })
      continue
    }

    const titleLine = `## ${section.name}`
    const titleCost = titleLine.length + 1
    if (used + titleCost > maxChars) {
      stopped = true
      omitted.push({ section: section.name, count: section.lines.length })
      continue
    }
    // Reserve for the title but only commit if at least one item follows -
    // per spec the title only appears when the section has content.
    // Since section.lines.length > 0 we always follow with items; commit title.
    emitted.push(titleLine)
    used += titleCost

    let rendered = 0
    for (const line of section.lines) {
      const cost = line.length + 1
      if (used + cost > maxChars) {
        stopped = true
        break
      }
      emitted.push(line)
      used += cost
      rendered += 1
    }
    const remaining = section.lines.length - rendered
    if (remaining > 0) omitted.push({ section: section.name, count: remaining })
  }

  const head = emitted.length === 0 ? "" : emitted.join("\n") + "\n"
  return { head, omitted }
}

function renderHeader(capsule: Capsule): readonly string[] {
  const cursor = capsule.transcript_cursor
  const seq = cursor.last_entry_seq
  const msg = cursor.last_message_id ?? ""
  return [
    `schema_version: ${capsule.schema_version}`,
    `session_id: ${capsule.session_id}`,
    `revision: ${capsule.capsule_revision}`,
    `hash: ${capsule.capsule_hash}`,
    `cursor: seq=${seq} msg=${msg}`,
  ]
}

function renderSection(name: SectionName, capsule: Capsule): readonly string[] {
  switch (name) {
    case "user_goal":
      return renderUserGoal(capsule)
    case "current_work":
      return renderCurrentWork(capsule)
    case "plan_orchestration":
      return renderPlan(capsule)
    case "decisions":
      return capsule.decisions.items.map(renderDecisionOrFinding)
    case "rejected_paths":
      return capsule.rejected_paths.items.map(renderRejected)
    case "code_repo_state":
      return renderRepo(capsule)
    case "verification":
      return renderVerification(capsule)
    case "subagent_findings":
      return capsule.subagent_findings.items.map(renderDecisionOrFinding)
    case "outstanding_delegated_work":
      return capsule.outstanding_delegated_work.map(bullet)
    case "environment":
      return renderEnvironment(capsule)
    case "risks_open_questions":
      return capsule.risks_open_questions.items.map(renderRisk)
    case "anchors":
      return capsule.anchors.map((a) => `- ${encodeAnchor(a)}`)
  }
}

function renderUserGoal(capsule: Capsule): readonly string[] {
  const g = capsule.user_goal
  const out: string[] = []
  if (g.objective.length > 0) out.push(`- objective: ${g.objective}`)
  for (const d of g.deliverables) out.push(`- deliverable: ${d}`)
  for (const c of g.constraints) out.push(`- constraint: ${c}`)
  for (const n of g.non_goals) out.push(`- non_goal: ${n}`)
  for (const p of g.preferences) out.push(`- preference: ${p}`)
  for (const l of g.later_corrections) out.push(`- later_correction: ${l}`)
  return out
}

function renderCurrentWork(capsule: Capsule): readonly string[] {
  const w = capsule.current_work
  const out: string[] = []
  if (w.objective.length > 0) out.push(`- objective: ${w.objective}`)
  if (w.phase.length > 0) out.push(`- phase: ${w.phase}`)
  if (w.active_task.length > 0) out.push(`- active_task: ${w.active_task}`)
  if (w.current_todo.length > 0) out.push(`- current_todo: ${w.current_todo}`)
  if (w.next_intended_action.length > 0)
    out.push(`- next_intended_action: ${w.next_intended_action}`)
  if (w.blocking_issue.length > 0)
    out.push(`- blocking_issue: ${w.blocking_issue}`)
  return out
}

function renderPlan(capsule: Capsule): readonly string[] {
  const p = capsule.plan_orchestration
  const out: string[] = []
  if (p.plan_path.length > 0) out.push(`- plan_path: ${p.plan_path}`)
  if (p.plan_identifier.length > 0)
    out.push(`- plan_identifier: ${p.plan_identifier}`)
  if (p.current_checklist_item.length > 0)
    out.push(`- current_checklist_item: ${p.current_checklist_item}`)
  for (const t of p.completed_tasks) out.push(`- completed_task: ${t}`)
  for (const t of p.pending_tasks) out.push(`- pending_task: ${t}`)
  if (p.dependency_state.length > 0)
    out.push(`- dependency_state: ${p.dependency_state}`)
  if (p.boulder_state.length > 0) out.push(`- boulder_state: ${p.boulder_state}`)
  for (const c of p.child_sessions) out.push(`- child_session: ${c}`)
  return out
}

function renderRepo(capsule: Capsule): readonly string[] {
  const r = capsule.code_repo_state
  const out: string[] = []
  for (const f of r.changed_files) out.push(`- changed_file: ${f}`)
  for (const f of r.important_untouched) out.push(`- important_untouched: ${f}`)
  for (const c of r.commits) out.push(`- commit: ${c}`)
  for (const b of r.branches_worktrees) out.push(`- branch_worktree: ${b}`)
  for (const i of r.implementation_locations)
    out.push(`- implementation_location: ${i}`)
  if (r.dirty_state.length > 0) out.push(`- dirty_state: ${r.dirty_state}`)
  return out
}

function renderVerification(capsule: Capsule): readonly string[] {
  const v = capsule.verification
  const out: string[] = []
  for (const t of v.tests_run) out.push(`- test_run: ${t}`)
  for (const t of v.tests_passing) out.push(`- test_passing: ${t}`)
  for (const t of v.tests_failing) out.push(`- test_failing: ${t}`)
  for (const a of v.artifacts) out.push(`- artifact: ${a}`)
  for (const q of v.qa_performed) out.push(`- qa_performed: ${q}`)
  for (const f of v.reviewer_findings) out.push(`- reviewer_finding: ${f}`)
  for (const b of v.unresolved_reviewer_blockers)
    out.push(`- unresolved_reviewer_blocker: ${b}`)
  return out
}

function renderEnvironment(capsule: Capsule): readonly string[] {
  const e = capsule.environment
  const out: string[] = []
  for (const c of e.constraints) out.push(`- constraint: ${c}`)
  for (const c of e.provider_model_constraints)
    out.push(`- provider_model_constraint: ${c}`)
  for (const q of e.server_quirks) out.push(`- server_quirk: ${q}`)
  for (const o of e.semantically_relevant_outputs)
    out.push(`- semantically_relevant_output: ${o}`)
  return out
}

function renderDecisionOrFinding(item: {
  text: string
  rationale?: string
  source?: Anchor
}): string {
  const parts: string[] = [`- ${item.text}`]
  if (item.rationale !== undefined && item.rationale.length > 0) {
    parts.push(` [rationale: ${item.rationale}]`)
  }
  if (item.source !== undefined) {
    parts.push(` [src ${encodeAnchor(item.source)}]`)
  }
  return parts.join("")
}

function renderRejected(item: {
  approach: string
  rejection_reason: string
  evidence: string
  source?: Anchor
}): string {
  const parts: string[] = [`- ${item.approach}`]
  parts.push(` [rejection: ${item.rejection_reason}]`)
  if (item.evidence.length > 0) parts.push(` [evidence: ${item.evidence}]`)
  if (item.source !== undefined) {
    parts.push(` [src ${encodeAnchor(item.source)}]`)
  }
  return parts.join("")
}

function renderRisk(item: { text: string; status: string }): string {
  return `- ${item.text} (${item.status})`
}

function bullet(s: string): string {
  return `- ${s}`
}
