/**
 * Delegation Ladder — assignment refinement. Turns an inadequate attempt into
 * a narrower, better-contracted assignment for the next worker: isolate the
 * unresolved items, demand concrete source anchors, strengthen the result
 * contract, and carry forward already-known findings so the next worker does
 * not restart from zero. Pure string builder; never invents content or embeds
 * hidden reasoning.
 */

import type { AttemptResult, Finding } from "./types"

export function refineAssignment(originalPrompt: string, result: AttemptResult): string {
  const lines: string[] = []

  lines.push("Refined assignment (narrowed scope).")
  lines.push("")
  lines.push("Original objective:")
  lines.push(originalPrompt)
  lines.push("")

  const known = result.findings
  if (known.length > 0) {
    lines.push("Already-known findings (build on these; do not re-derive them):")
    for (const finding of known) {
      lines.push(formatFinding(finding))
    }
    lines.push("")
  }

  if (result.unresolved.length > 0) {
    lines.push("Answer ONLY the following unresolved questions:")
    for (const item of result.unresolved) {
      lines.push(`- ${item}`)
    }
  } else {
    lines.push("The prior attempt left no explicit unresolved items; re-attempt the original objective under the contract below.")
  }
  lines.push("")

  lines.push("For every claim, cite a concrete source anchor: file path, line number, and symbol name.")
  lines.push("")

  lines.push("Return a result with these fields:")
  lines.push("- objective: the isolated question you answered")
  lines.push("- status: what you completed and what remains")
  lines.push("- findings: concrete, anchored findings")
  lines.push("- files: files you read or changed")
  lines.push("- tests: tests you ran and their results")
  lines.push("- unresolved: what is still open")
  lines.push("- confidence: 0..1")

  return lines.join("\n")
}

function formatFinding(finding: Finding): string {
  const anchors = finding.anchors && finding.anchors.length > 0 ? ` [${finding.anchors.join(", ")}]` : ""
  return `- ${finding.type}: ${finding.summary}${anchors}`
}
