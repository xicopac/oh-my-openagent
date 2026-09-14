/**
 * Duplicate-work prevention (pure). A worker question is fingerprinted from its
 * normalized role + topic; before launch the Delegation Cop checks active and
 * completed workers for an essentially identical question (spec section 12).
 */

export type WorkerTrace = {
  actor_id: string
  role: string
  question: string
  status: "active" | "completed" | "failed"
}

export type DuplicateCheckResult =
  | { duplicate: false }
  | { duplicate: true; matched: WorkerTrace; reason: "active" | "completed" }

/**
 * Words that carry little discriminating signal for "is this the same
 * question" — function words and generic investigation verbs. Stripping them
 * lets "locate the auth middleware" match "find auth middleware in src/api".
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "at", "for", "with", "under", "into",
  "find", "locate", "search", "look", "check", "investigate", "examine", "enumerate",
  "explore", "map", "identify", "list", "get", "retrieve", "trace", "show", "review",
])

function normalize(text: string): string {
  // Split camelCase ("validateEmail" -> "validate email") before lowercasing,
  // then collapse every non-alphanumeric run to a single space.
  const camelSplit = camelCaseToWords(text)
  return camelSplit.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function camelCaseToWords(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
}

/** Light stemming: strip a trailing plural "s" so "sites" matches "site". */
function stem(word: string): string {
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1)
  return word
}

function tokenSet(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of normalize(text).split(" ")) {
    if (raw.length < 3) continue
    if (STOPWORDS.has(raw)) continue
    tokens.add(stem(raw))
  }
  return tokens
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const t of a) {
    if (b.has(t)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Two questions are essentially the same when the same role is asking and the
 * token overlap is at or above the threshold. Active workers win over
 * completed ones, so a live answer is reused before a stale one.
 */
export function checkDuplicate(
  candidate: { role: string; question: string },
  workers: readonly WorkerTrace[],
  threshold = 0.7,
): DuplicateCheckResult {
  const candRole = normalize(candidate.role)
  const candTokens = tokenSet(candidate.question)

  let best: { matched: WorkerTrace; score: number } | null = null
  for (const w of workers) {
    if (normalize(w.role) !== candRole) continue
    const score = jaccard(candTokens, tokenSet(w.question))
    if (score < threshold) continue
    // Prefer active matches; otherwise keep the highest-scoring completed one.
    if (best === null || score > best.score || (score === best.score && w.status === "active")) {
      best = { matched: w, score }
    }
  }

  if (best === null) return { duplicate: false }
  return {
    duplicate: true,
    matched: best.matched,
    reason: best.matched.status === "active" ? "active" : "completed",
  }
}
