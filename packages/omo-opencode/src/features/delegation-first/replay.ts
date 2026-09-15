/**
 * Replayable assignment retention. When a child is dispatched, the runtime
 * retains the MINIMUM information needed to safely re-dispatch a replacement
 * child after a stall reclaim: the original assignment (prompt, agent, model,
 * category, scoped context) plus the ordered worker ladder and the retry
 * lineage. No transcripts, outputs, or secrets are ever retained here.
 */

import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { SessionPermissionRule } from "../../shared/question-denied-session-permission"
import type { Finding, WorkerCandidate } from "../delegation-ladder"
import type { ChildStage, StallMode } from "../worker-supervisor"

/**
 * Bounded, secrets-free replay of a child assignment. Fields mirror the
 * `LaunchInput` essentials so a replacement child can be re-dispatched through
 * the SAME governed launch path without retaining a full transcript.
 */
export type ReplayableAssignment = {
  /** Stable logical assignment id (job id / task id). */
  assignment_id: string
  /** Root session that originated the assignment. */
  root_session_id: string
  /** Immediate parent session of the child. */
  parent_session_id: string
  /** Parent message id the child answers to (result propagation target). */
  parent_message_id: string
  /** Original task prompt. */
  prompt: string
  /** Human-readable task description (display metadata). */
  description?: string
  /** Worker/agent identity (role/subagent/category agent). */
  agent: string
  /** Delegation category, if any. */
  category?: string
  /** Resolved model for the original attempt. */
  model?: DelegatedModelConfig
  parent_model?: { providerID: string; modelID: string }
  parent_agent?: string
  parent_tools?: Record<string, boolean>
  fallback_chain?: FallbackEntry[]
  skills?: string[]
  skill_content?: string
  session_permission?: SessionPermissionRule[]
  cwd?: string
  is_unstable_agent?: boolean
  /** Ordered escalation ladder (free-first). */
  workers: WorkerCandidate[]
}

/**
 * Per-assignment retry lineage. Tracks how many attempts have run, which
 * workers have already been tried, and the failure that triggered the last
 * reclaim, so retries are observable without conflating sessions.
 */
export type RetryLineage = {
  attempt_number: number
  worker_index: number
  previous_workers: string[]
  current_worker: string | null
  failure_stage: ChildStage | null
  failure_stall_mode: StallMode | null
  failure_reason: string | null
  /** Compact useful findings preserved across replacements. */
  findings: Finding[]
}

export function initialLineage(assignment: ReplayableAssignment): RetryLineage {
  const first = assignment.workers[0]
  return {
    // Attempt 1 is the original dispatch; replacements increment from here.
    attempt_number: 1,
    worker_index: 0,
    previous_workers: [],
    current_worker: first?.model_id ?? null,
    failure_stage: null,
    failure_stall_mode: null,
    failure_reason: null,
    findings: [],
  }
}

/**
 * Build the replacement child's prompt: the original assignment plus a compact
 * prior-evidence block (failure stage/reason and any preserved findings). This
 * text goes to the replacement child ONLY; it never reaches the audit journal.
 */
export function buildReplacementPrompt(
  assignment: ReplayableAssignment,
  lineage: RetryLineage,
): string {
  const lines: string[] = [assignment.prompt]
  const evidence: string[] = []
  if (lineage.failure_stage || lineage.failure_stall_mode || lineage.failure_reason) {
    evidence.push(
      `prior attempt stalled (stage: ${lineage.failure_stage ?? "unknown"}, mode: ${lineage.failure_stall_mode ?? "unknown"})`,
    )
    if (lineage.failure_reason) evidence.push(`reason: ${lineage.failure_reason}`)
  }
  if (lineage.findings.length > 0) {
    for (const finding of lineage.findings) {
      const anchor = finding.anchors?.length ? ` (${finding.anchors.join(", ")})` : ""
      evidence.push(`prior finding: [${finding.type}] ${finding.summary}${anchor}`)
    }
  }
  if (evidence.length === 0) return assignment.prompt
  return `${lines.join("\n")}\n\nPrior attempt evidence (reuse what is still valid):\n${evidence
    .map((line) => `- ${line}`)
    .join("\n")}`
}
