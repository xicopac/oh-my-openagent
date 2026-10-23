import type { ContextGovernorConfig } from "../../config/schema/context-governor"

import { resolveContextBudget } from "./budget-policy"

/**
 * Resolved token thresholds for a single (session, model) pair, after the
 * governor has reconciled the user's absolute-cap configuration against the
 * model's actual context window.
 *
 * All fields are token counts. `providerBinds` is true when the model's
 * effective window (via `provider_relative_ratio`) is tighter than the
 * user's `normal_limit_tokens` and therefore drove the compaction point.
 */
export type EffectiveThresholds = {
  readonly prepareAt: number
  readonly auditAt: number
  readonly compactAt: number
  readonly targetAfter: number
  readonly providerBinds: boolean
}

/**
 * Pure resolver. NO I/O, NO SDK imports, NO singletons.
 *
 * Returns `null` when `actualLimit` is unknown or non-positive: the governor
 * is inert in that case so today's safe behavior (do nothing) is preserved.
 *
 * The budget policy (`resolveContextBudget`) is the authoritative source of
 * the nominal thresholds: PROACTIVE=60k, MANDATORY=90k, PRE_DISPATCH_CEILING=150k
 * and POST_COMPACTION_TARGET=15k (post-compaction accepted band 10k-20k). The
 * configured absolute caps may only tighten those numbers (they are combined
 * with `Math.min`), which is what lets QA/tests lower the thresholds while the
 * shipped defaults stay pinned to the policy. For a window where the model
 * shrinks the usable budget, the policy plan scales the ceiling down and the
 * governor follows.
 */
export function resolveEffectiveThresholds(args: {
  configured: ContextGovernorConfig
  actualLimit: number | null
}): EffectiveThresholds | null {
  const { configured, actualLimit } = args

  if (actualLimit === null || actualLimit <= 0) return null

  // Authoritative policy plan for this model window. The configured absolute
  // caps are overrides that can only lower the policy thresholds below.
  const budget = resolveContextBudget({ windowTokens: actualLimit })

  const compactRel = Math.floor(actualLimit * configured.provider_relative_ratio)

  let compactAt = Math.min(
    configured.normal_limit_tokens,
    budget.preDispatchCeiling,
    compactRel,
  )
  const providerBinds = compactAt < configured.normal_limit_tokens

  let prepareAt: number
  let auditAt: number
  if (providerBinds) {
    prepareAt = Math.min(
      configured.prepare_at_tokens,
      Math.floor((compactRel * configured.prepare_at_tokens) / configured.normal_limit_tokens),
    )
    auditAt = Math.min(
      configured.audit_at_tokens,
      Math.floor((compactRel * configured.audit_at_tokens) / configured.normal_limit_tokens),
    )
  } else {
    prepareAt = configured.prepare_at_tokens
    auditAt = configured.audit_at_tokens
  }

  // Policy post-compaction target (nominal 15k, kept inside the accepted
  // 10k-20k band by the plan). Config may tighten it further.
  let targetAfter = Math.min(
    configured.target_after_compaction_tokens,
    budget.postCompactionTarget,
    Math.floor(compactAt * 0.5),
  )

  // Ordering guards. Applied in this exact order so each successive guard
  // sees the already-repaired value beneath it.
  prepareAt = Math.max(1, prepareAt)
  auditAt = Math.max(auditAt, prepareAt + 1)
  compactAt = Math.max(compactAt, auditAt + 1)
  targetAfter = Math.min(targetAfter, Math.max(1, prepareAt - 1))

  return { prepareAt, auditAt, compactAt, targetAfter, providerBinds }
}
