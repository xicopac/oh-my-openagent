import { describe, expect, test } from "bun:test"
import {
  ContextGovernorConfigSchema,
  type ContextGovernorConfig,
} from "../../config/schema/context-governor"
import type { LeaseRecord } from "./lease-store"
import { resolveEffectiveThresholds, type EffectiveThresholds } from "./threshold-policy"
import type { VerifierVerdict } from "./verdict"
import {
  evaluateGovernorDecision,
  leaseExpired,
  type GovernorDecision,
  type GovernorPhase,
} from "./governor"

function tinyThresholds(): EffectiveThresholds {
  // Small-limit configuration: prepare 500, audit 800, compact 1000,
  // targetAfter 250 (constrained under prepare-1). Uses actualLimit=200000
  // with configured 500/800/1000 so the absolute cap binds.
  const configured: ContextGovernorConfig = ContextGovernorConfigSchema.parse({
    prepare_at_tokens: 500,
    audit_at_tokens: 800,
    normal_limit_tokens: 1000,
    target_after_compaction_tokens: 250,
    // Ratio min is 0.1. With actualLimit=20000 and ratio=0.1:
    // Math.floor(20000 * 0.1) = 2000 >= 1000, so compactAt=1000
    provider_relative_ratio: 0.1,
  })
  const effective = resolveEffectiveThresholds({
    configured,
    actualLimit: 20000,
  })
  if (!effective) throw new Error("expected non-null thresholds in tiny fixture")
  return effective
}

const SAFE_VERDICT: VerifierVerdict = {
  verdict: "SAFE_TO_COMPACT",
  capsule_revision: 3,
  capsule_hash: "hhhh",
  cursor_covered: 42,
  anchor_count: 2,
  required_state_checks: [],
  missing_critical_state: false,
}

const LEASE_VERDICT: VerifierVerdict = {
  verdict: "CONTEXT_LEASE_REQUIRED",
  reason: "atomic_reasoning_phase",
  exact_raw_context_required: "diff between file A and file B must remain visible",
  anchors: [
    { type: "session_entries", ref: "seg-a", range: { from: 10, to: 20, label: "diff" } },
  ],
  expected_safe_condition: "after tests pass",
}

function baseInput(overrides: {
  used_tokens: number
  effective?: EffectiveThresholds
  phase?: GovernorPhase
  verdict?: VerifierVerdict | null
  active_lease?: LeaseRecord | null
  lease_expired?: boolean
  renewal_possible?: boolean
  capsule_fresh?: boolean
  max_renewals?: number
}) {
  return {
    used_tokens: overrides.used_tokens,
    effective: overrides.effective ?? tinyThresholds(),
    phase: overrides.phase ?? ("idle" as GovernorPhase),
    verdict: overrides.verdict ?? null,
    active_lease: overrides.active_lease ?? null,
    lease_expired: overrides.lease_expired ?? false,
    renewal_possible: overrides.renewal_possible ?? false,
    capsule_fresh: overrides.capsule_fresh ?? false,
    max_renewals: overrides.max_renewals ?? 1,
  }
}

function makeLease(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  const base: LeaseRecord = {
    lease_id: "lease-fake",
    session_id: "ses_test",
    context_size_at_grant: 900,
    reason: "atomic_reasoning_phase",
    retained_ranges: [],
    extra_tokens: 300,
    turns: 3,
    granted_at: "2026-09-14T10:00:00.000Z",
    renewed_at: null,
    renewal_count: 0,
    expires_at: "2026-09-14T11:00:00.000Z",
    granted_by: "twin",
    forced: false,
    audit_hash: "",
  }
  return { ...base, ...overrides }
}

