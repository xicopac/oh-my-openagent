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
 * Task-owned process scope lifecycle. Recorded when a disposable OS scope (an
 * ai-job systemd unit or a detached process group) is registered, observed
 * finished, cleaned, recovered after an owner crash, or quiesced on HOLD.
 * Metadata only: scope identifiers, signals, pids, counters, and reasons.
 */
export const PROCESS_OWNERSHIP_AUDIT_EVENTS = [
  "task_process_registered",
  "task_process_scope_finished",
  "task_process_cleanup_started",
  "task_process_cleanup_completed",
  "task_process_cleanup_failed",
  "task_process_orphan_recovered",
  "task_process_quiesced_on_hold",
] as const

export type ProcessOwnershipAuditEvent = (typeof PROCESS_OWNERSHIP_AUDIT_EVENTS)[number]

/**
 * Hard worker-first enforcement events. These record the per-root-session state
 * machine transitions: when a non-trivial task requires a worker, when broad root
 * work is blocked, when a real child launch satisfies the requirement, when a
 * worker's evidence enables selective verification, when renewed broad work
 * requires another delegation, and when the escalation chain is exhausted and an
 * explicit, audited exceptional root takeover is permitted. Metadata only.
 */
export const WORKER_FIRST_AUDIT_EVENTS = [
  "root_worker_required",
  "root_bootstrap_allowed",
  "root_grunt_blocked",
  "worker_requirement_satisfied",
  "worker_evidence_available",
  "root_additional_delegation_required",
  "delegation_failure_recorded",
  "delegation_healthy",
  "recovery_probe_started",
  "recovery_verified",
  "recovery_probe_failed",
  "recovery_handoff",
  "recovery_halted",
  "recovery_reconciled",
  "root_recovery_action",
  "root_materialization_action",
  "root_human_authorized_action",
] as const

export type WorkerFirstAuditEvent = (typeof WORKER_FIRST_AUDIT_EVENTS)[number]

/**
 * Concise zero-token events emitted by the delegation-first and watchdog
 * machinery. Flat list is convenient for a switch/validation guard.
 */
export const GOVERNANCE_DELEGATION_WATCHDOG_EVENTS = [
  ...DELEGATION_AUDIT_EVENTS,
  ...WATCHDOG_AUDIT_EVENTS,
  ...WORKER_FIRST_AUDIT_EVENTS,
] as const

/**
 * Paid-model dispatch gate decisions. Exactly one of these events is recorded
 * for every paid/unknown master-model decision: an approval-backed allow, a
 * denial that fell back to a provably-free model, or a denial that could not
 * fall back and therefore failed closed. Metadata only (model ids, approval
 * attribution, reason); never prompts or secrets.
 */
export const PAID_MODEL_GATE_AUDIT_EVENTS = [
  "paid_model_approved_use",
  "paid_model_denied_fallback",
  "paid_model_denied_error",
] as const

export type PaidModelGateAuditEvent = (typeof PAID_MODEL_GATE_AUDIT_EVENTS)[number]
