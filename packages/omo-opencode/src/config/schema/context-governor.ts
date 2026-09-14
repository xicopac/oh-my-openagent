import { z } from "zod"

/**
 * Tier enum for twin (maintenance + validation) roles. Mirrors the shared
 * `MODEL_TIERS` in `@oh-my-opencode/delegate-core`; inlined here because the
 * omo-opencode config schema layer cannot take a dependency on delegate-core
 * (same reason `model-routing.ts` inlines it).
 */
const CONTEXT_GOVERNOR_TIERS = ["fast", "balanced", "strong", "master"] as const
const ContextGovernorTierSchema = z.enum(CONTEXT_GOVERNOR_TIERS)

/**
 * Reasons a subagent (or the governor) may cite to keep an over-budget
 * context alive via a short-lived lease instead of forcing compaction.
 */
const LEASE_REASONS = [
  "active_evidence_comparison",
  "atomic_reasoning_phase",
  "imminent_safe_state_transition",
  "simultaneous_raw_evidence_dependency",
  "stale_capsule",
  "twin_failure_no_capsule",
] as const

export const ContextGovernorTwinConfigSchema = z
  .object({
    /** Enable the twin sidecar that maintains a running capsule of the parent session (default: true). */
    enabled: z.boolean().default(true),
    /** Model tier used for routine capsule maintenance (default: "balanced"). */
    maintenance_tier: ContextGovernorTierSchema.default("balanced"),
    /** Model tier used for audit-time validation of the capsule (default: "strong"). */
    validation_tier: ContextGovernorTierSchema.default("strong"),
    /** Explicit opt-in required before `maintenance_tier` or `validation_tier` may be "master" (default: false). */
    allow_premium_validation: z.boolean().default(false),
    /** Maximum concurrent twin-wake dispatches per parent session (default: 1, range: 1..8). */
    max_concurrent_wakes: z.number().int().min(1).max(8).default(1),
    /** Per-audit tool-call budget the twin may consume (default: 12, min: 1). */
    tool_budget: z.number().int().min(1).default(12),
    /** Hard cap on the twin sidecar's own working context in tokens (default: 48000, min: 1000). */
    sidecar_max_tokens: z.number().int().min(1000).default(48000),
    /** Fraction of the parent transcript that seeds a fresh twin on cold start (default: 0.6, range: 0.1..1). */
    reseed_fraction: z.number().min(0.1).max(1).default(0.6),
    /** Timeout in ms for a single twin audit call (default: 15000, min: 1000). */
    audit_call_timeout_ms: z.number().int().min(1000).default(15000),
  })
  .strict()

export const ContextGovernorLeaseConfigSchema = z
  .object({
    /** Enable short-lived over-budget leases so the governor can defer compaction for narrowly scoped work (default: true). */
    enabled: z.boolean().default(true),
    /** Extra tokens granted above `compactAt` while a lease is active (default: 30000, min: 1). */
    extra_tokens: z.number().int().min(1).default(30000),
    /** Maximum agent turns a single lease may span before it auto-expires (default: 3, min: 1). */
    max_turns: z.number().int().min(1).default(3),
    /** Maximum times the same lease may be renewed before compaction is forced (default: 1, min: 0). */
    max_renewals: z.number().int().min(0).default(1),
    /** Whitelist of reason codes accepted by the governor when a lease is requested. */
    valid_reasons: z
      .array(z.enum(LEASE_REASONS))
      .default([...LEASE_REASONS]),
  })
  .strict()

export const ContextGovernorConfigSchema = z
  .object({
    /**
     * Master switch for the context governor subsystem. Our fork activates it
     * by default (`default: true`); an explicit `enabled: false` still turns
     * the whole subsystem off without requiring the key to be present for the
     * feature to operate.
     */
    enabled: z.boolean().default(true),
    /** Absolute-cap token count that triggers pre-audit capsule preparation (default: 110000, min: 1). */
    prepare_at_tokens: z.number().int().min(1).default(110000),
    /** Absolute-cap token count that triggers the twin audit (default: 135000, min: 1). */
    audit_at_tokens: z.number().int().min(1).default(135000),
    /** Absolute-cap token count that forces compaction under normal (large-window) operation (default: 150000, min: 1). */
    normal_limit_tokens: z.number().int().min(1).default(150000),
    /** Post-compaction target size in tokens; the compactor aims at (but does not exceed) this value (default: 60000, min: 1). */
    target_after_compaction_tokens: z.number().int().min(1).default(60000),
    /** Maximum summarize passes per convergent-compaction cycle; stops early when a pass stops yielding material reduction (default: 3, range: 1..5). */
    max_compaction_passes: z.number().int().min(1).max(5).default(3),
    /** Fraction of the model's actual context window that binds when it is smaller than `normal_limit_tokens` (default: 0.78, range: 0.1..1). Reuses the existing 78% margin from preemptive-compaction-trigger. */
    provider_relative_ratio: z.number().min(0.1).max(1).default(0.78),
    /** Maximum characters for the short-form capsule head (default: 8000, min: 100). */
    capsule_head_max_chars: z.number().int().min(100).default(8000),
    /** Maximum bytes for the full serialized capsule (default: 131072 = 128 KiB, min: 1000). */
    capsule_full_max_bytes: z.number().int().min(1000).default(131072),
    /** Twin sidecar configuration. */
    twin: ContextGovernorTwinConfigSchema.default(() => ContextGovernorTwinConfigSchema.parse({})),
    /** Over-budget lease configuration. */
    lease: ContextGovernorLeaseConfigSchema.default(() => ContextGovernorLeaseConfigSchema.parse({})),
  })
  .strict()
  .refine((cfg) => cfg.prepare_at_tokens < cfg.audit_at_tokens, {
    message:
      "prepare_at_tokens must be strictly less than audit_at_tokens",
    path: ["prepare_at_tokens"],
  })
  .refine((cfg) => cfg.audit_at_tokens < cfg.normal_limit_tokens, {
    message:
      "audit_at_tokens must be strictly less than normal_limit_tokens",
    path: ["audit_at_tokens"],
  })
  .refine((cfg) => cfg.target_after_compaction_tokens < cfg.prepare_at_tokens, {
    message:
      "target_after_compaction_tokens must be strictly less than prepare_at_tokens",
    path: ["target_after_compaction_tokens"],
  })
  .refine(
    (cfg) => {
      const needsPremium =
        cfg.twin.maintenance_tier === "master" ||
        cfg.twin.validation_tier === "master"
      return !needsPremium || cfg.twin.allow_premium_validation === true
    },
    {
      message:
        "premium tier maintenance/validation requires twin.allow_premium_validation=true",
      path: ["twin", "allow_premium_validation"],
    },
  )

export type ContextGovernorTwinConfig = z.infer<typeof ContextGovernorTwinConfigSchema>
export type ContextGovernorLeaseConfig = z.infer<typeof ContextGovernorLeaseConfigSchema>
export type ContextGovernorConfig = z.infer<typeof ContextGovernorConfigSchema>

export const DEFAULT_CONTEXT_GOVERNOR_CONFIG: ContextGovernorConfig =
  ContextGovernorConfigSchema.parse({})
