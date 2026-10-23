/**
 * Minimal working document with a retrievable history reference.
 *
 * The document is always compact: it carries the objective, hard constraints,
 * current phase/next action, decisions, artifact references, and a bounded
 * history reference. Full history is never inlined; the reference (retrieval
 * id, message range, item count, short summary) is enough for a later bounded
 * retrieval call.
 *
 * All functions are pure so they trivially table-test.
 */

import { estimateTokens } from "./context-payload-budget"

export const DEFAULT_WORKING_DOCUMENT_TOKENS = 1000

export type HistoryEntry = {
  readonly id?: string
  readonly role?: string
  readonly text: string
}

export type HistoryRef = {
  readonly retrievalId: string
  readonly startIndex: number
  readonly endIndex: number
  readonly count: number
  readonly summary: string
}

export type WorkingDocumentInput = {
  readonly objective: string
  readonly constraints?: readonly string[]
  readonly phase?: string
  readonly nextAction?: string
  readonly decisions?: readonly string[]
  readonly artifacts?: readonly string[]
  readonly history?: readonly HistoryEntry[]
  readonly historyRetrievalId?: string
  readonly historySummary?: string
  readonly maxTokens?: number
}

export type WorkingDocument = {
  readonly text: string
  readonly objective: string
  readonly constraints: readonly string[]
  readonly phase?: string
  readonly nextAction?: string
  readonly decisions: readonly string[]
  readonly artifacts: readonly string[]
  readonly historyRef?: HistoryRef
  readonly estimatedTokens: number
  readonly truncated: boolean
}

type RenderShape = {
  readonly summaryChars: number
  readonly includeAllDecisions: boolean
  readonly decisionLimit: number
  readonly decisionItemChars: number
  readonly includePhase: boolean
  readonly includeDecisions: boolean
  readonly objectiveChars: number
  readonly constraintItemChars: number
  readonly compactArtifacts: boolean
}

/**
 * Deterministic truncation ladder. Never drops objective, constraints,
 * next action, artifact references, or the history reference. Verbose history
 * summary and duplicates are reduced first, then phase/decisions/objective.
 */
const RENDER_SHAPES: readonly RenderShape[] = [
  {
    summaryChars: 200,
    includeAllDecisions: true,
    decisionLimit: 0,
    decisionItemChars: 240,
    includePhase: true,
    includeDecisions: true,
    objectiveChars: 800,
    constraintItemChars: 240,
    compactArtifacts: false,
  },
  {
    summaryChars: 160,
    includeAllDecisions: true,
    decisionLimit: 0,
    decisionItemChars: 200,
    includePhase: true,
    includeDecisions: true,
    objectiveChars: 600,
    constraintItemChars: 200,
    compactArtifacts: false,
  },
  {
    summaryChars: 140,
    includeAllDecisions: false,
    decisionLimit: 8,
    decisionItemChars: 160,
    includePhase: true,
    includeDecisions: true,
    objectiveChars: 500,
    constraintItemChars: 180,
    compactArtifacts: false,
  },
  {
    summaryChars: 120,
    includeAllDecisions: false,
    decisionLimit: 4,
    decisionItemChars: 120,
    includePhase: true,
    includeDecisions: true,
    objectiveChars: 400,
    constraintItemChars: 160,
    compactArtifacts: false,
  },
  {
    summaryChars: 100,
    includeAllDecisions: false,
    decisionLimit: 0,
    decisionItemChars: 0,
    includePhase: true,
    includeDecisions: false,
    objectiveChars: 320,
    constraintItemChars: 140,
    compactArtifacts: false,
  },
  {
    summaryChars: 80,
    includeAllDecisions: false,
    decisionLimit: 0,
    decisionItemChars: 0,
    includePhase: false,
    includeDecisions: false,
    objectiveChars: 240,
    constraintItemChars: 120,
    compactArtifacts: true,
  },
  {
    summaryChars: 0,
    includeAllDecisions: false,
    decisionLimit: 0,
    decisionItemChars: 0,
    includePhase: false,
    includeDecisions: false,
    objectiveChars: 200,
    constraintItemChars: 100,
    compactArtifacts: true,
  },
  {
    summaryChars: 0,
    includeAllDecisions: false,
    decisionLimit: 0,
    decisionItemChars: 0,
    includePhase: false,
    includeDecisions: false,
    objectiveChars: 140,
    constraintItemChars: 80,
    compactArtifacts: true,
  },
  {
    summaryChars: 0,
    includeAllDecisions: false,
    decisionLimit: 0,
    decisionItemChars: 0,
    includePhase: false,
    includeDecisions: false,
    objectiveChars: 100,
    constraintItemChars: 64,
    compactArtifacts: true,
  },
]

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars))
  return value.slice(0, maxChars - 3) + "..."
}

