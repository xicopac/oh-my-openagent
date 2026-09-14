/**
 * Bounded intervention ladder. OBSERVE -> STATUS_REQUEST -> NUDGE -> RECLAIM ->
 * REPLACE. Never escalates in a single step beyond NUDGE; reclaim happens only
 * after continued stalling, and replacement only when the caller reports that
 * budget justifies a fresh worker.
 */

import type { Intervention, SupervisionPolicy, WorkerHealth, WorkerSignal } from "./types"
import { isInsecure } from "./classify"

export type LadderState = {
  /** Consecutive checks classified as insecure (stall/loop/burn/wedge). */
  insecureChecks: number
  nudgesSent: number
  alreadyReclaimed: boolean
}

export function nextIntervention(
  health: WorkerHealth,
  signal: WorkerSignal,
  policy: SupervisionPolicy,
  state: LadderState,
): Intervention {
  const maxInsecure = signal.isPaid
    ? policy.paidMaxInsecureChecksBeforeReclaim
    : policy.freeMaxInsecureChecksBeforeReclaim

  if (health === "EXHAUSTED") {
    return { action: "RECLAIM", message: "child budget exhausted; preserving partial output", preservePartial: true }
  }
  if (health === "BUDGET_WARNING") {
    return { action: "NUDGE", message: "you are approaching your worker budget; return your best partial result now", preservePartial: false }
  }

  if (!isInsecure(health)) {
    return { action: "OBSERVE", message: "", preservePartial: false }
  }

  if (state.insecureChecks >= maxInsecure) {
    return { action: "RECLAIM", message: "continued stall; reclaiming worker and preserving partial output", preservePartial: true }
  }

  if (state.insecureChecks >= 2) {
    return { action: "NUDGE", message: nudgeMessage(health), preservePartial: false }
  }

  return { action: "STATUS_REQUEST", message: statusRequestMessage(), preservePartial: false }
}

function nudgeMessage(health: WorkerHealth): string {
  if (health === "LOOP") {
    return "you appear to be repeating the same search; stop and try one materially different approach or return existing findings"
  }
  if (health === "TOKEN_BURN") {
    return "you are burning tokens without making progress; stop and return your best partial result"
  }
  return "you appear stalled; report your current phase and next concrete action"
}

function statusRequestMessage(): string {
  return "report current phase, progress since last checkpoint, and any blocker"
}
