/**
 * Root grunt-work guard. Detects when the MAIN/root agent performs a broad
 * repetitive search -> read -> test cycle WITHOUT first delegating to a worker.
 *
 * Two layers:
 *   - `detectGruntWorkCycle` (post-hoc): counts search/read calls in a window;
 *     used by the delegation-first runtime's `onToolActivity` to emit the
 *     advisory `root_direct_exception` audit event.
 *   - `analyzeGruntSignals` + `evaluateEarlyDelegation` (early): richer,
 *     signal-based classification used by the PRE-GRUNT gate to stop/redirect
 *     broad delegable root exploration BEFORE it accumulates.
 */

export type ToolActivityEvent = { tool: string; atMs: number; target?: string; selective?: boolean }

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

/** Search-side tools (produce a set of candidates, not a single file read). */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  "grep",
  "glob",
  "session_search",
])

/** Read-side tools (consume a candidate). */
export const READ_TOOLS: ReadonlySet<string> = new Set(["read", "session_read"])

/** Delegation tools that reset the running grunt counter (the root delegated). */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(["task", "call_omo_agent"])

export type GruntVerdict = { grunt: boolean; reason: string | null; gruntCount: number }

export type GruntSignal = {
  /** Weighted count of non-selective grunt operations in the window. */
  gruntCount: number
  /** Distinct non-empty targets (file paths / globs) touched. */
  distinctTargets: number
  /** Distinct top-level path segments (module roots) touched. */
  distinctModules: number
  searchCount: number
  readCount: number
  /** True when the window contains search -> read -> search ordering. */
  searchReadSearch: boolean
  /** True when two or more module roots were touched while grunting. */
  crossModule: boolean
}

export type EarlyDelegationOptions = {
  /** Weighted grunt threshold at (or above) which delegation is required. */
  searchReadThreshold: number
  /** Min grunt ops to fire the cross-module signal. */
  crossModuleMinOps: number
  /** Min distinct module roots to fire the cross-module signal. */
  crossModuleMinModules: number
  /** 0..1 context pressure; higher pressure lowers the threshold. */
  contextPressure: number
}

export const DEFAULT_EARLY_DELEGATION_OPTIONS: EarlyDelegationOptions = {
  searchReadThreshold: 4,
  crossModuleMinOps: 3,
  crossModuleMinModules: 2,
  contextPressure: 0,
}

export type EarlyDelegationVerdict = {
  shouldDelegate: boolean
  reason: string | null
  signal: GruntSignal
  /** Effective threshold after context-pressure adjustment (for observability). */
  effectiveThreshold: number
}

/**
 * Extract the top-level module root from a target (file path or glob). Returns
 * the first non-empty, non-dot path segment; empty for pattern-only targets.
 */
export function moduleRoot(target: string | undefined): string {
  if (!target) return ""
  const clean = target.replace(/^\.\//, "").replace(/^\/+/, "")
  const segments = clean.split("/").filter((s) => s.length > 0 && s !== "." && s !== "..")
  if (segments.length === 0) return ""
  return segments[0]
}

/**
 * Walk a trailing window of tool activity in time order and compute grunt
 * signals. A delegation tool resets the running signals; a selective read
 * (anchored `read` with offset+limit) is a verification and contributes no
 * grunt weight; every other grunt tool contributes weight 1.
 */
export function analyzeGruntSignals(
  events: ToolActivityEvent[],
  options?: Partial<GruntGuardOptions>,
): GruntSignal {
  const { windowMs } = { ...DEFAULT_GRUNT_GUARD_OPTIONS, ...options }

  if (events.length === 0) {
    return emptySignal()
  }

  const latestEventAtMs = Math.max(...events.map((e) => e.atMs))
  const windowStartMs = latestEventAtMs - windowMs
  const inWindow = events
    .filter((e) => e.atMs >= windowStartMs && e.atMs <= latestEventAtMs)
    .sort((a, b) => a.atMs - b.atMs)

  let gruntCount = 0
  let searchCount = 0
  let readCount = 0
  const targets = new Set<string>()
  const modules = new Set<string>()

  // Track the last side seen (search vs read) to detect search->read->search.
  let lastSide: "search" | "read" | null = null
  let searchReadSearch = false

  for (const event of inWindow) {
    if (DELEGATION_TOOLS.has(event.tool)) {
      gruntCount = 0
      searchCount = 0
      readCount = 0
      targets.clear()
      modules.clear()
      lastSide = null
      searchReadSearch = false
      continue
    }
    if (!GRUNT_TOOLS.has(event.tool)) continue

    const target = event.target && event.target.length > 0 ? event.target : undefined
    const isSelective = event.selective === true

    if (target) {
      targets.add(target)
      const root = moduleRoot(target)
      if (root) modules.add(root)
    }

    const side: "search" | "read" = SEARCH_TOOLS.has(event.tool) ? "search" : "read"
    if (side === "search") {
      searchCount += 1
      if (!isSelective) gruntCount += 1
      if (lastSide === "read") searchReadSearch = true
      lastSide = "search"
    } else {
      readCount += 1
      if (!isSelective) gruntCount += 1
      lastSide = "read"
    }
  }

  return {
    gruntCount,
    distinctTargets: targets.size,
    distinctModules: modules.size,
    searchCount,
    readCount,
    searchReadSearch,
    crossModule: modules.size >= 2,
  }
}

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

/**
 * Early-delegation decision from a trailing window. Conservative enough not to
 * block a single narrow lookup or one anchored read, but aggressive enough that
 * a broad search -> read -> search sweep across modules is flagged well before
 * many root operations accumulate. Context pressure lowers the threshold so a
 * nearly-full root delegates sooner.
 */
export function evaluateEarlyDelegation(
  events: ToolActivityEvent[],
  options?: Partial<EarlyDelegationOptions>,
): EarlyDelegationVerdict {
  const opts = { ...DEFAULT_EARLY_DELEGATION_OPTIONS, ...options }
  const signal = analyzeGruntSignals(events)

  const pressure = clamp01(opts.contextPressure)
  const pressureCredit = Math.round(pressure * 2) // 0 at low, up to 2 at full
  const effectiveThreshold = Math.max(1, opts.searchReadThreshold - pressureCredit)

  let shouldDelegate = false
  let reason: string | null = null

  if (signal.crossModule && signal.gruntCount >= opts.crossModuleMinOps) {
    shouldDelegate = true
    reason = `cross-module exploration (${signal.distinctModules} modules, ${signal.gruntCount} ops) without delegation`
  } else if (signal.searchReadSearch && signal.distinctTargets >= 2) {
    shouldDelegate = true
    reason = `search -> read -> search sweep (${signal.searchCount} searches, ${signal.readCount} reads, ${signal.distinctTargets} targets) without delegation`
  } else if (signal.gruntCount >= effectiveThreshold) {
    shouldDelegate = true
    reason = `${signal.gruntCount} search/read ops without delegation in window (threshold ${effectiveThreshold})`
  }

  return { shouldDelegate, reason, signal, effectiveThreshold }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

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
