/**
 * Hard worker-first root execution state plus its evidence-gated recovery
 * extension. Normal phases preserve the existing delegation invariant.
 * Recovery authority is derived only from deduplicated machine observations;
 * no public "enter recovery" assertion exists.
 */

import {
  classifyOperation,
  moduleRoot,
  type GruntSignal,
  type GruntToolHint,
  type OperationClass,
} from "../grunt-guard"
import { evaluateRecoveryScope, type RecoveryScopeCategory } from "./recovery-scope"
import { evaluateMaterializationScope, type MaterializationScopeCategory } from "./materialization-scope"
import {
  createHumanAuthorizationRegistry,
  isHardSafetyViolation,
  type HumanAuthorizationClaim,
  type HumanExplicitAuthorization,
} from "./human-explicit-authorization"

export type NormalRootWorkerPhase =
  | "bootstrap"
  | "worker_required"
  | "worker_active"
  | "worker_evidence_available"

export type DelegationRecoveryPhase =
  | "normal"
  | "delegation_degraded"
  | "recovery_mode"
  | "recovery_verified"
  | "handoff"
  | "halt"

export type RootWorkerPhase = NormalRootWorkerPhase | Exclude<DelegationRecoveryPhase, "normal">

export type DelegationFailureKind =
  | "child_startup_failure"
  | "watchdog_reclaim_exhausted"
  | "routing_exhausted"
  | "evidence_pipeline_failure"
  | "control_plane_failure"
  | "circular_deadlock"

export type DelegationFailureEvidence = {
  /** Stable machine identity for deduplication, such as a task/session/attempt id. */
  id: string
  kind: DelegationFailureKind
  reason: string
  observedAtMs: number
  taskID?: string
  childSessionID?: string | null
}

export type RecoveryProbeState = {
  probeID: string
  nonce: string
}

export type DelegationRecoverySnapshot = {
  phase: DelegationRecoveryPhase
  evidence: DelegationFailureEvidence[]
  activeProbe: RecoveryProbeState | null
  verificationAttempts: number
  verified: boolean
  handoffPath: string | null
  failureReason: string | null
}

export type DelegationFailureTransition = {
  accepted: boolean
  before: RootWorkerPhase
  after: RootWorkerPhase
  evidenceCount: number
}

export type RootWorkerStateConfig = {
  bootstrapNarrowBudget: number
  bootstrapImplementationBudget: number
  recoveryEvidenceThreshold: number
  maxRecoveryVerificationAttempts: number
}

export const DEFAULT_ROOT_WORKER_STATE_CONFIG: RootWorkerStateConfig = {
  bootstrapNarrowBudget: 3,
  bootstrapImplementationBudget: 1,
  recoveryEvidenceThreshold: 2,
  maxRecoveryVerificationAttempts: 2,
}

export type RootWorkerGateDecision = {
  block: boolean
  delegated: boolean
  selectiveVerification: boolean
  phase: RootWorkerPhase
  opClass: OperationClass
  reason: string | null
  scope: string | null
  signal: GruntSignal
  recoveryCategory: RecoveryScopeCategory | null
  materializationCategory?: MaterializationScopeCategory | null
  humanAuthorized?: boolean
  authorizationId?: string | null
  authorizationScope?: string | null
}

type SessionRecord = {
  workPhase: NormalRootWorkerPhase
  recoveryPhase: DelegationRecoveryPhase
  narrowOps: number
  implOps: number
  targets: Set<string>
  modules: Set<string>
  evidenceAnchors: Set<string>
  recoveryEvidence: Map<string, DelegationFailureEvidence>
  activeProbe: RecoveryProbeState | null
  verificationAttempts: number
  verified: boolean
  handoffPath: string | null
  failureReason: string | null
}