/**
 * Trim, drop empty entries, and remove exact duplicates while preserving the
 * first occurrence order. Returns whether anything was removed.
 */
function uniqueStrings(items: readonly string[]): { values: string[]; removed: boolean } {
  const seen = new Set<string>()
  const values: string[] = []
  for (const item of items) {
    const trimmed = item.trim()
    if (trimmed.length === 0) {
      continue
    }
    if (seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    values.push(trimmed)
  }
  return { values, removed: values.length !== items.length }
}

function defaultHistorySummary(history: readonly HistoryEntry[]): string {
  if (history.length === 0) return ""
  const last = history[history.length - 1]
  const snippet = (last?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 100)
  if (snippet.length === 0) {
    return `${history.length} messages`
  }
  return `${history.length} messages; latest: ${snippet}`
}

function buildHistoryRef(
  history: readonly HistoryEntry[],
  retrievalId: string | undefined,
  summary: string | undefined,
): HistoryRef | undefined {
  if (history.length === 0) return undefined
  const startIndex = 0
  const endIndex = history.length - 1
  const firstId = history[0]?.id
  const lastId = history[endIndex]?.id
  const derivedId = firstId != null || lastId != null
    ? `${firstId ?? startIndex}-${lastId ?? endIndex}`
    : `history-${startIndex}-${endIndex}`
  return {
    retrievalId: retrievalId ?? derivedId,
    startIndex,
    endIndex,
    count: history.length,
    summary: summary ?? defaultHistorySummary(history),
  }
}

function historyLine(historyRef: HistoryRef, summaryChars: number): string {
  const summaryPart = summaryChars > 0 && historyRef.summary.length > 0
    ? `; ${clip(historyRef.summary, summaryChars)}`
    : ""
  return `History: ${historyRef.retrievalId} [${historyRef.startIndex}-${historyRef.endIndex}] count=${historyRef.count}${summaryPart}`
}

function renderDocument(
  state: {
    readonly objective: string
    readonly constraints: readonly string[]
    readonly phase?: string
    readonly nextAction?: string
    readonly decisions: readonly string[]
    readonly artifacts: readonly string[]
    readonly historyRef?: HistoryRef
  },
  shape: RenderShape,
): string {
  const lines: string[] = []
  lines.push(`Objective: ${clip(state.objective, shape.objectiveChars)}`)

  if (state.constraints.length > 0) {
    lines.push("Constraints:")
    for (const constraint of state.constraints) {
      lines.push(`- ${clip(constraint, shape.constraintItemChars)}`)
    }
  }

  if (shape.includePhase && state.phase != null && state.phase.length > 0) {
    lines.push(`Phase: ${state.phase}`)
  }

  if (state.nextAction != null && state.nextAction.length > 0) {
    lines.push(`Next action: ${state.nextAction}`)
  }

  if (shape.includeDecisions && state.decisions.length > 0) {
    const kept = shape.includeAllDecisions
      ? state.decisions
      : state.decisions.slice(Math.max(0, state.decisions.length - shape.decisionLimit))
    if (kept.length > 0) {
      lines.push("Decisions:")
      for (const decision of kept) {
        lines.push(`- ${clip(decision, shape.decisionItemChars)}`)
      }
    }
  }

  if (state.artifacts.length > 0) {
    if (shape.compactArtifacts) {
      lines.push(`Artifacts: ${state.artifacts.join(", ")}`)
    } else {
      lines.push("Artifacts:")
      for (const artifact of state.artifacts) {
        lines.push(`- ${artifact}`)
      }
    }
  }

  if (state.historyRef != null) {
    lines.push(historyLine(state.historyRef, shape.summaryChars))
  }

  return lines.join("\n")
}

/**
 * Last-resort render that clips only the elastic prose sections and keeps every
 * artifact reference and the history reference intact.
 */
function renderEmergency(
  state: {
    readonly objective: string
    readonly constraints: readonly string[]
    readonly nextAction?: string
    readonly artifacts: readonly string[]
    readonly historyRef?: HistoryRef
  },
  maxChars: number,
): string {
  const fixedLines: string[] = []
  if (state.nextAction != null && state.nextAction.length > 0) {
    fixedLines.push(`Next action: ${clip(state.nextAction, 80)}`)
  }
  if (state.artifacts.length > 0) {
    fixedLines.push(`Artifacts: ${state.artifacts.join(", ")}`)
  }
  if (state.historyRef != null) {
    fixedLines.push(historyLine(state.historyRef, 0))
  }

  const fixed = fixedLines.join("\n")
  const remaining = maxChars - fixed.length - 1
  if (remaining <= 0) {
    return fixed
  }

  const objectiveBudget = Math.max(16, Math.floor(remaining * 0.4))
  const constraintBudget = Math.max(0, remaining - objectiveBudget - 16)
  const head = [`Objective: ${clip(state.objective, objectiveBudget)}`]
  if (state.constraints.length > 0 && constraintBudget > 0) {
    head.push(`Constraints: ${clip(state.constraints.join("; "), constraintBudget)}`)
  }
  return head.join("\n") + (fixed.length > 0 ? `\n${fixed}` : "")
}

/**
 * Build a compact, bounded working document with a retrievable history
 * reference. Deterministic for identical input.
 */
export function buildWorkingDocument(input: WorkingDocumentInput): WorkingDocument {
  const maxTokens = Math.max(1, Math.floor(input.maxTokens ?? DEFAULT_WORKING_DOCUMENT_TOKENS))
  const maxChars = maxTokens * 4

  const constraints = uniqueStrings(input.constraints ?? [])
  const decisions = uniqueStrings(input.decisions ?? [])
  const artifacts = uniqueStrings(input.artifacts ?? [])
  const history = input.history ?? []

  const historyRef = buildHistoryRef(history, input.historyRetrievalId, input.historySummary)

  const state = {
    objective: input.objective.trim(),
    constraints: constraints.values,
    phase: input.phase?.trim(),
    nextAction: input.nextAction?.trim(),
    decisions: decisions.values,
    artifacts: artifacts.values,
    historyRef,
  }

  let text = ""
  let level = RENDER_SHAPES.length - 1
  for (let index = 0; index < RENDER_SHAPES.length; index++) {
    const candidate = renderDocument(state, RENDER_SHAPES[index]!)
    if (estimateTokens(candidate) <= maxTokens) {
      text = candidate
      level = index
      break
    }
  }

  if (text.length === 0) {
    text = renderDocument(state, RENDER_SHAPES[RENDER_SHAPES.length - 1]!)
  }

  if (estimateTokens(text) > maxTokens) {
    text = renderEmergency(state, maxChars)
  }

  const inlinedHistoryTokens = history.reduce((sum, entry) => sum + estimateTokens(entry.text), 0)
  const estimatedTokens = estimateTokens(text)
  const historyDidNotFit =
    inlinedHistoryTokens > 0 && estimatedTokens + inlinedHistoryTokens > maxTokens
  const deduplicated =
    constraints.removed || decisions.removed || artifacts.removed

  return {
    text,
    objective: state.objective,
    constraints: constraints.values,
    phase: state.phase,
    nextAction: state.nextAction,
    decisions: decisions.values,
    artifacts: artifacts.values,
    historyRef,
    estimatedTokens,
    truncated: level > 0 || historyDidNotFit || deduplicated,
  }
}
