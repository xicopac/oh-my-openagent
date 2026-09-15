import type { ChildStage } from "./types"

/**
 * Zero-token lifecycle milestone catalog. Every event name is the exact audit
 * event emitted when a child reaches the matching stage, so the governance
 * journal answers "where did this child stop" without reading any transcript.
 */
export const CHILD_MILESTONE_EVENTS = [
  "child_dispatch_authorized",
  "child_session_created",
  "child_model_request_started",
  "child_first_provider_response",
  "child_first_progress",
  "child_completed",
  "child_failed",
  "child_cancelled",
] as const

export type ChildMilestoneEvent = (typeof CHILD_MILESTONE_EVENTS)[number]

const MILESTONE_BY_STAGE: Record<ChildStage, ChildMilestoneEvent> = {
  dispatch_authorized: "child_dispatch_authorized",
  session_created: "child_session_created",
  request_started: "child_model_request_started",
  first_response: "child_first_provider_response",
  completed: "child_completed",
  failed: "child_failed",
  cancelled: "child_cancelled",
}

export function milestoneForStage(stage: ChildStage): ChildMilestoneEvent {
  return MILESTONE_BY_STAGE[stage]
}

const TERMINAL_STAGES: ReadonlySet<ChildStage> = new Set(["completed", "failed", "cancelled"])

export function isTerminalStage(stage: ChildStage): boolean {
  return TERMINAL_STAGES.has(stage)
}

const STAGE_RANK: Record<ChildStage, number> = {
  dispatch_authorized: 0,
  session_created: 1,
  request_started: 2,
  first_response: 3,
  completed: 4,
  failed: 4,
  cancelled: 4,
}

/**
 * Advance a child's stage monotonically. A stage can only move forward (or
 * into a terminal stage), never backwards. Returns the resulting stage so the
 * caller can decide whether an audit milestone must be emitted.
 */
export function advanceStage(current: ChildStage | undefined, next: ChildStage): ChildStage {
  if (current === undefined) return next
  // A terminal stage is absorbing: a later terminal transition (e.g. the
  // session-deleted hook firing after an explicit failed/cancelled) must not
  // overwrite the already-recorded terminal kind.
  if (isTerminalStage(current)) return current
  if (STAGE_RANK[next] >= STAGE_RANK[current]) return next
  return current
}
