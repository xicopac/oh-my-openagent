import { describe, expect, test } from "bun:test"

import {
  computeTotals,
  createLedger,
  estimateContextReplication,
  mostExpensiveRecord,
  recordContextReplication,
  recordUsage,
  totalRawTokens,
  type UsageRecord,
} from "./ledger"

function rootRecord(tokens: number, costUsd: number, extra: Partial<UsageRecord> = {}): UsageRecord {
  return {
    actor_id: "root",
    role: "root",
    model_id: "provider/root",
    provider_id: "provider",
    tier: "master",
    free: false,
    input_tokens: tokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: costUsd,
    cost_estimated: true,
    context_tokens: tokens,
    retries: 0,
    status: "active",
    avoidable_tokens: 0,
    ...extra,
  }
}

function childRecord(actor: string, tokens: number, free: boolean, costUsd: number, extra: Partial<UsageRecord> = {}): UsageRecord {
  return rootRecord(tokens, costUsd, { actor_id: actor, role: "child", free, ...extra })
}

describe("ledger", () => {
  // #25 spec: task ledger aggregates root + children
  test("computeTotals aggregates root + children tokens", () => {
    // given root 100k + one free child 50k + one paid child 60k
    const ledger = createLedger()
    recordUsage(ledger, rootRecord(100_000, 0.2))
    recordUsage(ledger, childRecord("c1", 50_000, true, 0))
    recordUsage(ledger, childRecord("c2", 60_000, false, 0.3))
    // when
    const totals = computeTotals(ledger)
    // then
    expect(totals.total_tokens).toBe(210_000)
    expect(totals.total_root_tokens).toBe(100_000)
    expect(totals.total_child_tokens).toBe(110_000)
    expect(totals.total_free_tokens).toBe(50_000)
    expect(totals.total_paid_tokens).toBe(160_000)
    expect(totals.child_count).toBe(2)
  })

  // #13 spec: retry consumption is accounted
  test("retries are summed across records", () => {
    // given records that accumulated retries
    const ledger = createLedger()
    recordUsage(ledger, rootRecord(10_000, 0, { retries: 1 }))
    recordUsage(ledger, childRecord("c1", 10_000, true, 0, { retries: 3 }))
    // when
    const totals = computeTotals(ledger)
    // then
    expect(totals.retries).toBe(4)
  })

  test("mostExpensiveRecord identifies the highest-cost actor", () => {
    // given mixed costs
    const ledger = createLedger()
    recordUsage(ledger, rootRecord(100_000, 0.5))
    recordUsage(ledger, childRecord("c1", 50_000, true, 0))
    recordUsage(ledger, childRecord("c2", 40_000, false, 2.1))
    // when
    const expensive = mostExpensiveRecord(ledger)
    // then
    expect(expensive?.actor_id).toBe("c2")
  })

  test("avoidable/wasted usage is tracked", () => {
    const ledger = createLedger()
    recordUsage(ledger, childRecord("dup", 180_000, true, 0, { avoidable_tokens: 180_000 }))
    recordUsage(ledger, childRecord("rev", 220_000, false, 0.3, { avoidable_tokens: 220_000 }))
    expect(computeTotals(ledger).total_avoidable_tokens).toBe(400_000)
  })

  test("totalRawTokens sums all buckets", () => {
    const ledger = createLedger()
    recordUsage(ledger, rootRecord(0, 0, { input_tokens: 10, cache_read_tokens: 20, cache_write_tokens: 5, output_tokens: 15 }))
    expect(totalRawTokens(ledger)).toBe(50)
  })

  // #15 spec: child context replication is included in the estimate
  test("context replication is tracked separately and aggregated", () => {
    // given a full-context fork to 3 children at 300k each
    const ledger = createLedger()
    recordContextReplication(ledger, estimateContextReplication(3, 300_000))
    // when
    const totals = computeTotals(ledger)
    // then
    expect(totals.total_context_replication).toBe(900_000)
  })

  // #16 spec: full-context fan-out is disfavored; narrow fork is far cheaper
  test("estimateContextReplication scales with child count and per-child fork size", () => {
    // given narrow (capsule) fork of 8000 tokens vs full fork of 300000
    // when
    const narrow = estimateContextReplication(4, 8_000)
    const full = estimateContextReplication(4, 300_000)
    // then narrow is materially smaller
    expect(narrow).toBe(32_000)
    expect(full).toBe(1_200_000)
    expect(narrow).toBeLessThan(full)
  })
})
