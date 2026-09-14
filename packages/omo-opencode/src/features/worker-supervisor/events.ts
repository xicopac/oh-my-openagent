/** Structured supervision events written into the Resource Ledger's event stream. */

export const SUPERVISION_EVENTS = [
  "worker-supervision-check",
  "worker-suspected-stall",
  "worker-suspected-loop",
  "worker-nudged",
  "worker-budget-warning",
  "worker-reclaimed",
  "worker-replaced",
  "worker-partial-result-preserved",
  "worker-stall-cleared",
] as const

export type SupervisionEventName = (typeof SUPERVISION_EVENTS)[number]
