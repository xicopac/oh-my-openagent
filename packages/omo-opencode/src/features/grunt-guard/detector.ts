/**
 * Root grunt-work guard. Detects when the MAIN/root agent performs a broad
 * repetitive search -> read -> test cycle WITHOUT first delegating to a worker.
 * This is orchestration GUIDANCE (an audit warning + steering signal), NOT a
 * hard ban on tool use. The detector only produces a verdict; the caller
 * decides whether to steer or warn.
 */

export type ToolActivityEvent = { tool: string; atMs: number }

export type GruntGuardOptions = { windowMs: number; searchReadThreshold: number }

export const DEFAULT_GRUNT_GUARD_OPTIONS: GruntGuardOptions = {
  windowMs: 120_000,
  searchReadThreshold: 5,
}

/** Search/read tools that, when repeated without delegation, signal grunt work. */
export const GRUNT_TOOLS: ReadonlySet<string> = new Set([
  "grep",
  "glob",
  "read",
  "session_search",
  "session_read",
])

/** Delegation tools that reset the running grunt counter (the root delegated). */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(["task", "call_omo_agent"])

export type GruntVerdict = { grunt: boolean; reason: string | null; gruntCount: number }

/**
 * Deterministically classify a trailing window of tool activity as grunt work.
 *
 * Only events whose `atMs` falls within `[latestEventAtMs - windowMs,
 * latestEventAtMs]` are considered. Events are walked in time order: a
 * delegation tool resets the running counter to 0, and each grunt tool
 * increments it. The verdict is grunt when the final counter reaches the
 * threshold.
 */
export function detectGruntWorkCycle(
  events: ToolActivityEvent[],
  options?: Partial<GruntGuardOptions>,
): GruntVerdict {
  const { windowMs, searchReadThreshold } = { ...DEFAULT_GRUNT_GUARD_OPTIONS, ...options }

  if (events.length === 0) {
    return { grunt: false, reason: null, gruntCount: 0 }
  }

  const latestEventAtMs = Math.max(...events.map((e) => e.atMs))
  const windowStartMs = latestEventAtMs - windowMs

  const inWindow = events
    .filter((e) => e.atMs >= windowStartMs && e.atMs <= latestEventAtMs)
    .sort((a, b) => a.atMs - b.atMs)

  let counter = 0
  for (const event of inWindow) {
    if (DELEGATION_TOOLS.has(event.tool)) {
      counter = 0
    } else if (GRUNT_TOOLS.has(event.tool)) {
      counter += 1
    }
  }

  const grunt = counter >= searchReadThreshold && counter > 0
  const reason = grunt
    ? `${counter} search/read tool calls without delegation in window`
    : null

  return { grunt, reason, gruntCount: counter }
}
