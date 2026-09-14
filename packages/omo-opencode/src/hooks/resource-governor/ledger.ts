/**
 * Authoritative Resource Ledger (pure). One shared accounting surface for
 * root and every child, so the Token/Cost Cop and Delegation Cop never drift
 * into separate ledgers (spec section 3 + 17).
 *
 * All state is passed by value; no IO, no singletons. The caller owns timing
 * and persistence.
 */

export type UsageRecord = {
  /** Root, or the child session/task id. */
  actor_id: string
  role: "root" | "child"
  model_id: string | null
  provider_id: string | null
  tier: string | null
  free: boolean
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  /** estimated USD, 0 when free; marked separately because unknown pricing is 0 too. */
  cost_usd: number
  /** True when cost_usd is an estimate vs an observed provider value. */
  cost_estimated: boolean
  context_tokens: number
  retries: number
  status: "active" | "completed" | "failed"
  /** Wasted or duplicate work attribution in raw tokens. */
  avoidable_tokens: number
}

export type LedgerTotals = {
  total_tokens: number
  total_paid_tokens: number
  total_free_tokens: number
  total_root_tokens: number
  total_child_tokens: number
  total_cost_usd: number
  total_free_cost_usd: number
  total_context_replication: number
  total_avoidable_tokens: number
  child_count: number
  active_child_count: number
  retries: number
}

export type ResourceLedger = {
  records: UsageRecord[]
  /** Estimated raw tokens forked into children that duplicated root context. */
  context_replication_tokens: number
}

export function createLedger(): ResourceLedger {
  return { records: [], context_replication_tokens: 0 }
}

function rawTokens(r: UsageRecord): number {
  return r.input_tokens + r.cache_read_tokens + r.cache_write_tokens + r.output_tokens
}

export function recordUsage(ledger: ResourceLedger, record: UsageRecord): void {
  ledger.records.push(record)
}

export function recordContextReplication(ledger: ResourceLedger, tokens: number): void {
  ledger.context_replication_tokens += Math.max(0, tokens)
}

/**
 * Estimate the raw tokens of replicated context across N children. A narrow
 * fork (capsule + anchors) costs a small fixed per-child amount; a full fork
 * costs the entire root context per child. Used to disfavor full-context
 * fan-out (spec section 15).
 */
export function estimateContextReplication(childCount: number, perChildForkTokens: number): number {
  return Math.max(0, childCount) * Math.max(0, perChildForkTokens)
}

export function totalRawTokens(ledger: ResourceLedger): number {
  return ledger.records.reduce((sum, r) => sum + rawTokens(r), 0)
}

export function computeTotals(ledger: ResourceLedger): LedgerTotals {
  let total_tokens = 0
  let total_paid_tokens = 0
  let total_free_tokens = 0
  let total_root_tokens = 0
  let total_child_tokens = 0
  let total_cost_usd = 0
  let total_free_cost_usd = 0
  let total_avoidable_tokens = 0
  let child_count = 0
  let active_child_count = 0
  let retries = 0

  for (const r of ledger.records) {
    const tokens = rawTokens(r)
    total_tokens += tokens
    if (r.free) {
      total_free_tokens += tokens
      total_free_cost_usd += r.cost_usd
    } else {
      total_paid_tokens += tokens
      total_cost_usd += r.cost_usd
    }
    if (r.role === "root") total_root_tokens += tokens
    else total_child_tokens += tokens
    total_avoidable_tokens += r.avoidable_tokens
    retries += r.retries
    if (r.role === "child") {
      child_count += 1
      if (r.status === "active") active_child_count += 1
    }
  }

  return {
    total_tokens,
    total_paid_tokens,
    total_free_tokens,
    total_root_tokens,
    total_child_tokens,
    total_cost_usd,
    total_free_cost_usd,
    total_context_replication: ledger.context_replication_tokens,
    total_avoidable_tokens,
    child_count,
    active_child_count,
    retries,
  }
}

/**
 * Most-expensive single actor by USD (ties break to the highest raw tokens).
 * Used by the end-of-run account's "which worker was most expensive" answer.
 */
export function mostExpensiveRecord(ledger: ResourceLedger): UsageRecord | null {
  let best: UsageRecord | null = null
  for (const r of ledger.records) {
    if (best === null) {
      best = r
      continue
    }
    if (r.cost_usd > best.cost_usd) {
      best = r
    } else if (r.cost_usd === best.cost_usd && rawTokens(r) > rawTokens(best)) {
      best = r
    }
  }
  return best
}