export type RootWorkerState = {
  decide(sessionID: string, tool: string | undefined, hint?: GruntToolHint): RootWorkerGateDecision
  noteWorkerRunning(sessionID: string): void
  noteWorkerEvidence(sessionID: string, anchors?: readonly string[]): void
  noteDelegationHealthy(sessionID: string): void
  recordDelegationFailure(sessionID: string, evidence: DelegationFailureEvidence): DelegationFailureTransition
  beginRecoveryProbe(sessionID: string, probeID: string, nonce: string): boolean
  markRecoveryVerified(sessionID: string, probeID: string): boolean
  recordRecoveryProbeFailure(sessionID: string, probeID: string, reason: string): RootWorkerPhase
  markRecoveryHandoff(sessionID: string, path: string): boolean
  markRecoveryHalted(sessionID: string): void
  recoverySnapshot(sessionID: string): DelegationRecoverySnapshot
  phase(sessionID: string): RootWorkerPhase
  repairReason(sessionID: string): string | null
  evidenceAnchors(sessionID: string): string[]
  grantHumanAuthorization(sessionID: string, auth: HumanExplicitAuthorization): void
  humanAuthorizations(sessionID: string): readonly HumanExplicitAuthorization[]
  reset(sessionID: string): void
  clear(): void
}

