/**
 * Hard worker-first root-execution state machine. Tracks, per root (MAIN)
 * session, whether broad delegable work is permitted. The invariant: a
 * non-trivial repository task must not be performed by the root — broad
 * exploration is hard-blocked until a real child reaches the request-started
 * lifecycle milestone, and renewed broad work after worker evidence requires
 * another delegation. Only an explicitly-audited escalation exhaustion permits
 * an exceptional root takeover.
 *
 * ROOT_REPAIR_MODE is a first-class phase, NOT a bypass hack: when the
 * delegation/worker system itself is unhealthy (child launch failures, stalls,
 * evidence-pipeline breaks, routing failures, paid-slot exhaustion), the root
 * transitions to root_repair and is AUTHORIZED to perform repository work
 * directly in order to diagnose and fix the delegation machinery. Repair mode
 * does not mark the logical task failed/completed, does not discard assignment
 * context, and is exited back into the normal worker-first lifecycle once one
 * delegation retry succeeds. Persistent failure after a verified repair can
 * escalate to exceptional_takeover (EXCEPTIONAL_ROOT_TAKEOVER).
 *
 * Deterministic and model-free: phase transitions are driven purely by the
 * operation class of each incoming tool call and by explicit lifecycle
 * notifications (`noteWorkerRunning`, `noteWorkerEvidence`,
 * `noteRootRepairEntered`, `noteRootRepairExited`,
 * `noteDelegationRetrySucceeded`, `noteDelegationRetryFailed`,
 * `noteEscalationExhausted`). Never blocks control/delegation/result-retrieval
 * tools, so MAIN can always delegate, inspect worker state, receive results,
 * and respond to the user.
 */

import {
  classifyOperation,
  moduleRoot,
  type GruntSignal,
  type GruntToolHint,
  type OperationClass,
} from "../grunt-guard"

export type RootWorkerPhase =
  | "bootstrap"
  | "worker_required"
  | "worker_active"
  | "worker_evidence_available"
  | "root_repair"
  | "exceptional_takeover"

export type RootWorkerStateConfig = {
  /** Narrow lookups/reads allowed before a delegation is required (bootstrap grace). */
  bootstrapNarrowBudget: number
  /** Single direct edits/writes allowed before implementation becomes delegable. */
  bootstrapImplementationBudget: number
}

export const DEFAULT_ROOT_WORKER_STATE_CONFIG: RootWorkerStateConfig = {
  bootstrapNarrowBudget: 3,
  bootstrapImplementationBudget: 1,
}

export type RootWorkerGateDecision = {
  block: boolean
  delegated: boolean
  selectiveVerification: boolean
  phase: RootWorkerPhase
  opClass: OperationClass
  /** Stable reason code (for the audit journal); null when not blocked. */
  reason: string | null
  /** Best bounded description of the blocked scope (for the steering message). */
  scope: string | null
  signal: GruntSignal
}

type SessionRecord = {
  phase: RootWorkerPhase
  narrowOps: number
  implOps: number
  targets: Set<string>
  modules: Set<string>
  evidenceAnchors: Set<string>
  repairReason: string | null
}

export type RootWorkerState = {
  decide(sessionID: string, tool: string | undefined, hint?: GruntToolHint): RootWorkerGateDecision
  noteWorkerRunning(sessionID: string): void
  noteWorkerEvidence(sessionID: string, anchors?: readonly string[]): void
  noteRootRepairEntered(sessionID: string, reason: string): void
  noteRootRepairExited(sessionID: string): void
  noteDelegationRetrySucceeded(sessionID: string): void
  noteDelegationRetryFailed(sessionID: string): void
  noteEscalationExhausted(sessionID: string): void
  phase(sessionID: string): RootWorkerPhase
  repairReason(sessionID: string): string | null
  evidenceAnchors(sessionID: string): string[]
  reset(sessionID: string): void
  clear(): void
}

export const REASON_BROAD = "broad_delegable_work_before_worker_dispatch"
export const REASON_NARROW = "multiple_reads_before_delegation"
export const REASON_IMPL = "implementation_loop_before_delegation"
export const REASON_ADDITIONAL = "additional_delegation_required"
export const REASON_WAIT = "worker_running_wait_for_result"

function emptySignal(): GruntSignal {
  return {
    gruntCount: 0,
    distinctTargets: 0,
    distinctModules: 0,
    searchCount: 0,
    readCount: 0,
    searchReadSearch: false,
    crossModule: false,
  }
}

