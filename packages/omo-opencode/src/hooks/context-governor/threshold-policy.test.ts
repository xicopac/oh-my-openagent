import { describe, expect, test } from "bun:test"
import {
  ContextGovernorConfigSchema,
  type ContextGovernorConfig,
} from "../../config/schema/context-governor"
import {
  resolveEffectiveThresholds,
  type EffectiveThresholds,
} from "./threshold-policy"

/**
 * Helper: parse an empty object through the schema to get the fully-defaulted
 * ContextGovernorConfig. Keeps every test case honest about the shipped defaults.
 */
function defaults(): ContextGovernorConfig {
  return ContextGovernorConfigSchema.parse({})
}

describe("ContextGovernorConfigSchema", () => {
  test("#given an empty object #when parsed #then every field has the documented default", () => {
    // when
    const cfg = ContextGovernorConfigSchema.parse({})

    // then
    expect(cfg.enabled).toBe(true)
    expect(cfg.prepare_at_tokens).toBe(110000)
    expect(cfg.audit_at_tokens).toBe(135000)
    expect(cfg.normal_limit_tokens).toBe(150000)
    expect(cfg.target_after_compaction_tokens).toBe(60000)
    expect(cfg.provider_relative_ratio).toBe(0.78)
    expect(cfg.capsule_head_max_chars).toBe(8000)
    expect(cfg.capsule_full_max_bytes).toBe(131072)

    // twin defaults
    expect(cfg.twin.enabled).toBe(true)
    expect(cfg.twin.maintenance_tier).toBe("balanced")
    expect(cfg.twin.validation_tier).toBe("strong")
    expect(cfg.twin.allow_premium_validation).toBe(false)
    expect(cfg.twin.max_concurrent_wakes).toBe(1)
    expect(cfg.twin.tool_budget).toBe(12)
    expect(cfg.twin.sidecar_max_tokens).toBe(48000)
    expect(cfg.twin.reseed_fraction).toBe(0.6)
    expect(cfg.twin.audit_call_timeout_ms).toBe(15000)

    // lease defaults
    expect(cfg.lease.enabled).toBe(true)
    expect(cfg.lease.extra_tokens).toBe(30000)
    expect(cfg.lease.max_turns).toBe(3)
    expect(cfg.lease.max_renewals).toBe(1)
    expect(cfg.lease.valid_reasons).toEqual([
      "active_evidence_comparison",
      "atomic_reasoning_phase",
      "imminent_safe_state_transition",
      "simultaneous_raw_evidence_dependency",
      "stale_capsule",
      "twin_failure_no_capsule",
    ])
  })

  test("#given prepare_at_tokens >= audit_at_tokens #when parsed #then it is rejected", () => {
    const result = ContextGovernorConfigSchema.safeParse({
      prepare_at_tokens: 140000,
      audit_at_tokens: 135000,
      normal_limit_tokens: 150000,
    })
    expect(result.success).toBe(false)
  })

  test("#given audit_at_tokens >= normal_limit_tokens #when parsed #then it is rejected", () => {
    const result = ContextGovernorConfigSchema.safeParse({
      audit_at_tokens: 150000,
      normal_limit_tokens: 150000,
    })
    expect(result.success).toBe(false)
  })

  test("#given target_after_compaction_tokens >= prepare_at_tokens #when parsed #then it is rejected", () => {
    const result = ContextGovernorConfigSchema.safeParse({
      target_after_compaction_tokens: 110000,
      prepare_at_tokens: 110000,
    })
    expect(result.success).toBe(false)
  })

  test("#given maintenance_tier=master without allow_premium_validation #when parsed #then it is rejected", () => {
    const result = ContextGovernorConfigSchema.safeParse({
      twin: { maintenance_tier: "master", allow_premium_validation: false },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" | ")
      expect(messages).toContain("allow_premium_validation")
    }
  })

  test("#given validation_tier=master without allow_premium_validation #when parsed #then it is rejected", () => {
    const result = ContextGovernorConfigSchema.safeParse({
      twin: { validation_tier: "master", allow_premium_validation: false },
    })
    expect(result.success).toBe(false)
  })

  test("#given validation_tier=master with allow_premium_validation=true #when parsed #then it is accepted", () => {
    const result = ContextGovernorConfigSchema.safeParse({
      twin: { validation_tier: "master", allow_premium_validation: true },
    })
    expect(result.success).toBe(true)
  })

  test("#given an unknown top-level key #when parsed #then it is rejected (strict object)", () => {
    const result = ContextGovernorConfigSchema.safeParse({ mystery: 1 })
    expect(result.success).toBe(false)
  })

  test("#given an unknown twin key #when parsed #then it is rejected (strict nested object)", () => {
    const result = ContextGovernorConfigSchema.safeParse({ twin: { mystery: 1 } })
    expect(result.success).toBe(false)
  })
})

