/**
 * Pre-grunt gate: a stateful, per-session rolling window that decides EARLY
 * whether an incoming root tool call is part of broad delegable exploration and
 * should be redirected to a free worker. It is the enforceable counterpart to
 * the post-hoc `detectGruntWorkCycle` path.
 *
 * Root exceptions (everything outside the search/read tools) are allowed
 * directly; a single narrow lookup and one anchored (offset+limit) read are
 * allowed; a broad search -> read -> search sweep, a cross-module crawl, or an
 * accumulating grunt count triggers `block` with a steering message.
 */

import {
  DELEGATION_TOOLS,
  GRUNT_TOOLS,
  READ_TOOLS,
  evaluateEarlyDelegation,
  type EarlyDelegationOptions,
  type GruntSignal,
  type ToolActivityEvent,
} from "./detector"

export type GruntToolHint = {
  /** File path (read) or pattern/dir (grep/glob). */
  target?: string
  /** True when the read is anchored to a specific line range (a worker-identified verification). */
  selective?: boolean
  /** Raw shell command for `bash` calls (semantic classification of the command). */
  command?: string
  /** Machine-consumed sentinel for the one allowed end-to-end recovery probe. */
  recoveryProbe?: boolean
  /** Mechanical materialization claim: payload already determined, only persistence needed. */
  materialization?: boolean
  /** Human explicit authorization claim — object { scope, reason }, never a bare boolean. */
  humanAuthorization?: { scope: string; reason: string }
}

export type PreGruntDecision = {
  /** When true, the caller must stop the tool and steer to delegation. */
  block: boolean
  /** Stable reason code for the audit journal. */
  reason: string | null
  /** Instructive message surfaced to the root agent when blocked. */
  steering: string | null
  /** Cheapest free worker/scout hint (model id) or the free scout agent name. */
  freeWorkerHint: string | null
  signal: GruntSignal
  /** True when the call was a delegation tool (window reset). */
  delegated: boolean
  /** True when the call was an allowed anchored read (verification). */
  selectiveVerification: boolean
  /**
   * True when the root session is in recovery_mode and this action is inside
   * the approved recovery scope. Watchdog-authoritative: once true, later
   * normal delegation guards (write-existing-file, heavy-command routing,
   * notepad guard) must NOT re-block this already-authorized action.
   */
  recoveryAuthorized?: boolean
  /** Recovery scope category when recoveryAuthorized (inspection/repair/validation/cleanup/verification). */
  recoveryCategory?: string | null
  materializationAuthorized?: boolean
  materializationCategory?: string | null
  humanAuthorized?: boolean
  authorizationId?: string | null
  authorizationScope?: string | null
}

export type PreGruntGateOptions = Partial<EarlyDelegationOptions> & {
  /** Free model ids (provider/model) ordered cheapest-first, or a single free scout name. */
  freeWorkerHint?: string | null
}

export type PreGruntGate = {
  /** Record + classify the incoming root tool call in the session window. */
  inspect(sessionID: string, tool: string, hint?: GruntToolHint, contextPressure?: number): PreGruntDecision
  /** Drop a session's window. */
  reset(sessionID: string): void
  /** True if the session has been steered (blocked) and not yet delegated. */
  isSteered(sessionID: string): boolean
  clear(): void
}

export function createPreGruntGate(options: PreGruntGateOptions = {}): PreGruntGate {
  const windows = new Map<string, ToolActivityEvent[]>()
  const steered = new Set<string>()
  const { freeWorkerHint = null, ...earlyOptions } = options

  return {
    inspect(sessionID, tool, hint, contextPressure) {
      const now = Date.now()
      const isDelegation = DELEGATION_TOOLS.has(tool)
      const isGrunt = GRUNT_TOOLS.has(tool)
      const isRead = READ_TOOLS.has(tool)

      // Delegation resets the window and marks the steer as dispatched.
      if (isDelegation) {
        steered.delete(sessionID)
        const window = windows.get(sessionID) ?? []
        const truncated = window.length === 0 ? window : []
        windows.set(sessionID, truncated)
        return {
          block: false,
          reason: null,
          steering: null,
          freeWorkerHint: null,
          signal: emptySignal(),
          delegated: true,
          selectiveVerification: false,
        }
      }

      // Non-grunt tools are root exceptions: metadata, edits, diffs, git, etc.
      if (!isGrunt) {
        return {
          block: false,
          reason: null,
          steering: null,
          freeWorkerHint: null,
          signal: emptySignal(),
          delegated: false,
          selectiveVerification: false,
        }
      }

      const selective = isRead && hint?.selective === true
      const event: ToolActivityEvent = {
        tool,
        atMs: now,
        ...(hint?.target ? { target: hint.target } : {}),
        ...(selective ? { selective: true } : {}),
      }

      const window = windows.get(sessionID) ?? []
      window.push(event)
      // Bound the retained window so a long-lived main session never grows it.
      const keep = window.filter((e) => e.atMs >= now - MAX_WINDOW_MS)
      windows.set(sessionID, keep)

      if (selective) {
        return {
          block: false,
          reason: null,
          steering: null,
          freeWorkerHint: null,
          signal: emptySignal(),
          delegated: false,
          selectiveVerification: true,
        }
      }

      const verdict = evaluateEarlyDelegation(keep, {
        ...earlyOptions,
        contextPressure: contextPressure ?? earlyOptions.contextPressure ?? 0,
      })

      if (verdict.shouldDelegate) {
        steered.add(sessionID)
        return {
          block: true,
          reason: verdict.reason,
          steering: buildSteeringMessage(verdict.effectiveThreshold),
          freeWorkerHint,
          signal: verdict.signal,
          delegated: false,
          selectiveVerification: false,
        }
      }

      return {
        block: false,
        reason: null,
        steering: null,
        freeWorkerHint: null,
        signal: verdict.signal,
        delegated: false,
        selectiveVerification: false,
      }
    },
    reset(sessionID) {
      windows.delete(sessionID)
      steered.delete(sessionID)
    },
    isSteered(sessionID) {
      return steered.has(sessionID)
    },
    clear() {
      windows.clear()
      steered.clear()
    },
  }
}

const MAX_WINDOW_MS = 10 * 60_000

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

function buildSteeringMessage(threshold: number): string {
  return [
    "Broad repository exploration detected without delegation.",
    `Delegate this investigation to a free worker (e.g. task with subagent_type \"explore\" or \"librarian\") and consume the returned file/symbol/anchors instead of crawling the repo yourself.`,
    "You may still read one specific file/line that a worker already identified.",
    `The delegation resets this gate; ${threshold} accumulated search/read operations re-arm it.`,
  ].join(" ")
}
