/**
 * Delegation Cop decision API + stateful governor facade (pure core, state
 * passed explicitly for testability). Owns the one shared ledger and turns
 * the Context Cop (context-governor sibling), Token/Cost Cop, and Delegation
 * Cop into cooperating concerns on that ledger (spec section 3).
 *
 * The hard paid ceiling is unconditional in code: nothing in a delegation
 * request (model hint, "important" role, higher expected value) can override
 * it. Only an explicit human budget increase — surfaced as updated `levels` —
 * or the separate `consent_approved` flag set by the consent subsystem (never
 * by a request) can.
 */

import type { BudgetLevels } from "./budget"
import { computePressure, type Pressure } from "./budget"
import { checkDuplicate, type WorkerTrace } from "./duplicate"
import type { ChildEscrow } from "./escrow"
import { createEscrow, escrowExhausted, recordEscrowUsage, settleEscrow } from "./escrow"
import {
  createLedger,
  recordUsage,
  computeTotals,
  type ResourceLedger,
  type UsageRecord,
} from "./ledger"
import type { ModelPricing, PricingCatalog, TokenBreakdown } from "./pricing"
import { estimateCostUsd, lookupPricing } from "./pricing"
import type { WorkerCandidate } from "./routing"
import { evaluateDelegationValue, selectWorker } from "./routing"

export type EscrowSeed = {
  escrow_id: string
  actor_id: string
  role: string
  requested_tier: string | null
  requested_model: string | null
  resolved_model: string
  free: boolean
  expected_total_tokens: number
  expected_cost_usd: number
  hard_child_token_budget: number
  hard_child_paid_budget_usd: number
  max_turns: number | null
  context_fork_policy: "narrow" | "capsule" | "full"
  context_fork_tokens: number
  start_time_ms: number
}

export type DelegationRequest = {
  actor_id: string
  role: string
  subtask: string
  required_capability: number
  candidates: readonly WorkerCandidate[]
  expected_tokens: number
  requested_tier: string | null
  requested_model: string | null
  max_turns: number | null
  context_fork_policy: "narrow" | "capsule" | "full"
  context_fork_tokens: number
  expected_information_value: number
  root_can_answer_cheaply: boolean
  prior_evidence_exists: boolean
  duplication_risk: number
}

export type GovernorContext = {
  levels: BudgetLevels
  spent_usd: number
  spent_tokens: number
  pricing: PricingCatalog
  free_first: boolean
  duplicate_detection: boolean
  max_concurrent_children: number
  default_child_tokens: number
  active_children: number
  workers: readonly WorkerTrace[]
  require_paid_escalation: boolean
  require_hard_budget_increase: boolean
  /** Set exclusively by the consent subsystem on genuine human approval. */
  consent_approved: boolean
  root_model_id: string | null
  root_pricing: ModelPricing | undefined
}

export type DelegationDecision =
  | { kind: "approved"; seed: EscrowSeed; free: boolean; cost_usd: number }
  | { kind: "blocked"; condition: "RESOURCE_BUDGET_EXHAUSTED" | "TOKEN_BUDGET_EXHAUSTED"; paid: boolean }
  | { kind: "consent_required"; seed: EscrowSeed; reason: string }
  | { kind: "duplicate"; matched: WorkerTrace }
  | { kind: "declined"; reason: "root_can_answer" | "prior_evidence" | "low_value" | "high_duplication" | "max_children" }

function seedFrom(input: {
  request: DelegationRequest
  model: string
  free: boolean
  cost_usd: number
  expected_total_tokens: number
  hard_child_token_budget: number
  hard_child_paid_budget_usd: number
  start_time_ms: number
}): EscrowSeed {
  return {
    escrow_id: `escrow-${input.request.actor_id}-${input.start_time_ms}`,
    actor_id: input.request.actor_id,
    role: input.request.role,
    requested_tier: input.request.requested_tier,
    requested_model: input.request.requested_model,
    resolved_model: input.model,
    free: input.free,
    expected_total_tokens: input.expected_total_tokens,
    expected_cost_usd: input.cost_usd,
    hard_child_token_budget: input.hard_child_token_budget,
    hard_child_paid_budget_usd: input.hard_child_paid_budget_usd,
    max_turns: input.request.max_turns,
    context_fork_policy: input.request.context_fork_policy,
    context_fork_tokens: input.request.context_fork_tokens,
    start_time_ms: input.start_time_ms,
  }
}

