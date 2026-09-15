/**
 * Delegation Ladder — types. A deterministic retry + model-escalation ladder
 * that decides, after a worker returns an inadequate result, whether to REFINE
 * the assignment (same worker) or ESCALATE the worker model, while preserving
 * useful findings across attempts. Free/paid/cost are injected via
 * WorkerCandidate; the module never infers pricing from a model id.
 */

export type EscalationTier = "free" | "free_alt" | "cheap_paid" | "strong_paid" | "expert"

export type FindingType = "anchor" | "file" | "symbol" | "unresolved" | "note"

export type Finding = { type: FindingType; summary: string; anchors?: string[] }

export type WorkerCandidate = {
  model_id: string
  tier: EscalationTier
  capability: number
  free: boolean
  cost_usd_per_1m_input?: number
  cost_usd_per_1m_output?: number
  cost_usd_per_1m_cache_read?: number
  cost_usd_per_1m_cache_write?: number
  /** Context window (tokens) when known; omitted when unknown. */
  context_limit?: number
  /** True when the model accepts image/vision input. */
  vision?: boolean
  /** True when the model supports tool calls. */
  tool_call?: boolean
  /** True when the model supports reasoning/thinking. */
  reasoning?: boolean
}

export type AttemptResult = {
  adequate: boolean
  objective: string
  status: string
  findings: Finding[]
  confidence: number
  unresolved: string[]
  recommendedNext?: string
}

export type DelegationLadderConfig = {
  max_attempts_per_tier: number
  max_free_attempts_total: number
  escalate_after_attempts: number
}

export const DEFAULT_DELEGATION_LADDER_CONFIG: DelegationLadderConfig = {
  max_attempts_per_tier: 2,
  max_free_attempts_total: 4,
  escalate_after_attempts: 2,
}

export type JobState = {
  jobID: string
  prompt: string
  workers: WorkerCandidate[]
  workerIndex: number
  attemptsInTier: number
  totalAttempts: number
  findings: Finding[]
}
