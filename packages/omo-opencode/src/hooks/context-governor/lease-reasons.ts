/**
 * Single source of truth for the six lease-reason codes used by the hooks
 * layer (verdict schema + lease store).
 *
 * The config schema at
 * `packages/omo-opencode/src/config/schema/context-governor.ts` keeps its own
 * independent copy of the same list, because the config layer cannot depend on
 * anything under `src/hooks/`. If either list changes, BOTH must move in lock
 * step or the config default will silently drift from the runtime accept-list.
 */
export const LEASE_REASON_CODES = [
  "active_evidence_comparison",
  "atomic_reasoning_phase",
  "imminent_safe_state_transition",
  "simultaneous_raw_evidence_dependency",
  "stale_capsule",
  "twin_failure_no_capsule",
] as const

export type LeaseReasonCode = (typeof LEASE_REASON_CODES)[number]

/**
 * Set-form membership check. Kept as a tiny helper so callers do not have to
 * hand-roll `.includes()` narrowings that lose the literal type.
 */
export function isLeaseReasonCode(value: unknown): value is LeaseReasonCode {
  return (
    typeof value === "string" &&
    (LEASE_REASON_CODES as readonly string[]).includes(value)
  )
}