/**
 * Pure Delegation Cop decision. Order is deliberate and fixed so the hard
 * ceiling cannot be short-circuited by any higher-value or "important" hint.
 */
export function evaluateDelegation(
  request: DelegationRequest,
  ctx: GovernorContext,
  now_ms: number,
): DelegationDecision {
  const pressure = computePressure({ spent_usd: ctx.spent_usd, spent_tokens: ctx.spent_tokens, levels: ctx.levels })

  // Duplicate check first: reusing evidence beats spending anything.
  if (ctx.duplicate_detection) {
    const dup = checkDuplicate({ role: request.role, question: request.subtask }, ctx.workers)
    if (dup.duplicate) return { kind: "duplicate", matched: dup.matched }
  }

  // Expected value: don't spawn just because a slot exists.
  const ev = evaluateDelegationValue({
    expected_information_value: request.expected_information_value,
    cost_usd: 0,
    context_cost_tokens: request.context_fork_tokens,
    root_can_answer_cheaply: request.root_can_answer_cheaply,
    prior_evidence_exists: request.prior_evidence_exists,
    duplication_risk: request.duplication_risk,
  })
  if (!ev.justified) return { kind: "declined", reason: ev.reason }

  if (ctx.max_concurrent_children >= 0 && ctx.active_children >= ctx.max_concurrent_children) {
    return { kind: "declined", reason: "max_children" }
  }

  const prefer_free_only =
    pressure.pressure === "high" || pressure.pressure === "critical" || pressure.pressure === "exhausted"

  // The hard ceiling is a total-spend stop (spent >= hard), not a per-child
  // remaining-budget projection. A per-child paid allowance is captured in the
  // escrow instead, so selectWorker is given no projection cap here.
  const select = selectWorker({
    candidates: request.candidates,
    required_capability: request.required_capability,
    pricing: ctx.pricing,
    free_first: ctx.free_first,
    prefer_free_only,
    max_paid_usd: Number.POSITIVE_INFINITY,
  })

  if (select.kind === "no_sufficient_candidate") {
    return { kind: "declined", reason: "low_value" }
  }

  if (select.kind === "paid_blocked") {
    // A paid worker is required but the policy forbids it: hard ceilings are
    // unconditional, otherwise it is a consent boundary under pressure.
    if (pressure.paid_reached_hard) {
      return { kind: "blocked", condition: "RESOURCE_BUDGET_EXHAUSTED", paid: true }
    }
    if (pressure.token_reached_hard) {
      return { kind: "blocked", condition: "TOKEN_BUDGET_EXHAUSTED", paid: true }
    }
    const seed = seedFrom({
      request,
      model: select.candidate.model_id,
      free: false,
      cost_usd: select.cost_usd,
      expected_total_tokens: request.expected_tokens,
      hard_child_token_budget: ctx.default_child_tokens,
      hard_child_paid_budget_usd: select.cost_usd,
      start_time_ms: now_ms,
    })
    return { kind: "consent_required", seed, reason: select.reason }
  }

  const chosen = select.candidate
  const price = lookupPricing(ctx.pricing, chosen.model_id)
  const est = estimateCostUsd(price, estimateBreakdown(request.expected_tokens))
  const cost_usd = est.usd
  const free = select.free

  // Hard ceilings are unconditional and final.
  if (!free && pressure.paid_reached_hard) {
    return { kind: "blocked", condition: "RESOURCE_BUDGET_EXHAUSTED", paid: true }
  }
  if (pressure.token_reached_hard) {
    // Token hard ceiling blocks additional expensive work; a $0 worker may
    // still run when its own child token budget is nonzero and policy allows.
    if (!free) {
      return { kind: "blocked", condition: "TOKEN_BUDGET_EXHAUSTED", paid: true }
    }
  }

  const seed = seedFrom({
    request,
    model: chosen.model_id,
    free,
    cost_usd,
    expected_total_tokens: request.expected_tokens,
    hard_child_token_budget: ctx.default_child_tokens,
    hard_child_paid_budget_usd: free ? 0 : cost_usd,
    start_time_ms: now_ms,
  })

  if (!free) {
    if (ctx.require_paid_escalation && !ctx.consent_approved && needsConsent(seed, ctx)) {
      return { kind: "consent_required", seed, reason: "paid_escalation_boundary" }
    }
  }

  return { kind: "approved", seed, free, cost_usd }
}