describe("evaluateGovernorDecision", () => {
  test("#given used < prepareAt #when evaluated #then none", () => {
    // given
    const input = baseInput({ used_tokens: 100 })
    // when
    const decision: GovernorDecision = evaluateGovernorDecision(input)
    // then
    expect(decision.kind).toBe("none")
  })

  test("#given prepareAt <= used < auditAt, phase idle #when evaluated #then prepare", () => {
    const input = baseInput({ used_tokens: 500 })
    const decision = evaluateGovernorDecision(input)
    expect(decision.kind).toBe("prepare")
  })

  test("#given prepareAt <= used < auditAt, phase preparing #when evaluated #then none (already preparing)", () => {
    const input = baseInput({ used_tokens: 500, phase: "preparing" })
    const decision = evaluateGovernorDecision(input)
    expect(decision.kind).toBe("none")
  })

  test("#given auditAt <= used < compactAt #when evaluated #then audit", () => {
    const input = baseInput({ used_tokens: 800 })
    const decision = evaluateGovernorDecision(input)
    expect(decision.kind).toBe("audit")
  })

  test("#given used >= compactAt with SAFE verdict #when evaluated #then compact", () => {
    const input = baseInput({ used_tokens: 1000, verdict: SAFE_VERDICT })
    const decision = evaluateGovernorDecision(input)
    expect(decision.kind).toBe("compact")
  })

  test("#given used >= compactAt, no verdict, capsule fresh #when evaluated #then compact_degraded", () => {
    const input = baseInput({
      used_tokens: 1000,
      verdict: null,
      capsule_fresh: true,
    })
    const decision = evaluateGovernorDecision(input)
    expect(decision.kind).toBe("compact_degraded")
  })

  test("#given used >= compactAt, no verdict, no fresh capsule #when evaluated #then defer_no_capsule", () => {
    const input = baseInput({
      used_tokens: 1000,
      verdict: null,
      capsule_fresh: false,
    })
    const decision = evaluateGovernorDecision(input)
    expect(decision.kind).toBe("defer_no_capsule")
  })

  test("#given used >= compactAt with active un-expired lease #when evaluated #then defer_lease", () => {
    const input = baseInput({
      used_tokens: 1000,
      active_lease: makeLease(),
      lease_expired: false,
    })
    const decision = evaluateGovernorDecision(input)
    expect(decision.kind).toBe("defer_lease")
  })

  test("#given lease expired, renewal possible, lease-required verdict #when evaluated #then renew_lease", () => {
    const input = baseInput({
      used_tokens: 1200,
      active_lease: makeLease(),
      lease_expired: true,
      renewal_possible: true,
      verdict: LEASE_VERDICT,
    })
    const decision = evaluateGovernorDecision(input)
    expect(decision.kind).toBe("renew_lease")
  })

  test("#given lease expired, renewals exhausted #when evaluated #then force_compact forced=true", () => {
    const input = baseInput({
      used_tokens: 1200,
      active_lease: makeLease({ renewal_count: 1 }),
      lease_expired: true,
      renewal_possible: false,
      verdict: LEASE_VERDICT,
    })
    const decision = evaluateGovernorDecision(input)
    expect(decision.kind).toBe("force_compact")
    if (decision.kind === "force_compact") {
      expect(decision.forced).toBe(true)
    }
  })

  test("#given lease expired, SAFE verdict #when evaluated #then force_compact forced=true", () => {
    const input = baseInput({
      used_tokens: 1200,
      active_lease: makeLease(),
      lease_expired: true,
      renewal_possible: true,
      verdict: SAFE_VERDICT,
    })
    const decision = evaluateGovernorDecision(input)
    expect(decision.kind).toBe("force_compact")
    if (decision.kind === "force_compact") {
      expect(decision.forced).toBe(true)
    }
  })
})

describe("leaseExpired", () => {
  test("#given turns_since_grant >= max_turns #when checked #then expired true", () => {
    const lease = makeLease({ turns: 3, extra_tokens: 300 })
    const expired = leaseExpired(lease, {
      turns_since_grant: 3,
      tokens_since_grant: 0,
      extra_tokens: 300,
      max_turns: 3,
    })
    expect(expired).toBe(true)
  })

  test("#given tokens_since_grant >= extra_tokens #when checked #then expired true", () => {
    const lease = makeLease({ turns: 3, extra_tokens: 300 })
    const expired = leaseExpired(lease, {
      turns_since_grant: 0,
      tokens_since_grant: 300,
      extra_tokens: 300,
      max_turns: 3,
    })
    expect(expired).toBe(true)
  })

  test("#given both under limits #when checked #then not expired", () => {
    const lease = makeLease({ turns: 3, extra_tokens: 300 })
    const expired = leaseExpired(lease, {
      turns_since_grant: 1,
      tokens_since_grant: 100,
      extra_tokens: 300,
      max_turns: 3,
    })
    expect(expired).toBe(false)
  })
})
