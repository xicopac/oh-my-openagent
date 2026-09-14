/**
 * Runtime bridge that maps the pure Resource Governor core onto the real
 * delegate-task child dispatch path. The pure core owns decisions; this layer
 * owns pricing discovery, per-session state, and translating a resolved model
 * into a DelegationRequest the core can rule on (spec "critical correction:
 * runtime integration is mandatory").
 */

import type { ResourceGovernorConfig } from "../../config/schema/resource-governor"
import catalog from "../../features/opengateway-provider/opengateway-models.json"
import { resolveBudgetLevels, type BudgetLevels } from "./budget"
import { createResourceGovernor, type DelegationDecision, type DelegationRequest } from "./governor"
import type { PricingCatalog } from "./pricing"
import type { WorkerCandidate } from "./routing"
import type { ResourceGovernorEvent } from "./events"
import { ChildLaunchGuard } from "./backstop"
import {
  buildTaskResourcePlan,
  computeForecastVariance,
  difficultyFromExpectedTokens,
  type ForecastVariance,
  type TaskDifficulty,
  type TaskResourcePlan,
} from "./forecast"

type CatalogCost = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
}

type CatalogEntry = {
  cost?: CatalogCost
}

/**
 * Build a PricingCatalog from the bundled OpenGateway catalog. Prices are USD
 * per 1,000,000 tokens and feed directly into the pure pricing estimator.
 */
export function loadPricingCatalog(): PricingCatalog {
  const result: Record<string, PricingCatalog[string]> = {}
  const entries = catalog as Record<string, CatalogEntry>
  for (const [modelID, entry] of Object.entries(entries)) {
    const cost = entry?.cost
    if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue
    result[modelID] = {
      input: cost.input,
      output: cost.output,
      cache_read: typeof cost.cache_read === "number" ? cost.cache_read : 0,
      cache_write: typeof cost.cache_write === "number" ? cost.cache_write : 0,
    }
  }
  return result
}

export function levelsFromConfig(config: ResourceGovernorConfig): BudgetLevels {
  return resolveBudgetLevels({
    mode: config.budget_mode,
    soft_usd: config.paid.soft_usd,
    hard_usd: config.paid.hard_usd,
    soft_tokens: config.tokens.soft_total,
    hard_tokens: config.tokens.hard_total,
    max_concurrent_children: config.delegation.max_concurrent_children,
    default_child_tokens: config.delegation.default_child_tokens,
  })
}

export type DelegateEnforcementInput = {
  sessionID: string
  role: string
  /** Explicit worker identity bound to the minted launch authorization (defaults to `role`). */
  workerIdentity?: string
  subtask: string
  resolvedModelID: string | null
  requestedTier: string | null
  expectedTokens: number
  rootModelID?: string | null
}

export type GovernorFacade = ReturnType<typeof createResourceGovernor>

export type ResourceGovernorRuntime = {
  /** One-shot dispatch backstop; mints and redeemable proofs for child launches. */
  readonly launchGuard: ChildLaunchGuard
  enforce(input: DelegateEnforcementInput, now?: number): DelegationDecision | null
  plan(sessionID: string, difficulty: TaskDifficulty): TaskResourcePlan
  planFromDelegation(sessionID: string, expectedTokens: number): TaskResourcePlan
  variance(sessionID: string): ForecastVariance | null
  recordRootUsage(sessionID: string, usage: Parameters<GovernorFacade["recordRootUsage"]>[0]): void
  recordChildUsage(sessionID: string, escrowID: string, usage: Parameters<GovernorFacade["recordChildUsage"]>[1]): void
  settleChild(sessionID: string, escrowID: string, status: Parameters<GovernorFacade["settleChild"]>[1]): boolean
  approveEscalation(sessionID: string): void
  increaseBudget(sessionID: string, increase: Parameters<GovernorFacade["increaseBudget"]>[0]): void
  totals(sessionID: string): ReturnType<GovernorFacade["totals"]>
  pressure(sessionID: string): ReturnType<GovernorFacade["pressure"]>
  spentUsd(sessionID: string): number
  reset(sessionID: string): void
}

function buildDelegationRequest(input: DelegateEnforcementInput, plannedTokens?: number): DelegationRequest {
  const expectedTokens = plannedTokens ?? input.expectedTokens
  const candidates: WorkerCandidate[] =
    input.resolvedModelID !== null
      ? [{ model_id: input.resolvedModelID, capability: 1.0, expected_tokens: expectedTokens }]
      : []
  return {
    actor_id: input.sessionID,
    role: input.role,
    subtask: input.subtask.slice(0, 500),
    required_capability: 0.5,
    candidates,
    expected_tokens: expectedTokens,
    requested_tier: input.requestedTier,
    requested_model: input.resolvedModelID,
    max_turns: null,
    context_fork_policy: "narrow",
    context_fork_tokens: 8_000,
    expected_information_value: 0.7,
    root_can_answer_cheaply: false,
    prior_evidence_exists: false,
    duplication_risk: 0,
  }
}

/**
 * One governor instance per session so the shared ledger, escrows, and spent
 * counters persist across the many tool invocations of a single orchestration.
 */
