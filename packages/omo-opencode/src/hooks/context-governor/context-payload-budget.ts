/**
 * Context-payload-budget module: bounded child-result and tool-output
 * summarization, plus cache-reread suppression guard.
 *
 * All functions are pure (no I/O, no singletons) so they trivially table-test.
 */


/**
 * Bounded payload returned by boundChildResult and boundToolOutput.
 */
export type BoundedPayload = {
  readonly text: string
  readonly originalTokens: number
  readonly retainedTokens: number
  readonly truncated: boolean
  readonly retrievalRef?: string
}

/**
 * Estimate token count from character length: ceil(chars/4), safe for empty.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / 4)
}

/**
 * Bound a child result text to fit within maxTokens, using head/tail preservation.
 *
 * Default maxTokens: 2000.
 *
 * If the text fits within maxTokens, return it unchanged with truncated=false.
 *
 * Otherwise, keep head 70% and tail 30% of the character budget,
 * insert a truncation marker, and optionally append a full-result reference.
 * retainedTokens must be <= maxTokens.
 */
export function boundChildResult(
  text: string,
  opts?: { maxTokens?: number; retrievalRef?: string }
): BoundedPayload {
  const maxTokens = opts?.maxTokens ?? 2000
  const retrievalRef = opts?.retrievalRef
  const originalTokens = estimateTokens(text)

  // If within budget, return unchanged
  if (originalTokens <= maxTokens) {
    return {
      text,
      originalTokens,
      retainedTokens: originalTokens,
      truncated: false,
      retrievalRef,
    }
  }

  // Marker string (literal from spec)
  const marker = "\n...[truncated N tokens]...\n"
  const markerChars = marker.length

  // Full-result suffix when retrievalRef is provided
  const fullResultSuffix = retrievalRef != null ? "\n[full result: " + retrievalRef + "]" : ""

  // Character budget: maxTokens * 4 chars fit inside maxTokens tokens
  // (since estimateTokens = ceil(chars/4), ceil(c/4) <= maxTokens iff c <= maxTokens * 4)
  const maxChars = maxTokens * 4

  // Characters available for head + tail after subtracting marker and suffix
  const contentChars =
    maxChars -
    markerChars -
    (retrievalRef != null ? fullResultSuffix.length : 0)

  let headChars: number
  let tailChars: number

  if (contentChars <= 0) {
    // Not enough room for head+tail+marker; return marker (and suffix) only
    headChars = 0
    tailChars = 0
    // The final text will just be the marker + optional suffix
    const baseTruncated = marker + (retrievalRef != null ? fullResultSuffix : "")
    const retained = estimateTokens(baseTruncated)
    return {
      text: baseTruncated,
      originalTokens,
      retainedTokens: Math.min(retained, maxTokens),
      truncated: true,
      retrievalRef,
    }
  }

  headChars = Math.floor(contentChars * 0.7)
  tailChars = Math.floor(contentChars * 0.3)

  // Extract head and tail from the original text
  const headText = text.slice(0, headChars)
  const tailText =
    text.length > tailChars ? text.slice(text.length - tailChars) : text

  const truncatedText = headText + marker + tailText
  const finalText = truncatedText + (retrievalRef != null ? fullResultSuffix : "")

  const retainedTokens = estimateTokens(finalText)

  return {
    text: finalText,
    originalTokens,
    retainedTokens: Math.min(retainedTokens, maxTokens),
    truncated: true,
    retrievalRef,
  }
}

/**
 * Bound tool output text to fit within maxTokens, using head/tail preservation.
 * Default maxTokens: 8000.
 */
export function boundToolOutput(
  text: string,
  opts?: { maxTokens?: number; retrievalRef?: string }
): BoundedPayload {
  return boundChildResult(text, { maxTokens: opts?.maxTokens ?? 8000, retrievalRef: opts?.retrievalRef })
}

/**
 * Create a reread guard that suppresses duplicate cache reads.
 *
 * The guard tracks key+contentHash pairs. shouldInject returns false
 * ONLY when the same key+hash was already recorded; true otherwise.
 * record is idempotent.
 */
export function createRereadGuard() {
  const recorded = new Set<string>()

  return {
    shouldInject(key: string, contentHash: string): boolean {
      const keyHash = `${key}:${contentHash}`
      // Returns false ONLY when the same key+hash was already recorded
      if (recorded.has(keyHash)) {
        return false
      }
      return true
    },

    record(key: string, contentHash: string): void {
      // Idempotent: setting a Set member is naturally idempotent
      const keyHash = `${key}:${contentHash}`
      recorded.add(keyHash)
    },

    size(): number {
      return recorded.size
    },
  }
}