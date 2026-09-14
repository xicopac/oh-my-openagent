import type { LeaseRecord } from "./lease-store"
import type { EffectiveThresholds } from "./threshold-policy"
import type { VerifierVerdict } from "./verdict"

/**
 * Governor state machine phase for a single session.
 *
 * - `idle`         : below prepareAt (or between decisions with nothing scheduled).
 * - `preparing`    : maintenance wake dispatched; capsule freshening in flight.
 * - `auditing`     : validator wake dispatched; verdict pending.
 * - `lease_active` : a CONTEXT_LEASE_REQUIRED verdict was accepted; over-budget
 *                    tokens are permitted until the lease expires.
 * - `forcing`      : a force_compact is in flight (lease exhausted).
 */
export type GovernorPhase =
  | "idle"
  | "preparing"
  | "auditing"
  | "lease_active"
  | "forcing"

/**
 * Structured decision emitted by the governor tick. Discriminated on `kind`
 * so the hook's decision effects switch is exhaustive.
 *
 * `reason` is a short human-readable string suitable for the wakes.ndjson
 * audit line; it is NOT machine-parsed, but keeping it consistent per kind
 * makes historical logs greppable.
 */
export type GovernorDecision =
  | { kind: "none"; reason: string }
  | { kind: "prepare"; reason: string }
  | { kind: "audit"; reason: string }
  | { kind: "compact"; reason: string }
  | { kind: "compact_degraded"; reason: string }
  | { kind: "defer_no_capsule"; reason: string }
  | { kind: "defer_lease"; reason: string }
  | { kind: "renew_lease"; reason: string }
  | { kind: "force_compact"; reason: string; forced: true }

export type EvaluateGovernorDecisionInput = {
  used_tokens: number
  effective: EffectiveThresholds
  phase: GovernorPhase
  verdict: VerifierVerdict | null
  active_lease: LeaseRecord | null
  lease_expired: boolean
  renewal_possible: boolean
  capsule_fresh: boolean
  max_renewals: number
}

/**
 * Pure decision core. NO I/O, NO singletons; every input the caller might
 * consult is passed in explicitly so the decision table stays trivially
 * table-testable and the hook layer owns all timing / disk / SDK concerns.
 *
 * Precedence (top wins):
 *   1. below prepareAt                          -> none
 *   2. under compactAt AND (audit range)        -> audit
 *   3. under compactAt AND (prepare range)      -> prepare (idle-gated)
 *   4. at/above compactAt AND lease active:
 *        a. expired + SAFE verdict              -> force_compact
 *        b. expired + renewal_possible + LEASE  -> renew_lease
 *        c. expired (renewals exhausted OR no verdict) -> force_compact
 *        d. not expired                         -> defer_lease
 *   5. at/above compactAt AND no lease:
 *        a. SAFE verdict                         -> compact
 *        b. capsule_fresh                        -> compact_degraded
 *        c. otherwise                            -> defer_no_capsule
 */
export function evaluateGovernorDecision(
  input: EvaluateGovernorDecisionInput,
): GovernorDecision {
  const { used_tokens, effective, phase, verdict, active_lease } = input

  if (used_tokens < effective.prepareAt) {
    return { kind: "none", reason: "below_prepare" }
  }

  if (used_tokens < effective.auditAt) {
    if (phase === "idle") {
      return { kind: "prepare", reason: "used_in_prepare_band" }
    }
    return { kind: "none", reason: `phase_${phase}` }
  }

  if (used_tokens < effective.compactAt) {
    return { kind: "audit", reason: "used_in_audit_band" }
  }

  // used_tokens >= compactAt
  if (active_lease !== null) {
    if (input.lease_expired) {
      if (verdict?.verdict === "SAFE_TO_COMPACT") {
        return {
          kind: "force_compact",
          reason: "lease_expired_safe_verdict",
          forced: true,
        }
      }
      if (verdict?.verdict === "CONTEXT_LEASE_REQUIRED" && input.renewal_possible) {
        return { kind: "renew_lease", reason: "lease_expired_renewal_possible" }
      }
      return {
        kind: "force_compact",
        reason: "lease_expired_renewal_exhausted",
        forced: true,
      }
    }
    return { kind: "defer_lease", reason: "lease_active" }
  }

  if (verdict?.verdict === "SAFE_TO_COMPACT") {
    return { kind: "compact", reason: "safe_verdict_at_compact" }
  }

  if (input.capsule_fresh) {
    return { kind: "compact_degraded", reason: "no_verdict_capsule_fresh" }
  }

  return { kind: "defer_no_capsule", reason: "no_verdict_no_fresh_capsule" }
}

export type LeaseExpiredInput = {
  turns_since_grant: number
  tokens_since_grant: number
  extra_tokens: number
  max_turns: number
}

/**
 * Pure expiry check. Whichever counter trips first wins: the lease is
 * expired when `turns_since_grant >= max_turns` OR `tokens_since_grant >=
 * extra_tokens`. Callers pass in the already-computed counters so this
 * stays synchronous and trivially testable.
 *
 * `lease` is present in the signature so future extensions (per-lease
 * overrides, wall-clock caps) can honor per-record configuration without
 * changing every call site.
 */
export function leaseExpired(
  _lease: LeaseRecord,
  input: LeaseExpiredInput,
): boolean {
  return (
    input.turns_since_grant >= input.max_turns ||
    input.tokens_since_grant >= input.extra_tokens
  )
}
