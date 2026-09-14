/**
 * Bounded anchor rehydration.
 *
 * `context_rehydrate` takes an `Anchor` (see `./anchors`) plus a
 * publisher-agnostic `SessionMessagesFetcher`, and returns a bounded
 * slice of session-entry rows for the anchor's range — or an explicit
 * `unresolvable` result when the anchor names non-transcript evidence
 * (a file, plan, artifact, commit, task_id, or child_session).
 *
 * Rehydration ONLY handles transcript ranges. File / plan / artifact
 * content is rehydrated separately via the normal read tool; commits,
 * task ids and child session ids are for the caller to interpret with
 * git / background_output / session_read.
 *
 * ALL outputs are bounded by caps (`rows`, `chars`, `row_chars`) through
 * the shared paging in `../../shared/session-entries`.
 *
 * Errors: fetcher rejections propagate. This is intentional — the caller
 * (the governor + hook) is the correct layer to decide whether a fetcher
 * failure means "SAFE denied", "retry", or "fall back". Swallowing here
 * would hide provider errors.
 */

import {
  type SessionEntriesCaps,
  type SessionEntryRow,
  sessionEntriesSince,
  toSessionEntryRows,
} from "../../shared/session-entries"
import { anchorRange } from "./anchors"
import type { Anchor } from "./capsule-schema"

/**
 * Publisher-agnostic fetcher over an OpenCode session's messages.
 * Returns raw entries in the requested order; the caller is responsible
 * for mapping through `toSessionEntryRows`.
 */
export type SessionMessagesFetcher = (input: {
  readonly sessionID: string
  readonly limit: number
  readonly order: "desc" | "asc"
}) => Promise<unknown[]>

/** Caps forwarded to `sessionEntriesSince` and `toSessionEntryRows`. */
export interface RehydrateCaps {
  readonly rows?: number
  readonly chars?: number
  readonly row_chars?: number
}

/**
 * The two possible outcomes:
 *   - `session_range`: the anchor named a transcript range; rows contain
 *     the (bounded) slice.
 *   - `unresolvable`: the anchor named non-transcript evidence; caller
 *     must use the read/grep/session tools. `source` carries a short
 *     hint the caller can surface as a tool-result note.
 */
export interface RehydrateResult {
  readonly kind: "session_range" | "unresolvable"
  readonly anchor: Anchor
  readonly rows: readonly SessionEntryRow[]
  readonly source?: string
}

const DEFAULT_ROWS = 50
const UNRESOLVABLE_HINT = "use read/grep/session tools to fetch this anchor"

/**
 * Rehydrate an anchor to a bounded row slice (or an unresolvable stub).
 *
 * See module docstring for the contract. Fetcher errors propagate.
 */
export async function context_rehydrate(input: {
  readonly anchor: Anchor
  readonly fetcher: SessionMessagesFetcher
  readonly sessionID?: string
  readonly caps?: RehydrateCaps
}): Promise<RehydrateResult> {
  const { anchor, fetcher, sessionID, caps } = input

  if (anchor.type !== "session_entries" && anchor.type !== "session_cursor") {
    return {
      kind: "unresolvable",
      anchor,
      rows: [],
      source: UNRESOLVABLE_HINT,
    }
  }

  const range = anchorRange(anchor)
  const capsRows = caps?.rows ?? DEFAULT_ROWS
  const limit = range === null
    ? capsRows
    : Math.max(1, Math.min(range.to - range.from + 1, capsRows))
  const resolvedSession = sessionID ?? anchor.ref

  const raw = await fetcher({ sessionID: resolvedSession, limit, order: "asc" })
  // Row absolute position = fetched-window origin (0) + index. The fetcher
  // is expected to return rows aligned to the range's addressing space; when
  // the range names positions outside what came back, the clip below returns
  // exactly what is available (never throws).
  const mapped = toSessionEntryRows(raw, 0, { row_chars: caps?.row_chars })

  const pagingCaps: SessionEntriesCaps = {
    rows: capsRows,
    chars: caps?.chars,
    row_chars: caps?.row_chars,
  }

  const rows = range === null
    ? sessionEntriesSince(mapped, -1, pagingCaps).entries
    : clipToRange(mapped, range.from, range.to, pagingCaps)

  return { kind: "session_range", anchor, rows }
}

/**
 * Clip mapped rows to `[from, to]` inclusive, then re-apply the caps via
 * the shared paging helper (so char + row caps still bind).
 */
function clipToRange(
  mapped: readonly SessionEntryRow[],
  from: number,
  to: number,
  caps: SessionEntriesCaps,
): readonly SessionEntryRow[] {
  const inRange: SessionEntryRow[] = []
  for (const row of mapped) {
    if (row.cursor >= from && row.cursor <= to) inRange.push(row)
  }
  // Re-page for the caps invariants; `since = from - 1` because
  // sessionEntriesSince is strict-greater-than.
  return sessionEntriesSince(inRange, from - 1, caps).entries
}