export function createResourceGovernorRuntime(opts: {
  config: ResourceGovernorConfig
  pricing: PricingCatalog
  activeChildCount?: (sessionID: string) => number
  onEvent?: (sessionID: string, event: ResourceGovernorEvent, detail?: Record<string, unknown>) => void
}): ResourceGovernorRuntime {
  const { config, pricing } = opts
  const levels = levelsFromConfig(config)
  const launchGuard = new ChildLaunchGuard()
  const sessions = new Map<string, GovernorFacade>()
  const rootModels = new Map<string, string | null>()
  const plans = new Map<string, TaskResourcePlan>()

  function rootModelFor(sessionID: string, candidate: string | null): string | null {
    if (rootModels.has(sessionID)) return rootModels.get(sessionID) ?? null
    rootModels.set(sessionID, candidate)
    return candidate
  }

  function forSession(sessionID: string, rootModelID: string | null): GovernorFacade {
    const root = rootModelFor(sessionID, rootModelID)
    let gov = sessions.get(sessionID)
    if (!gov) {
      gov = createResourceGovernor({
        levels,
        pricing,
        free_first: config.delegation.free_first,
        duplicate_detection: config.delegation.duplicate_detection,
        max_concurrent_children: config.delegation.max_concurrent_children,
        default_child_tokens: config.delegation.default_child_tokens,
        require_paid_escalation: config.consent.require_paid_escalation,
        require_hard_budget_increase: config.consent.require_hard_budget_increase,
        consent_approved: false,
        root_model_id: root,
        root_pricing: root !== null ? pricing[root] : undefined,
        activeChildCount: () => opts.activeChildCount?.(sessionID) ?? 0,
      })
      sessions.set(sessionID, gov)
    }
    return gov
  }

  function rootModelFromUsage(usage: Parameters<GovernorFacade["recordRootUsage"]>[0]): string | null {
    if (usage.model_id == null) return null
    if (usage.model_id.includes("/")) return usage.model_id
    return usage.provider_id != null ? `${usage.provider_id}/${usage.model_id}` : usage.model_id
  }

  function emitDecisionEvent(sessionID: string, decision: DelegationDecision): void {
    if (!opts.onEvent) return
    switch (decision.kind) {
      case "approved":
        opts.onEvent(sessionID, decision.free ? "routing-free-preferred" : "cost-gate-approved", {
          model: decision.seed.resolved_model,
          free: decision.free,
          expected_cost_usd: decision.seed.expected_cost_usd,
        })
        return
      case "blocked":
        opts.onEvent(sessionID, "resource-hard-limit", { condition: decision.condition, paid: decision.paid })
        return
      case "consent_required":
        opts.onEvent(sessionID, "cost-gate-blocked", { reason: decision.reason })
        return
      case "duplicate":
        opts.onEvent(sessionID, "duplicate-work-prevented", {})
        return
      case "declined":
        return
    }
  }

  function establishPlan(sessionID: string, expectedTokens: number): TaskResourcePlan {
    const existing = plans.get(sessionID)
    if (existing) return existing
    const plan = buildTaskResourcePlan({
      difficulty: difficultyFromExpectedTokens(expectedTokens),
      hard_paid_ceiling_usd: levels.hard_usd,
    })
    plans.set(sessionID, plan)
    return plan
  }

  return {
    launchGuard,
    enforce(input, now) {
      if (input.resolvedModelID === null) return null
      establishPlan(input.sessionID, input.expectedTokens)
      const request = buildDelegationRequest(input)
      const decision = forSession(input.sessionID, input.rootModelID ?? null).evaluateDelegation(
        request,
        now ?? Date.now(),
      )
      emitDecisionEvent(input.sessionID, decision)
      return decision
    },
    plan(sessionID: string, difficulty: TaskDifficulty): TaskResourcePlan {
      const plan = buildTaskResourcePlan({ difficulty, hard_paid_ceiling_usd: levels.hard_usd })
      plans.set(sessionID, plan)
      return plan
    },
    planFromDelegation(sessionID: string, expectedTokens: number): TaskResourcePlan {
      return establishPlan(sessionID, expectedTokens)
    },
    variance(sessionID: string): ForecastVariance | null {
      const plan = plans.get(sessionID)
      if (!plan) return null
      const totals = forSession(sessionID, null).totals()
      return computeForecastVariance({
        plan,
        actual_tokens: totals.total_tokens,
        actual_paid_usd: totals.total_cost_usd,
        actual_workers: totals.child_count,
      })
    },
    recordRootUsage: (sessionID, usage) =>
      forSession(sessionID, rootModelFromUsage(usage)).recordRootUsage(usage),
    recordChildUsage: (sessionID, escrowID, usage) => forSession(sessionID, null).recordChildUsage(escrowID, usage),
    settleChild: (sessionID, escrowID, status) => forSession(sessionID, null).settleChild(escrowID, status),
    approveEscalation: (sessionID) => forSession(sessionID, null).approveEscalation(),
    increaseBudget: (sessionID, increase) => forSession(sessionID, null).increaseBudget(increase),
    totals: (sessionID) => forSession(sessionID, null).totals(),
    pressure: (sessionID) => forSession(sessionID, null).pressure(),
    spentUsd: (sessionID) => forSession(sessionID, null).spentUsd(),
    reset(sessionID) {
      sessions.delete(sessionID)
      rootModels.delete(sessionID)
    },
  }
}

/** Translate a decision into a user-facing block reason, or null when allowed. */
export function enforcementError(decision: DelegationDecision | null): string | null {
  if (decision === null) return null
  switch (decision.kind) {
    case "approved":
      return null
    case "blocked":
      return decision.paid
        ? `[resource-governor] ${decision.condition}: paid spend ceiling reached; this dispatch is blocked.`
        : `[resource-governor] ${decision.condition}: token ceiling reached; this dispatch is blocked.`
    case "consent_required":
      return `[resource-governor] consent required: ${decision.reason}.`
    case "duplicate":
      return `[resource-governor] duplicate work prevented: an existing ${decision.matched.status} worker already investigated this.`
    case "declined":
      return `[resource-governor] delegation declined: ${decision.reason}.`
  }
}