describe("resolveEffectiveThresholds", () => {
  test("#given actualLimit=null #when resolved #then null is returned (governor inert)", () => {
    expect(resolveEffectiveThresholds({ configured: defaults(), actualLimit: null })).toBeNull()
  })

  test("#given actualLimit=0 #when resolved #then null is returned (governor inert)", () => {
    expect(resolveEffectiveThresholds({ configured: defaults(), actualLimit: 0 })).toBeNull()
  })

  test("#given actualLimit negative #when resolved #then null is returned (governor inert)", () => {
    expect(resolveEffectiveThresholds({ configured: defaults(), actualLimit: -1 })).toBeNull()
  })

  test("#given defaults + 1M window #when resolved #then absolute limits bind and providerBinds=false", () => {
    const t = resolveEffectiveThresholds({ configured: defaults(), actualLimit: 1_000_000 })
    expect(t).toEqual<EffectiveThresholds>({
      prepareAt: 110000,
      auditAt: 135000,
      compactAt: 150000,
      targetAfter: 60000,
      providerBinds: false,
    })
  })

  test("#given defaults + ratio=1.0 + 1M window #when resolved #then compactAt still pinned at 150000", () => {
    const configured: ContextGovernorConfig = { ...defaults(), provider_relative_ratio: 1 }
    const t = resolveEffectiveThresholds({ configured, actualLimit: 1_000_000 })
    expect(t?.compactAt).toBe(150000)
    expect(t?.providerBinds).toBe(false)
  })

  test("#given defaults + 128k window #when resolved #then provider ratio binds and thresholds scale strictly", () => {
    const t = resolveEffectiveThresholds({ configured: defaults(), actualLimit: 128_000 })
    expect(t).toEqual<EffectiveThresholds>({
      prepareAt: 73216,
      auditAt: 89856,
      compactAt: 99840,
      targetAfter: 49920,
      providerBinds: true,
    })
    // ordering invariants
    expect(t!.prepareAt).toBeLessThan(t!.auditAt)
    expect(t!.auditAt).toBeLessThan(t!.compactAt)
    expect(t!.targetAfter).toBeLessThan(t!.prepareAt)
  })

  test("#given defaults + 32k window #when resolved #then ordering invariants still hold", () => {
    const t = resolveEffectiveThresholds({ configured: defaults(), actualLimit: 32_000 })
    expect(t).not.toBeNull()
    expect(t!.providerBinds).toBe(true)
    expect(t!.prepareAt).toBeLessThan(t!.auditAt)
    expect(t!.auditAt).toBeLessThan(t!.compactAt)
    expect(t!.targetAfter).toBeLessThan(t!.prepareAt)
    expect(t!.targetAfter).toBeGreaterThanOrEqual(1)
  })

  test("#given a fuzz sweep of actualLimit from 10k to 1M #when resolved #then prepare<audit<compact AND target<prepare", () => {
    const cfg = defaults()
    for (let limit = 10_000; limit <= 1_000_000; limit += 1_000) {
      const t = resolveEffectiveThresholds({ configured: cfg, actualLimit: limit })
      expect(t).not.toBeNull()
      const label = `actualLimit=${limit}`
      expect(t!.prepareAt, label).toBeGreaterThanOrEqual(1)
      expect(t!.prepareAt < t!.auditAt).toBe(true)
      expect(t!.auditAt < t!.compactAt).toBe(true)
      expect(t!.targetAfter < t!.prepareAt).toBe(true)
      expect(t!.targetAfter).toBeGreaterThanOrEqual(1)
    }
  })
})
