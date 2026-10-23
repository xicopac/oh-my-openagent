/**
 * Aggressive context-budget policy module for the context governor.
 *
 * Model-aware thresholds and reserved output capacity with bounded
 * child-result/tool-output summarization and cache-reread suppression.
 *
 * All functions are pure (no I/O, no singletons, no SDK imports) so they
 * trivially table-test.
 */

export const PROACTIVE_COMPACTION_TOKENS = 60_000
export const MANDATORY_COMPACTION_TOKENS = 90_000
export const PRE_DISPATCH_CEILING_TOKENS = 150_000
export const POST_COMPACTION_MIN_TOKENS = 10_000
export const POST_COMPACTION_MAX_TOKENS = 20_000
export const POST_COMPACTION_TARGET_TOKENS = 15_000

/**
 * Model-aware context budget structure.
 */
export type ModelContextBudget = {
  readonly windowTokens: number
  readonly reservedOutputTokens: number
  readonly usableTokens: number
}

/**
 * Context budget plan returned by resolveContextBudget.
 */
export type ContextBudgetPlan = {
  readonly proactiveAt: number
  readonly mandatoryAt: number
  readonly preDispatchCeiling: number
  readonly usableTokens: number
  readonly postCompactionTarget: number
  readonly postCompactionMin: number
  readonly postCompactionMax: number
  readonly reservedOutputTokens: number
  readonly modelAware: boolean
  readonly bindingLimit: "proactive" | "mandatory" | "ceiling" | "none"
}

/**
 * Resolve the output reserve (tokens held back from the usable window) given
 * the total window size and an optional max-output cap.
 *
 * - reserve >= 1024 and < windowTokens always.
 * - If maxOutputTokens given: reserve = min(maxOutputTokens, floor(windowTokens * 0.25)),
 *   then clamp to [1024, windowTokens-1024].
 * - If absent: reserve = clamp(floor(windowTokens * 0.1), 1024, windowTokens-1024),
 *   ensuring the result is never below 1024 and never >= windowTokens.
 */
export function resolveOutputReserve(
  windowTokens: number,
  maxOutputTokens?: number | null,
): number {
  let reserve: number

  if (maxOutputTokens != null) {
    reserve = Math.min(maxOutputTokens, Math.floor(windowTokens * 0.25))
  } else {
    reserve = Math.floor(windowTokens * 0.1)
  }

  // Clamp to [1024, windowTokens-1024]
  reserve = Math.max(1024, Math.min(reserve, windowTokens - 1024))

  return reserve
}

/**
 * Resolve a full context budget plan from window size and optional max output.
 *
 * - usable = windowTokens - reservedOutputTokens
 * - proactiveAt = min(60000, floor(usable*0.80)), clamped >= 1
 * - mandatoryAt = min(90000, floor(usable*0.90)), strictly > proactiveAt
 * - preDispatchCeiling = min(150000, usable)
 * - Ordering enforced: 1 <= proactiveAt < mandatoryAt <= preDispatchCeiling
 * - postCompactionTarget = 15000 clamped to [1, floor(ceiling*0.5)] and [10000, 20000]
 * - postCompactionMin = 10000, postCompactionMax = 20000, clamped so min <= target <= max <= ceiling
 * - modelAware=true when computed thresholds are below the fixed constants because
 *   the model window/reserve binds; bindingLimit indicates which fixed threshold was
 *   lowered. For a >=187.5k usable window bindingLimit is "none" with exact 60k/90k/150k.
 */