function needsConsent(seed: EscrowSeed, ctx: GovernorContext): boolean {
  // Child is more expensive than root, exceeds default child budget, or the
  // root's own pricing is unknown (conservative: require consent).
  const childCost = seed.expected_cost_usd
  const rootCost = ctx.root_pricing
    ? estimateCostUsd(ctx.root_pricing, { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 }).usd
    : null
  if (rootCost !== null && childCost > rootCost) return true
  if (ctx.root_pricing === undefined) return true
  return false
}

function estimateBreakdown(tokens: number): TokenBreakdown {
  return {
    input: Math.floor(tokens * 0.6),
    output: Math.floor(tokens * 0.4),
    cache_read: 0,
    cache_write: 0,
  }
}

/** Stateful governor facade; bundles the ledger + escrows + decision core. */
export type ResourceGovernorConfig = {
  levels: BudgetLevels
  pricing: PricingCatalog
  free_first: boolean
  duplicate_detection: boolean
  max_concurrent_children: number
  default_child_tokens: number
  require_paid_escalation: boolean
  require_hard_budget_increase: boolean
  consent_approved: boolean
  root_model_id: string | null
  root_pricing: ModelPricing | undefined
  /**
   * Live count of concurrently active children, when the caller can observe it.
   * Falls back to the ledger's own active-child accounting when omitted.
   */
  activeChildCount?: () => number
}

