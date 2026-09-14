/**
 * Compact canonical anchor codec: encodeAnchor / decodeAnchor / anchorRange.
 *
 * An Anchor names WHERE a fact came from, so it can be shown in a capsule
 * and rehydrated on demand without ever storing the full evidence inline.
 * The `Anchor` type + `AnchorSchema` (zod) are OWNED by `./capsule-schema`
 * (task T2). This module never duplicates that schema; it only defines the
 * wire format for anchor strings that appear inside capsule notes and
 * rehydrate arguments.
 *
 * Wire format:
 *   type:ref                 (no range)
 *   type:ref:from:to         (with numeric range in anchor.range.from/to)
 *   type:ref[:from:to] #note (optional trailing note after ` #`)
 *
 * Anchors are ALWAYS decoded by returning `null` on garbage: the codec MUST
 * NOT throw, even on adversarial input. This is a boundary parser (Axiom 2).
 */

import { AnchorSchema, type Anchor } from "./capsule-schema"

export type { Anchor }

const ANCHOR_TYPES: ReadonlySet<string> = new Set(AnchorSchema.shape.type.options)

/**
 * Encode an anchor to its compact canonical string form. Round-trips
 * losslessly with `decodeAnchor` when the anchor's `range` has finite
 * numeric `from`/`to` (the only range shape the wire format carries).
 */
export function encodeAnchor(anchor: Anchor): string {
  const from = anchor.range?.from
  const to = anchor.range?.to
  const hasRange = typeof from === "number" && typeof to === "number"
  const body = hasRange
    ? `${anchor.type}:${anchor.ref}:${from}:${to}`
    : `${anchor.type}:${anchor.ref}`
  return anchor.note !== undefined && anchor.note.length > 0
    ? `${body} #${anchor.note}`
    : body
}

/**
 * Decode a canonical anchor string. Returns null on any malformed input.
 * Never throws.
 */
export function decodeAnchor(s: string): Anchor | null {
  if (typeof s !== "string" || s.length === 0) return null

  let body = s
  let note: string | undefined
  const noteIdx = s.indexOf(" #")
  if (noteIdx >= 0) {
    body = s.slice(0, noteIdx)
    note = s.slice(noteIdx + 2)
    if (note.length === 0) note = undefined
  }

  const firstColon = body.indexOf(":")
  if (firstColon <= 0) return null
  const typeToken = body.slice(0, firstColon)
  if (!isAnchorType(typeToken)) return null
  const rest = body.slice(firstColon + 1)
  if (rest.length === 0) return null

  // A trailing `:from:to` with two non-negative integers where from <= to
  // is a range; paths may otherwise legitimately contain colons, so any
  // other tail is treated as part of the ref.
  const rangeMatch = /^(.+):(\d+):(\d+)$/.exec(rest)
  if (rangeMatch !== null) {
    const ref = rangeMatch[1]!
    const from = Number(rangeMatch[2])
    const to = Number(rangeMatch[3])
    if (
      Number.isInteger(from) &&
      Number.isInteger(to) &&
      from >= 0 &&
      to >= 0 &&
      from <= to &&
      ref.length > 0
    ) {
      const anchor: Anchor = { type: typeToken, ref, range: { from, to } }
      return note === undefined ? anchor : { ...anchor, note }
    }
    // Adversarial numeric tail (e.g. reversed range) is malformed rather
    // than "ref happens to end in digits" - the caller had every visual
    // reason to think this was a range.
    if (/^\d+$/.test(rangeMatch[2]!) && /^\d+$/.test(rangeMatch[3]!)) {
      return null
    }
  }

  const anchor: Anchor = { type: typeToken, ref: rest }
  return note === undefined ? anchor : { ...anchor, note }
}

/**
 * Numeric range for anchors that carry one, else null. Callers use this
 * to size a bounded rehydration read.
 */
export function anchorRange(anchor: Anchor): { from: number; to: number } | null {
  const from = anchor.range?.from
  const to = anchor.range?.to
  if (typeof from === "number" && typeof to === "number") {
    return { from, to }
  }
  return null
}

function isAnchorType(v: string): v is Anchor["type"] {
  return ANCHOR_TYPES.has(v)
}
