/**
 * Deterministic worker-evidence extraction for post-evidence root
 * verification. A completed child returns plain text (its final message);
 * this module pulls ONLY structured, conservative anchors from that text:
 * file paths, file:line ranges, and explicit symbol mentions. Arbitrary prose
 * ("inspect the whole repository") is never an anchor. Regex-only, zero model
 * calls, so a child result can authorize the root to verify exact files the
 * worker identified without granting repository-wide discovery.
 */

const FILE_LINE_ANCHOR = /([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|c|cpp|h|hpp|cs|swift|json|yml|yaml|md|toml|sql)):(\d+)(?:-(\d+))?/g
const FILE_ANCHOR = /([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|c|cpp|h|hpp|cs|swift|json|yml|yaml|md|toml|sql))/g
const SYMBOL_MARKER = /(?:symbol|function|class|method|symbols?)[:=]\s*([A-Za-z_$][A-Za-z0-9_$]*)/gi
const SYMBOL_BACKTICK = /`([A-Za-z_$][A-Za-z0-9_$]*)`/g

export function extractEvidenceAnchors(resultText: string): string[] {
  if (!resultText || resultText.length === 0) return []

  const anchors = new Set<string>()

  for (const match of resultText.matchAll(FILE_LINE_ANCHOR)) {
    const file = match[1]
    const start = match[2]
    const end = match[3]
    anchors.add(end ? `${file}:${start}-${end}` : `${file}:${start}`)
    anchors.add(file)
  }

  for (const match of resultText.matchAll(FILE_ANCHOR)) {
    const file = match[1]
    if (!file.startsWith("http")) anchors.add(file)
  }

  for (const match of resultText.matchAll(SYMBOL_MARKER)) {
    anchors.add(match[1])
  }
  for (const match of resultText.matchAll(SYMBOL_BACKTICK)) {
    const symbol = match[1]
    if (!/(^|[.])[a-z]/.test(symbol) || symbol.length >= 3) anchors.add(symbol)
  }

  return [...anchors]
}

export function countEvidenceAnchors(resultText: string): number {
  return extractEvidenceAnchors(resultText).length
}