/**
 * Per-agent resource escrow (pure). Every child launch carries an explicit
 * budget so a child never has an implicit unlimited budget (spec section 10).
 * Dimensions the infrastructure cannot enforce are marked `enforced: false`.
 */

export type ChildEscrow = {
  escrow_id: string
  actor_id: string
  role: string
  requested_tier: string | null
  requested_model: string | null
  resolved_model: string | null
  free: boolean
  expected_input_tokens: number
  expected_output_tokens: number
  expected_total_tokens: number
  expected_cost_usd: number
  hard_child_token_budget: number
  hard_child_paid_budget_usd: number
  max_turns: number | null
  context_fork_policy: "narrow" | "capsule" | "full"
  context_fork_tokens: number
  start_time_ms: number
  usage_tokens: number
  usage_cost_usd: number
  status: "active" | "completed" | "failed" | "exhausted"
  /** Whether the hard token budget is actually enforced vs observed only. */
  token_enforced: boolean
  cost_estimated: boolean
}

export type CreateEscrowInput = {
  escrow_id: string
  actor_id: string
  role: string
  requested_tier: string | null
  requested_model: string | null
  resolved_model: string | null
  free: boolean
  expected_total_tokens: number
  expected_cost_usd: number
  hard_child_token_budget: number
  hard_child_paid_budget_usd: number
  max_turns: number | null
  context_fork_policy: ChildEscrow["context_fork_policy"]
  context_fork_tokens: number
  start_time_ms: number
  token_enforced: boolean
  cost_estimated: boolean
}

export function createEscrow(input: CreateEscrowInput): ChildEscrow {
  return {
    escrow_id: input.escrow_id,
    actor_id: input.actor_id,
    role: input.role,
    requested_tier: input.requested_tier,
    requested_model: input.requested_model,
    resolved_model: input.resolved_model,
    free: input.free,
    expected_input_tokens: 0,
    expected_output_tokens: 0,
    expected_total_tokens: input.expected_total_tokens,
    expected_cost_usd: input.expected_cost_usd,
    hard_child_token_budget: input.hard_child_token_budget,
    hard_child_paid_budget_usd: input.hard_child_paid_budget_usd,
    max_turns: input.max_turns,
    context_fork_policy: input.context_fork_policy,
    context_fork_tokens: input.context_fork_tokens,
    start_time_ms: input.start_time_ms,
    usage_tokens: 0,
    usage_cost_usd: 0,
    status: "active",
    token_enforced: input.token_enforced,
    cost_estimated: input.cost_estimated,
  }
}

export function recordEscrowUsage(
  escrow: ChildEscrow,
  usage: { tokens: number; cost_usd: number },
): ChildEscrow {
  return { ...escrow, usage_tokens: usage.tokens, usage_cost_usd: usage.cost_usd }
}

/** A child is over budget when it exceeds its hard token OR paid budget. */
export function escrowExhausted(escrow: ChildEscrow): boolean {
  return (
    escrow.usage_tokens >= escrow.hard_child_token_budget ||
    (escrow.hard_child_paid_budget_usd > 0 &&
      escrow.usage_cost_usd >= escrow.hard_child_paid_budget_usd)
  )
}

export function settleEscrow(escrow: ChildEscrow, status: "completed" | "failed" | "exhausted"): ChildEscrow {
  return { ...escrow, status }
}
