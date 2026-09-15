/**
 * Governance audit event catalog — delegation-first + watchdog. These are the
 * MACHINE-READABLE event names recorded in the zero-token governance audit
 * journal (via `createGovernanceAuditWriter`). Every event carries identifiers,
 * counters, tiers, and decisions ONLY: never worker output, prompts, transcripts,
 * source code, or secrets. The writer's sanitizer strips those defensively too.
 */

export const DELEGATION_AUDIT_EVENTS = [
  "delegation_first_selected",
  "worker_attempt_started",
  "worker_attempt_inadequate",
  "worker_prompt_refined",
  "worker_model_escalated",
  "root_direct_exception",
  "root_grunt_pattern_detected",
  "early_delegation_required",
  "early_delegation_dispatched",
  "selective_root_verification",
] as const

export type DelegationAuditEvent = (typeof DELEGATION_AUDIT_EVENTS)[number]

export const WATCHDOG_AUDIT_EVENTS = [
  "watchdog_progress",
  "watchdog_quiet_active",
  "watchdog_stall_suspected",
  "watchdog_recovered",
  "watchdog_nudged",
  "watchdog_reclaimed",
] as const

export type WatchdogAuditEvent = (typeof WATCHDOG_AUDIT_EVENTS)[number]

/** Zero-token child lifecycle milestones (see worker-supervisor/lifecycle.ts). */
export const CHILD_LIFECYCLE_AUDIT_EVENTS = [
  "child_dispatch_authorized",
  "child_session_created",
  "child_model_request_started",
  "child_first_provider_response",
  "child_first_progress",
  "child_completed",
  "child_failed",
  "child_cancelled",
] as const

export type ChildLifecycleAuditEvent = (typeof CHILD_LIFECYCLE_AUDIT_EVENTS)[number]

/**
 * Stall recovery + automatic-failover markers written by the delegation-first
 * reclaim path. `worker_reclaimed` records a truthful reclaim; the
 * `worker_retry_*` / `alternate_worker_selected` / `replacement_child_*` /
 * `retry_chain_exhausted` events trace the re-dispatch of a governed
 * replacement child, and `replacement_child_blocked` records a truthful block
 * by the Resource Governor / backstop. All metadata only: no prompt, output, or
 * secret ever reaches the journal.
 */
export const STALL_RECOVERY_AUDIT_EVENTS = [
  "worker_retry_started",
  "worker_reclaimed",
  "worker_retry_planned",
  "worker_retry_dispatched",
  "alternate_worker_selected",
  "replacement_child_created",
  "replacement_child_completed",
  "replacement_child_blocked",
  "retry_chain_exhausted",
] as const

export type StallRecoveryAuditEvent = (typeof STALL_RECOVERY_AUDIT_EVENTS)[number]

/**
 * Concise zero-token events emitted by the delegation-first and watchdog
 * machinery. Flat list is convenient for a switch/validation guard.
 */
export const GOVERNANCE_DELEGATION_WATCHDOG_EVENTS = [
  ...DELEGATION_AUDIT_EVENTS,
  ...WATCHDOG_AUDIT_EVENTS,
] as const
