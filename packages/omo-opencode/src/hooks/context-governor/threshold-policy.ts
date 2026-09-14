import type { ContextGovernorConfig } from "../../config/schema/context-governor"

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
 */
export function resolveEffectiveThresholds(args: {
  configured: ContextGovernorConfig
  actualLimit: number | null
}): EffectiveThresholds | null {
  const { configured, actualLimit } = args

  if (actualLimit === null || actualLimit <= 0) return null

  const compactRel = Math.floor(actualLimit * configured.provider_relative_ratio)

  let compactAt = Math.min(configured.normal_limit_tokens, compactRel)
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

  let targetAfter = Math.min(
    configured.target_after_compaction_tokens,
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