export function resolveContextBudget(
  input: { windowTokens: number; maxOutputTokens?: number | null },
): ContextBudgetPlan {
  const reservedOutputTokens = resolveOutputReserve(input.windowTokens, input.maxOutputTokens)
  const usable = input.windowTokens - reservedOutputTokens

  // Core thresholds from usable tokens
  let proactiveAt = Math.min(PROACTIVE_COMPACTION_TOKENS, Math.floor(usable * 0.80))
  let mandatoryAt = Math.min(MANDATORY_COMPACTION_TOKENS, Math.floor(usable * 0.90))
  let preDispatchCeiling = Math.min(PRE_DISPATCH_CEILING_TOKENS, usable)

  // Ensure proactiveAt >= 1
  if (proactiveAt < 1) proactiveAt = 1

  // Ensure mandatoryAt > proactiveAt, but never above preDispatchCeiling
  if (mandatoryAt <= proactiveAt) {
    mandatoryAt = Math.min(preDispatchCeiling, proactiveAt + 1)
  }

  // Ensure preDispatchCeiling >= mandatoryAt
  if (preDispatchCeiling < mandatoryAt) {
    preDispatchCeiling = mandatoryAt
  }

  // Re-ensure proactiveAt < mandatoryAt after ceiling adjustment
  if (proactiveAt >= mandatoryAt) {
    mandatoryAt = Math.max(proactiveAt + 1, 1)
  }

  // Clamp proactiveAt to be at least 1 and less than mandatoryAt
  proactiveAt = Math.max(1, Math.min(proactiveAt, mandatoryAt - 1))

  // --- postCompactionTarget / min / max ---
  // Fixed target = 15000, then clamp to <= floor(preDispatchCeiling * 0.5) and >= 1
  let postCompactionTarget = Math.max(1, Math.min(POST_COMPACTION_TARGET_TOKENS, Math.floor(preDispatchCeiling * 0.5)))
  // Also ensure it lies in [POST_COMPACTION_MIN_TOKENS, POST_COMPACTION_MAX_TOKENS]
  if (postCompactionTarget < POST_COMPACTION_MIN_TOKENS) {
    postCompactionTarget = POST_COMPACTION_MIN_TOKENS
  }
  if (postCompactionTarget > POST_COMPACTION_MAX_TOKENS) {
    postCompactionTarget = POST_COMPACTION_MAX_TOKENS
  }
  // Guard: target must not exceed ceiling
  if (postCompactionTarget > preDispatchCeiling) {
    postCompactionTarget = preDispatchCeiling
  }

  // postCompactionMin = 10000, but clamped so min <= target <= max <= ceiling
  let postCompactionMin = POST_COMPACTION_MIN_TOKENS
  let postCompactionMax = POST_COMPACTION_MAX_TOKENS

  // Ensure min <= target
  if (postCompactionMin > postCompactionTarget) {
    postCompactionMin = postCompactionTarget
  }
  // Ensure max >= target
  if (postCompactionMax < postCompactionTarget) {
    postCompactionMax = postCompactionTarget
  }
  // Ensure max <= ceiling
  if (postCompactionMax > preDispatchCeiling) {
    postCompactionMax = preDispatchCeiling
  }
  // Ensure min <= max
  if (postCompactionMin > postCompactionMax) {
    postCompactionMin = postCompactionMax
  }

  // --- modelAware & bindingLimit ---
  // Fixed ideal thresholds (what we'd get with a very large window),
  // independent of window size: 60_000 / 90_000 / 150_000.
  // modelAware = true when any computed threshold is strictly below its fixed constant.
  // bindingLimit indicates which fixed threshold was primarily lowered by the model window,
  // checked from highest (ceiling) to lowest (proactive).
  const ceilingIdeal = PRE_DISPATCH_CEILING_TOKENS // 150_000
  const mandatoryIdeal = MANDATORY_COMPACTION_TOKENS // 90_000
  const proactiveIdeal = PROACTIVE_COMPACTION_TOKENS // 60_000

  let modelAware = false
  let bindingLimit: "proactive" | "mandatory" | "ceiling" | "none" = "none"

  if (proactiveAt < proactiveIdeal ||
    mandatoryAt < mandatoryIdeal ||
    preDispatchCeiling < ceilingIdeal) {
    modelAware = true

    // Determine which fixed threshold was lowered (check from highest to lowest)
    if (preDispatchCeiling < ceilingIdeal) {
      bindingLimit = "ceiling"
    } else if (mandatoryAt < mandatoryIdeal) {
      bindingLimit = "mandatory"
    } else if (proactiveAt < proactiveIdeal) {
      bindingLimit = "proactive"
    }
  } else {
    modelAware = false
    bindingLimit = "none"
  }

  // Ensure postCompactionTarget <= preDispatchCeiling after all adjustments
  if (postCompactionTarget > preDispatchCeiling) {
    postCompactionTarget = preDispatchCeiling
  }

  return {
    proactiveAt,
    mandatoryAt: mandatoryAt,
    preDispatchCeiling,
    usableTokens: usable,
    postCompactionTarget,
    postCompactionMin,
    postCompactionMax,
    reservedOutputTokens,
    modelAware,
    bindingLimit,
  }
}

/**
 * Boundary decision based on used tokens relative to the budget plan.
 *
 * - ok: usedTokens < proactiveAt
 * - proactive: usedTokens >= proactiveAt
 * - mandatory: usedTokens >= mandatoryAt
 * - blocked: usedTokens > preDispatchCeiling (pre-dispatch must never exceed ceiling)
 */
export function boundaryDecision(
  budget: ContextBudgetPlan,
  usedTokens: number,
): { level: "ok" | "proactive" | "mandatory" | "blocked"; mustCompact: boolean; mustBlockDispatch: boolean } {
  if (usedTokens > budget.preDispatchCeiling) {
    return { level: "blocked", mustCompact: true, mustBlockDispatch: true }
  }

  if (usedTokens >= budget.mandatoryAt) {
    return { level: "mandatory", mustCompact: true, mustBlockDispatch: false }
  }

  if (usedTokens >= budget.proactiveAt) {
    return { level: "proactive", mustCompact: true, mustBlockDispatch: false }
  }

  return { level: "ok", mustCompact: false, mustBlockDispatch: false }
}

/**
 * Measure context reduction between before and after token counts.
 */
export function measureContextReduction(
  beforeTokens: number,
  afterTokens: number,
): {
  beforeTokens: number
  afterTokens: number
  reductionTokens: number
  reductionRatio: number
} {
  const reductionTokens = beforeTokens - afterTokens
  const reductionRatio = beforeTokens > 0 ? reductionTokens / beforeTokens : 0
  return {
    beforeTokens,
    afterTokens,
    reductionTokens,
    reductionRatio: Math.min(1, Math.max(0, reductionRatio)), // clamp to [0,1]
  }
}