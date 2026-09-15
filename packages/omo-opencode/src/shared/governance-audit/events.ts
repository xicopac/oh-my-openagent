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

/**
 * Concise zero-token events emitted by the delegation-first and watchdog
 * machinery. Flat list is convenient for a switch/validation guard.
 */
export const GOVERNANCE_DELEGATION_WATCHDOG_EVENTS = [
  ...DELEGATION_AUDIT_EVENTS,
  ...WATCHDOG_AUDIT_EVENTS,
] as const
