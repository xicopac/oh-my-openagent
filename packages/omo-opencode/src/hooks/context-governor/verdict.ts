import { z } from "zod"
import { AnchorSchema } from "./capsule-schema"
import { LEASE_REASON_CODES } from "./lease-reasons"

/**
 * Machine-consumable verifier verdict schema for the context governor.
 *
 * The verdict is emitted by the twin (or, in fallback, by a forced code path)
 * as strict JSON. The main session parses it through `parseVerdict` before
 * acting; any hidden-reasoning field at any depth is rejected BEFORE Zod even
 * looks at the payload.
 *
 * Note: `LEASE_REASON_CODES` lives in `./lease-reasons.ts` so the lease store
 * and the verdict schema share one source of truth. A second, independent
 * copy exists in `src/config/schema/context-governor.ts` because the config
 * layer cannot import from `src/hooks/`. If either list changes, BOTH must
 * be updated in lock step.
 */

const FORBIDDEN_REASONING_KEYS: readonly string[] = [
  "chain_of_thought",
  "hidden_reasoning",
  "internal_scratch",
  "scratchpad",
  "reasoning_trace",
  "cot",
  "private_notes",
]

/**
 * Recursively walk `input` looking for any object key equal to a forbidden
 * reasoning-leak field. Returns the first offending key name, or null if the
 * input is clean. Arrays and primitives are safely handled.
 */
export function hasForbiddenReasoningKeys(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null

  if (Array.isArray(input)) {
    for (const item of input) {
      const found = hasForbiddenReasoningKeys(item)
      if (found !== null) return found
    }
    return null
  }

  const record = input as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_REASONING_KEYS.includes(key)) return key
    const found = hasForbiddenReasoningKeys(record[key])
    if (found !== null) return found
  }
  return null
}

export const SafeToCompactSchema = z
  .object({
    verdict: z.literal("SAFE_TO_COMPACT"),
    capsule_revision: z.number().int().min(0),
    capsule_hash: z.string().min(1),
    cursor_covered: z.number().int().min(0),
    anchor_count: z.number().int().min(0),
    required_state_checks: z.array(z.string().min(1)).default([]),
    missing_critical_state: z.literal(false),
    generated_at: z.string().optional(),
  })
  .strict()

export const LeaseRequiredSchema = z
  .object({
    verdict: z.literal("CONTEXT_LEASE_REQUIRED"),
    reason: z.enum(LEASE_REASON_CODES),
    /**
     * Concise, structured description of which raw evidence must stay active
     * and why compacting it would destroy the current reasoning.
     */
    exact_raw_context_required: z.string().min(1),
    anchors: z.array(AnchorSchema).optional(),
    /**
     * The observable condition after which compaction becomes safe. Used by
     * T9 to know when to re-attempt the audit.
     */
    expected_safe_condition: z.string().min(1),
  })
  .strict()

export const VerdictSchema = z.discriminatedUnion("verdict", [
  SafeToCompactSchema,
  LeaseRequiredSchema,
])

export type VerifierVerdict = z.infer<typeof VerdictSchema>

export type ParseVerdictResult =
  | { ok: true; verdict: VerifierVerdict }
  | { ok: false; error: string }

/**
 * Parse untrusted verifier output.
 *
 * 1. Rejects any payload that carries a hidden-reasoning key at any depth,
 *    BEFORE Zod parsing runs, so a compromised or drift-y verifier cannot
 *    smuggle chain-of-thought data through a valid-looking envelope.
 * 2. Runs the strict discriminated union parser. Any unknown top-level key,
 *    missing required field, or wrong-typed value → { ok: false }.
 */
export function parseVerdict(input: unknown): ParseVerdictResult {
  const forbidden = hasForbiddenReasoningKeys(input)
  if (forbidden !== null) {
    return { ok: false, error: `hidden reasoning field rejected: ${forbidden}` }
  }

  const result = VerdictSchema.safeParse(input)
  if (!result.success) {
    return { ok: false, error: result.error.message }
  }
  return { ok: true, verdict: result.data }
}