export function createRootWorkerState(
  config: Partial<RootWorkerStateConfig> = {},
): RootWorkerState {
  const cfg: RootWorkerStateConfig = { ...DEFAULT_ROOT_WORKER_STATE_CONFIG, ...config }
  const records = new Map<string, SessionRecord>()

  function recordFor(sessionID: string): SessionRecord {
    let rec = records.get(sessionID)
    if (!rec) {
      rec = {
        phase: "bootstrap",
        narrowOps: 0,
        implOps: 0,
        targets: new Set(),
        modules: new Set(),
        evidenceAnchors: new Set(),
        repairReason: null,
      }
      records.set(sessionID, rec)
    }
    return rec
  }

  function signalFor(rec: SessionRecord): GruntSignal {
    return {
      gruntCount: rec.narrowOps + rec.implOps,
      distinctTargets: rec.targets.size,
      distinctModules: rec.modules.size,
      searchCount: 0,
      readCount: rec.narrowOps,
      searchReadSearch: false,
      crossModule: rec.modules.size >= 2,
    }
  }

  function allow(rec: SessionRecord, opts: Partial<RootWorkerGateDecision> = {}): RootWorkerGateDecision {
    return {
      block: false,
      delegated: false,
      selectiveVerification: false,
      phase: rec.phase,
      opClass: "control",
      reason: null,
      scope: null,
      signal: signalFor(rec),
      ...opts,
    }
  }

  function block(rec: SessionRecord, reason: string, opClass: OperationClass, scope: string | null): RootWorkerGateDecision {
    return {
      block: true,
      delegated: false,
      selectiveVerification: false,
      phase: rec.phase,
      opClass,
      reason,
      scope,
      signal: signalFor(rec),
    }
  }

  function recordTarget(rec: SessionRecord, hint?: GruntToolHint): void {
    const target = hint?.target
    if (target && target.length > 0) {
      rec.targets.add(target)
      const root = moduleRoot(target)
      if (root) rec.modules.add(root)
    }
  }

  return {
    decide(sessionID, tool, hint) {
      const opClass = classifyOperation(tool, hint)
      const rec = recordFor(sessionID)

      if (opClass === "delegation" || opClass === "control" || opClass === "metadata") {
        const delegated = opClass === "delegation"
        return allow(rec, { delegated, opClass })
      }

      // Exceptional takeover permits direct root work (audited at transition).
      if (rec.phase === "exceptional_takeover") {
        recordTarget(rec, hint)
        if (opClass === "narrow") rec.narrowOps += 1
        return allow(rec, { opClass })
      }

      // ROOT_REPAIR_MODE permits direct root work. This is the break-glass for
      // fixing the delegation machinery itself: the root may read/grep/bash/
      // edit/test freely while repairing. Repair is NOT exceptional takeover:
      // the logical task stays active and the root returns to worker-first after
      // a verified delegation retry.
      if (rec.phase === "root_repair") {
        recordTarget(rec, hint)
        if (opClass === "narrow") rec.narrowOps += 1
        return allow(rec, { opClass })
      }

      if (rec.phase === "bootstrap") {
        if (opClass === "narrow") {
          rec.narrowOps += 1
          recordTarget(rec, hint)
          const selectiveVerification = hint?.selective === true
          if (rec.narrowOps > cfg.bootstrapNarrowBudget) {
            rec.phase = "worker_required"
            return block(rec, REASON_NARROW, opClass, hint?.target ?? null)
          }
          return { ...allow(rec, { opClass, selectiveVerification }) }
        }
        if (opClass === "broad") {
          rec.phase = "worker_required"
          return block(rec, REASON_BROAD, opClass, hint?.target ?? hint?.command ?? null)
        }
        if (opClass === "implementation") {
          rec.implOps += 1
          if (rec.implOps > cfg.bootstrapImplementationBudget) {
            rec.phase = "worker_required"
            return block(rec, REASON_IMPL, opClass, hint?.target ?? null)
          }
          return allow(rec, { opClass })
        }
        if (opClass === "test_build") {
          rec.phase = "worker_required"
          return block(rec, REASON_IMPL, opClass, hint?.command ?? null)
        }
        return allow(rec, { opClass })
      }

      if (rec.phase === "worker_required") {
        return block(rec, REASON_BROAD, opClass, hint?.target ?? hint?.command ?? null)
      }

      if (rec.phase === "worker_active") {
        if (opClass === "narrow") {
          rec.narrowOps += 1
          recordTarget(rec, hint)
          const selectiveVerification = hint?.selective === true
          return { ...allow(rec, { opClass, selectiveVerification }) }
        }
        return block(rec, REASON_WAIT, opClass, hint?.target ?? hint?.command ?? null)
      }

      // worker_evidence_available
      // Post-evidence verification authority: narrow ops stay anchored to
      // registered evidence; an unrelated narrow op is new investigation.
      if (opClass === "narrow") {
        const anchored = hint?.selective === true || isKnownAnchor(rec, hint)
        if (!anchored) {
          rec.phase = "worker_required"
          return block(rec, REASON_ADDITIONAL, opClass, hint?.target ?? null)
        }
        recordTarget(rec, hint)
        return { ...allow(rec, { opClass, selectiveVerification: true }) }
      }
      if (opClass === "test_build") {
        return allow(rec, { opClass })
      }
      if (opClass === "broad" || opClass === "implementation") {
        rec.phase = "worker_required"
        return block(rec, REASON_ADDITIONAL, opClass, hint?.target ?? hint?.command ?? null)
      }
      return allow(rec, { opClass })
    },

    noteWorkerRunning(sessionID) {
      const rec = recordFor(sessionID)
      if (rec.phase === "bootstrap" || rec.phase === "worker_required" || rec.phase === "worker_active") {
        rec.phase = "worker_active"
      }
    },

    noteWorkerEvidence(sessionID, anchors) {
      const rec = recordFor(sessionID)
      for (const anchor of anchors ?? []) {
        if (anchor) rec.evidenceAnchors.add(anchor)
      }
      rec.phase = "worker_evidence_available"
    },

    noteRootRepairEntered(sessionID, reason) {
      const rec = recordFor(sessionID)
      if (rec.phase === "exceptional_takeover") return
      rec.phase = "root_repair"
      rec.repairReason = reason
    },

    noteRootRepairExited(sessionID) {
      const rec = recordFor(sessionID)
      if (rec.phase !== "root_repair") return
      rec.phase = "worker_required"
      rec.repairReason = null
    },

    noteDelegationRetrySucceeded(sessionID) {
      const rec = recordFor(sessionID)
      if (rec.phase !== "root_repair") return
      rec.phase = "worker_active"
      rec.repairReason = null
    },

    noteDelegationRetryFailed(sessionID) {
      const rec = recordFor(sessionID)
      if (rec.phase !== "root_repair") return
      // stay in root_repair: root continues diagnosis
    },

    noteEscalationExhausted(sessionID) {
      const rec = recordFor(sessionID)
      rec.phase = "exceptional_takeover"
    },

    phase(sessionID) {
      return recordFor(sessionID).phase
    },

    repairReason(sessionID) {
      return recordFor(sessionID).repairReason
    },

    evidenceAnchors(sessionID) {
      return [...recordFor(sessionID).evidenceAnchors]
    },

    reset(sessionID) {
      records.delete(sessionID)
    },

    clear() {
      records.clear()
    },
  }
}

function isKnownAnchor(rec: SessionRecord, hint?: GruntToolHint): boolean {
  const target = hint?.target
  if (!target || target.length === 0) return false
  if (rec.evidenceAnchors.has(target)) return true
  for (const anchor of rec.evidenceAnchors) {
    if (sameAnchorFile(target, anchor)) return true
    if (anchor.includes(target) && !target.includes("/")) return true
  }
  return false
}

/**
 * Compare anchors by their FILE portion. Anchors may carry a `:line`,
 * `:line:col`, or `:line-line` suffix; a bare symbol (no slash/extension)
 * only matches itself so a registered symbol never authorizes a file read.
 */
function sameAnchorFile(a: string, b: string): boolean {
  const fileA = anchorFilePath(a)
  const fileB = anchorFilePath(b)
  if (fileA && fileB) return fileA === fileB
  return a === b
}

function anchorFilePath(value: string): string | undefined {
  if (!value || value.length === 0) return undefined
  const file = value.match(/^([^:\s]+(?:\.\w+)?):\d+(?:-\d+)?(?::\S*)?$/)
  if (file) return file[1]
  if (value.includes("/") && value.includes(".")) return value
  return undefined
}