export function createResourceGovernor(config: ResourceGovernorConfig) {
  const ledger: ResourceLedger = createLedger()
  const escrows = new Map<string, ChildEscrow>()
  const childRecords = new Map<string, UsageRecord>()
  const workers: WorkerTrace[] = []
  let spent_usd = 0
  let spent_tokens = 0
  let levels = config.levels
  let consentApproved = config.consent_approved
  let now = 0

  function rootPricing(): ModelPricing | undefined {
    if (config.root_model_id === null) return config.root_pricing
    return lookupPricing(config.pricing, config.root_model_id) ?? config.root_pricing
  }

  return {
    recordRootUsage(record: Omit<UsageRecord, "role" | "actor_id">): void {
      const full: UsageRecord = { ...record, role: "root", actor_id: "root" }
      recordUsage(ledger, full)
      spent_usd += record.cost_usd
      spent_tokens +=
        record.input_tokens + record.cache_read_tokens + record.cache_write_tokens + record.output_tokens
    },

    evaluateDelegation(request: DelegationRequest, now_ms: number): DelegationDecision {
      now = now_ms
      const ctx: GovernorContext = {
        levels,
        spent_usd,
        spent_tokens,
        pricing: config.pricing,
        free_first: config.free_first,
        duplicate_detection: config.duplicate_detection,
        max_concurrent_children: config.max_concurrent_children,
        default_child_tokens: config.default_child_tokens,
        active_children: config.activeChildCount
          ? config.activeChildCount()
          : computeTotals(ledger).active_child_count,
        workers,
        require_paid_escalation: config.require_paid_escalation,
        require_hard_budget_increase: config.require_hard_budget_increase,
        consent_approved: consentApproved,
        root_model_id: config.root_model_id,
        root_pricing: rootPricing(),
      }
      const decision = evaluateDelegation(request, ctx, now_ms)
      if (decision.kind === "approved" || decision.kind === "consent_required") {
        const escrow = createEscrow({
          escrow_id: decision.seed.escrow_id,
          actor_id: decision.seed.actor_id,
          role: decision.seed.role,
          requested_tier: decision.seed.requested_tier,
          requested_model: decision.seed.requested_model,
          resolved_model: decision.seed.resolved_model,
          free: decision.seed.free,
          expected_total_tokens: decision.seed.expected_total_tokens,
          expected_cost_usd: decision.seed.expected_cost_usd,
          hard_child_token_budget: decision.seed.hard_child_token_budget,
          hard_child_paid_budget_usd: decision.seed.hard_child_paid_budget_usd,
          max_turns: decision.seed.max_turns,
          context_fork_policy: decision.seed.context_fork_policy,
          context_fork_tokens: decision.seed.context_fork_tokens,
          start_time_ms: decision.seed.start_time_ms,
          token_enforced: true,
          cost_estimated: true,
        })
        escrows.set(decision.seed.escrow_id, escrow)
      }
      if (decision.kind === "approved") {
        const record: UsageRecord = {
          actor_id: decision.seed.actor_id,
          role: "child",
          model_id: decision.seed.resolved_model,
          provider_id: null,
          tier: decision.seed.requested_tier,
          free: decision.seed.free,
          input_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          cost_estimated: true,
          context_tokens: decision.seed.context_fork_tokens,
          retries: 0,
          status: "active",
          avoidable_tokens: 0,
        }
        recordUsage(ledger, record)
        childRecords.set(decision.seed.escrow_id, record)
        workers.push({
          actor_id: decision.seed.actor_id,
          role: decision.seed.role,
          question: request.subtask,
          status: "active",
        })
      }
      return decision
    },

    recordChildUsage(escrow_id: string, usage: { tokens: number; cost_usd: number }): void {
      const escrow = escrows.get(escrow_id)
      if (!escrow) return
      escrows.set(escrow_id, recordEscrowUsage(escrow, usage))
      const record = childRecords.get(escrow_id)
      if (record) {
        record.input_tokens = usage.tokens
        record.output_tokens = 0
        record.cache_read_tokens = 0
        record.cache_write_tokens = 0
        record.cost_usd = usage.cost_usd
      }
      spent_usd += usage.cost_usd
      spent_tokens += usage.tokens
    },

    settleChild(escrow_id: string, status: "completed" | "failed" | "exhausted"): boolean {
      const escrow = escrows.get(escrow_id)
      if (!escrow) return false
      const settled = settleEscrow(escrow, status)
      escrows.set(escrow_id, settled)
      const record = childRecords.get(escrow_id)
      if (record) record.status = status === "completed" ? "completed" : "failed"
      const trace = workers.find((w) => w.actor_id === escrow.actor_id)
      if (trace) trace.status = status === "completed" ? "completed" : "failed"
      return true
    },

    isChildExhausted(escrow_id: string): boolean {
      const escrow = escrows.get(escrow_id)
      return escrow ? escrowExhausted(escrow) : false
    },

    approveEscalation(): void {
      consentApproved = true
    },

    increaseBudget(increase: { hard_usd?: number; hard_tokens?: number; soft_usd?: number; soft_tokens?: number }): void {
      levels = {
        ...levels,
        ...(increase.soft_usd != null ? { soft_usd: increase.soft_usd } : {}),
        ...(increase.hard_usd != null ? { hard_usd: Math.max(levels.soft_usd, increase.hard_usd) } : {}),
        ...(increase.soft_tokens != null ? { soft_tokens: increase.soft_tokens } : {}),
        ...(increase.hard_tokens != null ? { hard_tokens: Math.max(levels.soft_tokens, increase.hard_tokens) } : {}),
      }
    },

    levels(): BudgetLevels {
      return levels
    },

    pressure(): Pressure {
      return computePressure({ spent_usd, spent_tokens, levels }).pressure
    },

    totals() {
      return computeTotals(ledger)
    },

    spentUsd(): number {
      return spent_usd
    },
  }
}
