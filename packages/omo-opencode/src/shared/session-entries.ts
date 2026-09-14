/**
 * Publisher-agnostic session-entry paging + mapper.
 *
 * Two concerns live here and NOTHING else:
 *
 *   1. `sessionEntriesSince(rows, since, caps)` — bounded page from a flat
 *      array of already-normalized `SessionEntryRow` values. Rows are
 *      returned STRICTLY AFTER cursor `since`; the page stops as soon as
 *      either the row-count cap or the total-char cap is exceeded, and it
 *      NEVER splits a row.
 *
 *   2. `toSessionEntryRows(raw, startCursor, caps)` — a duck-typed mapper
 *      that accepts the OpenCode SDK v1.18 message shape and generic
 *      plugin-event payloads, and produces `SessionEntryRow[]`. The mapper
 *      MUST NEVER throw on unknown shapes.
 *
 * Deliberately empty of anything else:
 *   - no session lookup / no I/O
 *   - no imports from `packages/omo-senpi/*` (package boundary; the senpi
 *     kibitzer session-read tool inspired the shape, we did NOT import it)
 *   - no dependency on the context-governor hook / capsule schema
 */

/** One row of the flat, per-session transcript-view page. */
export interface SessionEntryRow {
  /** Absolute cursor position; pass the last one back as `since` to continue. */
  readonly cursor: number
  readonly type: string
  readonly role?: string
  readonly text?: string
}

/** Bounded-paging knobs. Every field has a documented default. */
export interface SessionEntriesCaps {
  /** Maximum rows returned in one page. Default 50. */
  readonly rows?: number
  /** Total character budget across the returned rows. Default 8000. */
  readonly chars?: number
  /** Per-row char cap used by `toSessionEntryRows`. Default 2000. */
  readonly row_chars?: number
}

/** Return value of `sessionEntriesSince`. */
export interface SessionEntriesPage {
  readonly entries: readonly SessionEntryRow[]
  /**
   * Cursor to pass as `since` on the next call. Equals the input `since`
   * when the page is empty; otherwise equals the cursor of the LAST included
   * row.
   */
  readonly next_since: number
  /**
   * Count of rows skipped between `since` and the first included row
   * because their text was empty / undefined (type-only markers).
   */
  readonly hidden: number
  /** True when more rows remain past the caps. */
  readonly truncated: boolean
}

const DEFAULT_ROWS = 50
const DEFAULT_CHARS = 8000
const DEFAULT_ROW_CHARS = 2000
const TRUNCATION_MARK = "\u2026"

/**
 * Rows strictly after `since`, bounded by the given caps.
 *
 * Semantics locked by tests:
 *   - Row inclusion is strict: `row.cursor > since`.
 *   - `next_since` equals the cursor of the LAST included row, or `since`
 *     when the page is empty.
 *   - The chars cap only stops the walk AFTER at least one row has been
 *     included, so a single oversized row is never dropped (never split).
 *   - `hidden` counts empty-text rows between `since` and the first
 *     included row; empty-text rows AFTER the first included row are
 *     included as-is (they carry their own type marker).
 *   - `truncated` is true when any row remained past `since` when the caps
 *     stopped the walk.
 */
export function sessionEntriesSince(
  entries: readonly SessionEntryRow[],
  since: number,
  caps?: SessionEntriesCaps,
): SessionEntriesPage {
  const rowsCap = caps?.rows ?? DEFAULT_ROWS
  const charsCap = caps?.chars ?? DEFAULT_CHARS

  const included: SessionEntryRow[] = []
  let hidden = 0
  let nextSince = since
  let truncated = false
  let usedChars = 0
  let seenIncluded = false

  for (const row of entries) {
    if (row.cursor <= since) continue

    // Skip type-only markers ahead of the first real row and count them.
    if (!seenIncluded && (row.text === undefined || row.text.length === 0)) {
      hidden += 1
      continue
    }

    // Row cap: stop BEFORE this row.
    if (included.length >= rowsCap) {
      truncated = true
      break
    }

    // Char cap: only enforced once we already have at least one row, so
    // one oversized row never disappears.
    const rowChars = row.text?.length ?? 0
    if (seenIncluded && usedChars + rowChars > charsCap) {
      truncated = true
      break
    }

    included.push(row)
    nextSince = row.cursor
    usedChars += rowChars
    seenIncluded = true
  }

  return { entries: included, next_since: nextSince, hidden, truncated }
}

/**
 * Shape of an SDK v1.18 message part (deliberately loose — we duck-type).
 */
