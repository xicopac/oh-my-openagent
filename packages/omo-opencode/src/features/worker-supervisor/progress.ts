/**
 * Meaningful-progress detection. "Thread is still running" is NOT progress.
 * Activity that does NOT count as progress: repeating the same grep, rereading
 * the same file, rerunning the same failing test without a code/hypothesis
 * change, endless planning, token burn with no state change.
 */

import type { WorkerSignal } from "./types"

const PROGRESS_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "interactive_bash",
  "todowrite",
  "task",
  "call_omo_agent",
])

/**
 * A compact fingerprint of the worker's most recent observable state. When the
 * fingerprint is unchanged across checks but tokens/tool-calls keep rising, the
 * worker is looping rather than progressing.
 */
export function progressFingerprint(signal: WorkerSignal): string {
  const tail = signal.outputTail.trim()
  const tailHash = tail.length === 0 ? "" : hash(tail)
  return [
    signal.currentTool ?? "",
    signal.filesChangedDelta > 0 ? "files" : "",
    tailHash,
    signal.toolCallsDelta > 0 ? "tools" : "",
    signal.commandActive ? "cpu" : "",
  ].join("|")
}

/**
 * Whether THIS check advanced meaningful state. A file change, a new tool
 * producing output, or fresh output all count; a pure token/tool-call spike
 * with no state change does not.
 */
export function isMeaningfulProgress(signal: WorkerSignal): boolean {
  if (signal.filesChangedDelta > 0) return true
  if (signal.outputTail.trim().length > 0 && signal.currentTool !== null) {
    if (PROGRESS_TOOLS.has(signal.currentTool)) return true
  }
  return false
}

function hash(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0
  }
  return String(h >>> 0)
}
