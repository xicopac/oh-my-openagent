/**
 * Deterministic sync-result adequacy judgement for the delegation ladder.
 * Zero model calls: a result is INADEQUATE only when it is empty, truncated,
 * or carries an explicit failure/error marker. This is the live "MAIN
 * critiques the result" signal without burning paid tokens — the refined
 * retry/escalate decision is driven purely by the returned text shape.
 */

import type { AttemptResult, Finding } from "../../features/delegation-ladder"
import { extractEvidenceAnchors } from "../../features/delegation-first/worker-evidence"

const FAILURE_MARKERS = [
  "failed to",
  "error:",
  "error ",
  "unexpected error",
  "timed out",
  "aborted",
  "no such file",
  "cannot",
  "unable to",
  "not found",
  "invalid",
  "rejected",
  "blocked",
  "resource-governor",
]

const FAILURE_MARKERS_FULL_LINE = ["failed", "error", "exception", "rejected", "blocked"]

function isEmptyResult(result: string): boolean {
  const trimmed = result.trim()
  return trimmed.length === 0
}

function isTruncatedResult(result: string): boolean {
  return /\b(truncated|omitted|\.\.\.$)\b/.test(result) && result.length < 200
}

function hasFailureMarker(result: string): boolean {
  const lower = result.toLowerCase()
  for (const marker of FAILURE_MARKERS) {
    if (lower.includes(marker)) return true
  }
  return false
}

function hasFailureLine(result: string): boolean {
  for (const line of result.split("\n")) {
    const lower = line.trim().toLowerCase()
    for (const marker of FAILURE_MARKERS_FULL_LINE) {
      if (lower.startsWith(marker)) return true
    }
  }
  return false
}

export type SyncAdequacy = AttemptResult & { adequate: boolean }

export function judgeSyncAdequacy(result: string): SyncAdequacy {
  if (isEmptyResult(result)) {
    return {
      adequate: false,
      objective: "delegated subtask",
      status: "empty",
      findings: [],
      confidence: 0,
      unresolved: ["the worker returned an empty result"],
    }
  }

  if (isTruncatedResult(result)) {
    return {
      adequate: false,
      objective: "delegated subtask",
      status: "truncated",
      findings: [],
      confidence: 0.1,
      unresolved: ["the worker result was truncated or omitted"],
    }
  }

  if (hasFailureMarker(result) || hasFailureLine(result)) {
    return {
      adequate: false,
      objective: "delegated subtask",
      status: "errored",
      findings: [],
      confidence: 0.1,
      unresolved: ["the worker reported a failure or error"],
    }
  }

  const anchors = extractEvidenceAnchors(result)
  const findings: Finding[] = [
    { type: "note", summary: "worker completed the subtask" },
    ...(anchors.length > 0 ? [{ type: "anchor" as const, summary: "worker-reported source anchors", anchors }] : []),
  ]
  return {
    adequate: true,
    objective: "delegated subtask",
    status: "complete",
    findings,
    confidence: 0.6,
    unresolved: [],
  }
}