interface MessagePartLike {
  readonly type?: unknown
  readonly text?: unknown
}

/**
 * Shape of an SDK v1.18 message OR a plugin-event payload (again loose).
 */
interface RawEntryLike {
  readonly id?: unknown
  readonly type?: unknown
  readonly role?: unknown
  readonly text?: unknown
  readonly info?: { readonly role?: unknown } | unknown
  readonly parts?: readonly MessagePartLike[] | unknown
}

/**
 * Duck-typed mapper: raw SDK messages / plugin-event payloads → rows.
 *
 * Role resolution order: `row.role` → `row.info.role` → `"unknown"`.
 * Type resolution order: `row.type` → `parts[0].type` → `"message"`.
 * Text resolution: `parts[].text` joined with newlines (each part
 * prefixed with `[<type>]` only when there is more than one part), or
 * `row.text`. Truncated to `row_chars` with a trailing ellipsis marker
 * plus a `[truncated]` tag when clipped.
 *
 * Never throws — a completely unknown value becomes `{ type: "unknown",
 * text: String(input) }` (only when the input is not null/undefined; those
 * still return an "unknown"-typed row with no text).
 */
export function toSessionEntryRows(
  raw: readonly unknown[],
  startCursor = 0,
  caps?: { readonly row_chars?: number },
): SessionEntryRow[] {
  const rowChars = caps?.row_chars ?? DEFAULT_ROW_CHARS
  const rows: SessionEntryRow[] = []
  let cursor = Math.floor(startCursor)
  for (const item of raw) {
    rows.push(mapOne(item, cursor, rowChars))
    cursor += 1
  }
  return rows
}

function mapOne(item: unknown, cursor: number, rowChars: number): SessionEntryRow {
  if (!isRecord(item)) {
    // null / undefined / primitives → tolerant fallback.
    const text = item === null || item === undefined ? undefined : boundedText(String(item), rowChars)
    return text === undefined
      ? { cursor, type: "unknown" }
      : { cursor, type: "unknown", text }
  }

  const entry = item as RawEntryLike
  const role = resolveRole(entry)
  const partsText = joinPartsText(entry.parts, rowChars)
  const topText = typeof entry.text === "string" ? entry.text : undefined
  const rawText = partsText ?? topText
  const text = rawText === undefined ? undefined : boundedText(rawText, rowChars)
  const type = resolveType(entry)

  const base: SessionEntryRow = role === undefined
    ? { cursor, type }
    : { cursor, type, role }
  return text === undefined ? base : { ...base, text }
}

function resolveRole(entry: RawEntryLike): string | undefined {
  if (typeof entry.role === "string" && entry.role.length > 0) return entry.role
  if (isRecord(entry.info) && typeof (entry.info as { role?: unknown }).role === "string") {
    const role = (entry.info as { role?: unknown }).role
    if (typeof role === "string" && role.length > 0) return role
  }
  // We only surface "unknown" when the caller had ANY reason to think this
  // was a role-bearing row: presence of parts or a top-level text field.
  if (Array.isArray(entry.parts) || typeof entry.text === "string") return "unknown"
  return undefined
}

function resolveType(entry: RawEntryLike): string {
  if (typeof entry.type === "string" && entry.type.length > 0) return entry.type
  if (Array.isArray(entry.parts)) {
    const first = (entry.parts as readonly MessagePartLike[])[0]
    if (first !== undefined && typeof first.type === "string" && first.type.length > 0) return first.type
  }
  return "message"
}

function joinPartsText(parts: unknown, rowChars: number): string | undefined {
  if (!Array.isArray(parts)) return undefined
  const texts: string[] = []
  const multi = parts.length > 1
  for (const part of parts) {
    if (!isRecord(part)) continue
    const text = part.text
    if (typeof text !== "string" || text.length === 0) continue
    const label = typeof part.type === "string" && part.type.length > 0 ? part.type : "part"
    texts.push(multi ? `[${label}] ${text}` : text)
    // Small optimization: stop concatenating once we clearly overshot the
    // per-row cap; the final bounding still happens in `boundedText`.
    if (texts.reduce((n, s) => n + s.length + 1, 0) >= rowChars * 4) break
  }
  if (texts.length === 0) return undefined
  return texts.join("\n")
}

function boundedText(s: string, cap: number): string {
  if (cap <= 0) return ""
  if (s.length <= cap) return s
  return `${s.slice(0, cap)}${TRUNCATION_MARK} [truncated ${s.length - cap} chars]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