export const REASON_BROAD = "broad_delegable_work_before_worker_dispatch"
export const REASON_NARROW = "multiple_reads_before_delegation"
export const REASON_IMPL = "implementation_loop_before_delegation"
export const REASON_ADDITIONAL = "additional_delegation_required"
export const REASON_WAIT = "worker_running_wait_for_result"
export const REASON_RECOVERY_SCOPE = "outside_delegation_recovery_scope"
export const REASON_RECOVERY_TERMINAL = "delegation_recovery_halted"
export const REASON_HARD_SAFETY = "hard_safety_restriction"
export const REASON_HUMAN_AUTHORIZED = "human_explicit_authorization"

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
  const humanRegistry = createHumanAuthorizationRegistry()

  function recordFor(sessionID: string): SessionRecord {
    let rec = records.get(sessionID)
    if (!rec) {
      rec = {
        workPhase: "bootstrap",
        recoveryPhase: "normal",
        narrowOps: 0,
        implOps: 0,
        targets: new Set(),
        modules: new Set(),
        evidenceAnchors: new Set(),
        recoveryEvidence: new Map(),
        activeProbe: null,
        verificationAttempts: 0,
        verified: false,
        handoffPath: null,
        failureReason: null,
      }
      records.set(sessionID, rec)
    }
    return rec
  }

  function phaseFor(rec: SessionRecord): RootWorkerPhase {
    return rec.recoveryPhase === "normal" ? rec.workPhase : rec.recoveryPhase
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

  function allow(
    rec: SessionRecord,
    opts: Partial<RootWorkerGateDecision> = {},
  ): RootWorkerGateDecision {
    return {
      block: false,
      delegated: false,
      selectiveVerification: false,
      phase: phaseFor(rec),
      opClass: "control",
      reason: null,
      scope: null,
      signal: signalFor(rec),
      recoveryCategory: null,
      ...opts,
    }
  }

  function block(
    rec: SessionRecord,
    reason: string,
    opClass: OperationClass,
    scope: string | null,
  ): RootWorkerGateDecision {
    return {
      block: true,
      delegated: false,
      selectiveVerification: false,
      phase: phaseFor(rec),
      opClass,
      reason,
      scope,
      signal: signalFor(rec),
      recoveryCategory: null,
    }
  }

  function recordTarget(rec: SessionRecord, hint?: GruntToolHint): void {
    const target = hint?.target
    if (!target) return
    rec.targets.add(target)
    const root = moduleRoot(target)
    if (root) rec.modules.add(root)
  }

  function recordFailure(
    rec: SessionRecord,
    evidence: DelegationFailureEvidence,
  ): boolean {
    const id = evidence.id.trim()
    if (!id || rec.recoveryEvidence.has(id) || rec.recoveryPhase === "halt") return false
    rec.recoveryEvidence.set(id, { ...evidence, id })
    rec.failureReason = evidence.reason
    rec.workPhase = "worker_required"
    if (rec.recoveryPhase === "normal") rec.recoveryPhase = "delegation_degraded"
    if (rec.recoveryEvidence.size >= cfg.recoveryEvidenceThreshold) {
      rec.recoveryPhase = "recovery_mode"
    }
    return true
  }

  function addCircularDeadlockEvidence(
    rec: SessionRecord,
    tool: string | undefined,
    hint?: GruntToolHint,
  ): void {
    const identity = hint?.target ?? hint?.command ?? tool ?? "unknown"
    recordFailure(rec, {
      id: `circular-deadlock:${identity}`,
      kind: "circular_deadlock",
      reason: "watchdog_required_delegation_for_delegation_repair",
      observedAtMs: Date.now(),
    })
  }

  function decideNormal(
    rec: SessionRecord,
    opClass: OperationClass,
    hint?: GruntToolHint,
  ): RootWorkerGateDecision {
    if (opClass === "delegation" || opClass === "control" || opClass === "metadata") {
      return allow(rec, { delegated: opClass === "delegation", opClass })
    }

    if (rec.workPhase === "bootstrap") {
      if (opClass === "narrow") {
        rec.narrowOps += 1
        recordTarget(rec, hint)
        const selectiveVerification = hint?.selective === true
        if (rec.narrowOps > cfg.bootstrapNarrowBudget) {
          rec.workPhase = "worker_required"
          return block(rec, REASON_NARROW, opClass, hint?.target ?? null)
        }
        return allow(rec, { opClass, selectiveVerification })
      }
      if (opClass === "broad") {
        rec.workPhase = "worker_required"
        return block(rec, REASON_BROAD, opClass, hint?.target ?? hint?.command ?? null)
      }
      if (opClass === "implementation") {
        rec.implOps += 1
        if (rec.implOps > cfg.bootstrapImplementationBudget) {
          rec.workPhase = "worker_required"
          return block(rec, REASON_IMPL, opClass, hint?.target ?? null)
        }
        return allow(rec, { opClass })
      }
      if (opClass === "test_build") {
        rec.workPhase = "worker_required"
        return block(rec, REASON_IMPL, opClass, hint?.command ?? null)
      }
      return allow(rec, { opClass })
    }

    if (rec.workPhase === "worker_required") {
      return block(rec, REASON_BROAD, opClass, hint?.target ?? hint?.command ?? null)
    }

    if (rec.workPhase === "worker_active") {
      if (opClass === "narrow") {
        rec.narrowOps += 1
        recordTarget(rec, hint)
        return allow(rec, { opClass, selectiveVerification: hint?.selective === true })
      }
      return block(rec, REASON_WAIT, opClass, hint?.target ?? hint?.command ?? null)
    }

    if (opClass === "narrow") {
      const anchored = hint?.selective === true || isKnownAnchor(rec, hint)
      if (!anchored) {
        rec.workPhase = "worker_required"
        return block(rec, REASON_ADDITIONAL, opClass, hint?.target ?? null)
      }
      recordTarget(rec, hint)
      return allow(rec, { opClass, selectiveVerification: true })
    }
    if (opClass === "test_build") return allow(rec, { opClass })
    if (opClass === "broad" || opClass === "implementation") {
      rec.workPhase = "worker_required"
      return block(rec, REASON_ADDITIONAL, opClass, hint?.target ?? hint?.command ?? null)
    }
    return allow(rec, { opClass })
  }

  return {
    decide(sessionID, tool, hint) {
      const opClass = classifyOperation(tool, hint)
      const rec = recordFor(sessionID)

      // 1. Hard safety/integrity restriction — never overridden by human auth
      const hardSafety = isHardSafetyViolation(tool, hint)
      if (hardSafety) {
        return block(rec, REASON_HARD_SAFETY, opClass, hint?.target ?? hint?.command ?? null)
      }

      // 2. Terminal/HALT restrictions — authoritative even over human claim
      if (rec.recoveryPhase === "recovery_verified" || rec.recoveryPhase === "handoff" || rec.recoveryPhase === "halt") {
        return block(rec, REASON_RECOVERY_TERMINAL, opClass, hint?.target ?? hint?.command ?? null)
      }

      // 3. Explicit human authorization — overrides delegation policy, not safety/terminal
      const humanClaim = (hint as { humanAuthorization?: HumanAuthorizationClaim })?.humanAuthorization
      if (
        humanClaim &&
        typeof humanClaim.scope === "string" &&
        typeof humanClaim.reason === "string" &&
        humanClaim.scope.trim().length > 0 &&
        humanClaim.reason.trim().length > 0
      ) {
        const action = { tool, target: hint?.target, command: hint?.command }
        const covering = humanRegistry.coveringAuthorization(sessionID, humanClaim, action)
        if (covering) {
          recordTarget(rec, hint)
          if (opClass === "narrow") rec.narrowOps += 1
          return allow(rec, {
            opClass,
            humanAuthorized: true,
            authorizationId: covering.id,
            authorizationScope: covering.scope,
          })
        }
      }

      if (rec.recoveryPhase === "recovery_mode") {
        const scope = evaluateRecoveryScope(tool, hint)
        if (!scope.allowed) {
          return block(rec, REASON_RECOVERY_SCOPE, opClass, hint?.target ?? hint?.command ?? null)
        }
        recordTarget(rec, hint)
        if (opClass === "narrow") rec.narrowOps += 1
        return allow(rec, {
          delegated: opClass === "delegation",
          opClass,
          recoveryCategory: scope.category,
        })
      }

      const mc = evaluateMaterializationScope(tool, hint)
      if (mc.allowed) {
        recordTarget(rec, hint)
        if (opClass === "narrow") rec.narrowOps += 1
        return allow(rec, { opClass, materializationCategory: mc.category })
      }
      if ((hint as { materialization?: boolean })?.materialization === true) {
        return block(rec, mc.reason ?? "materialization_denied", opClass, hint?.target ?? hint?.command ?? null)
      }

      if (rec.recoveryPhase === "delegation_degraded") {
        const recoveryScope = evaluateRecoveryScope(tool, hint)
        const normalDecision = decideNormal(rec, opClass, hint)
        if (normalDecision.block && recoveryScope.allowed && opClass !== "delegation") {
          addCircularDeadlockEvidence(rec, tool, hint)
          // re-read via phaseFor (function call, un-narrowed): the circular
          // deadlock evidence may have promoted the session to recovery_mode.
          if (phaseFor(rec) === "recovery_mode") {
            recordTarget(rec, hint)
            return allow(rec, { opClass, recoveryCategory: recoveryScope.category })
          }
        }
        return normalDecision
      }

      return decideNormal(rec, opClass, hint)
    },

    noteWorkerRunning(sessionID) {
      const rec = recordFor(sessionID)
      if (rec.recoveryPhase !== "normal") return
      if (rec.workPhase === "bootstrap" || rec.workPhase === "worker_required" || rec.workPhase === "worker_active") {
        rec.workPhase = "worker_active"
      }
    },

    noteWorkerEvidence(sessionID, anchors) {
      const rec = recordFor(sessionID)
      for (const anchor of anchors ?? []) {
        if (anchor) rec.evidenceAnchors.add(anchor)
      }
      if (rec.recoveryPhase === "normal") rec.workPhase = "worker_evidence_available"
    },

    noteDelegationHealthy(sessionID) {
      const rec = recordFor(sessionID)
      if (rec.recoveryPhase !== "delegation_degraded") return
      rec.recoveryPhase = "normal"
      rec.recoveryEvidence.clear()
      rec.failureReason = null
      rec.workPhase = "worker_active"
    },

    recordDelegationFailure(sessionID, evidence) {
      const rec = recordFor(sessionID)
      const before = phaseFor(rec)
      const accepted = recordFailure(rec, evidence)
      return {
        accepted,
        before,
        after: phaseFor(rec),
        evidenceCount: rec.recoveryEvidence.size,
      }
    },

    beginRecoveryProbe(sessionID, probeID, nonce) {
      const rec = recordFor(sessionID)
      if (rec.recoveryPhase !== "recovery_mode" || rec.activeProbe || !probeID || !nonce) return false
      rec.activeProbe = { probeID, nonce }
      return true
    },

    markRecoveryVerified(sessionID, probeID) {
      const rec = recordFor(sessionID)
      if (rec.recoveryPhase !== "recovery_mode" || rec.activeProbe?.probeID !== probeID) return false
      rec.verified = true
      rec.failureReason = null
      rec.recoveryPhase = "recovery_verified"
      return true
    },

    recordRecoveryProbeFailure(sessionID, probeID, reason) {
      const rec = recordFor(sessionID)
      if (rec.recoveryPhase !== "recovery_mode" || rec.activeProbe?.probeID !== probeID) return phaseFor(rec)
      rec.verificationAttempts += 1
      rec.failureReason = reason
      rec.activeProbe = null
      if (rec.verificationAttempts >= cfg.maxRecoveryVerificationAttempts) {
        rec.recoveryPhase = "halt"
      }
      return phaseFor(rec)
    },

    markRecoveryHandoff(sessionID, path) {
      const rec = recordFor(sessionID)
      if (rec.recoveryPhase !== "recovery_verified" || !path) return false
      rec.handoffPath = path
      rec.recoveryPhase = "handoff"
      return true
    },

    markRecoveryHalted(sessionID) {
      const rec = recordFor(sessionID)
      if (rec.recoveryPhase === "handoff" || rec.recoveryPhase === "halt") {
        rec.recoveryPhase = "halt"
      }
    },

    recoverySnapshot(sessionID) {
      const rec = recordFor(sessionID)
      return {
        phase: rec.recoveryPhase,
        evidence: [...rec.recoveryEvidence.values()],
        activeProbe: rec.activeProbe ? { ...rec.activeProbe } : null,
        verificationAttempts: rec.verificationAttempts,
        verified: rec.verified,
        handoffPath: rec.handoffPath,
        failureReason: rec.failureReason,
      }
    },

    phase(sessionID) {
      return phaseFor(recordFor(sessionID))
    },

    repairReason(sessionID) {
      return recordFor(sessionID).failureReason
    },

    evidenceAnchors(sessionID) {
      return [...recordFor(sessionID).evidenceAnchors]
    },

    grantHumanAuthorization(sessionID, auth) {
      humanRegistry.grant(sessionID, auth)
    },

    humanAuthorizations(sessionID) {
      return humanRegistry.authorizations(sessionID)
    },

    reset(sessionID) {
      records.delete(sessionID)
      humanRegistry.clear(sessionID)
    },

    clear() {
      records.clear()
      humanRegistry.clear()
    },
  }
}

function isKnownAnchor(rec: SessionRecord, hint?: GruntToolHint): boolean {
  const target = hint?.target
  if (!target) return false
  if (rec.evidenceAnchors.has(target)) return true
  for (const anchor of rec.evidenceAnchors) {
    if (sameAnchorFile(target, anchor)) return true
    if (anchor.includes(target) && !target.includes("/")) return true
  }
  return false
}

function sameAnchorFile(a: string, b: string): boolean {
  const fileA = anchorFilePath(a)
  const fileB = anchorFilePath(b)
  if (fileA && fileB) return fileA === fileB
  return a === b
}

function anchorFilePath(value: string): string | undefined {
  if (!value) return undefined
  const file = value.match(/^([^:\s]+(?:\.\w+)?):\d+(?:-\d+)?(?::\S*)?$/)
  if (file) return file[1]
  if (value.includes("/") && value.includes(".")) return value
  return undefined
}
