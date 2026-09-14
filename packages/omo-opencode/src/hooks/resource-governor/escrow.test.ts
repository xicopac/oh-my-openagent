import { describe, expect, test } from "bun:test"

import { createEscrow, escrowExhausted, recordEscrowUsage, settleEscrow, type ChildEscrow } from "./escrow"

function baseEscrow(free = false, tokenBudget = 600_000, paidBudget = 0): ChildEscrow {
  return createEscrow({
    escrow_id: "e1",
    actor_id: "child-1",
    role: "explorer",
    requested_tier: "fast",
    requested_model: null,
    resolved_model: "provider/model",
    free,
    expected_total_tokens: 300_000,
    expected_cost_usd: free ? 0 : 0.5,
    hard_child_token_budget: tokenBudget,
    hard_child_paid_budget_usd: paidBudget,
    max_turns: 6,
    context_fork_policy: "narrow",
    context_fork_tokens: 8_000,
    start_time_ms: 0,
    token_enforced: true,
    cost_estimated: true,
  })
}

describe("escrow", () => {
  // #4 spec: free worker still gets token/turn/context budget
  test("free worker escrow carries token, turn, and context bounds", () => {
    // given a free worker
    // when
    const escrow = baseEscrow(true)
    // then it still has a token budget, max turns, and a narrow fork policy
    expect(escrow.free).toBe(true)
    expect(escrow.hard_child_token_budget).toBe(600_000)
    expect(escrow.max_turns).toBe(6)
    expect(escrow.context_fork_policy).toBe("narrow")
  })

  // #5 spec: paid worker receives explicit escrow
  test("paid worker escrow records expected cost and paid budget", () => {
    const escrow = baseEscrow(false, 600_000, 0.5)
    expect(escrow.free).toBe(false)
    expect(escrow.expected_cost_usd).toBe(0.5)
    expect(escrow.hard_child_paid_budget_usd).toBe(0.5)
  })

  // #23 spec: parallel children consume independent escrows
  test("escrows are independent per actor", () => {
    // given two escrows for two children
    const a = baseEscrow(false)
    const b = baseEscrow(false)
    // when usage lands on a only
    const a2 = recordEscrowUsage(a, { tokens: 500_000, cost_usd: 0.4 })
    // then b is untouched
    expect(a2.usage_tokens).toBe(500_000)
    expect(b.usage_tokens).toBe(0)
  })

  test("escrowExhausted trips on hard token budget", () => {
    // given a child consuming its full token budget
    const escrow = recordEscrowUsage(baseEscrow(false), { tokens: 600_000, cost_usd: 0 })
    // when / then
    expect(escrowExhausted(escrow)).toBe(true)
  })

  test("escrowExhausted trips on hard paid budget", () => {
    const escrow = recordEscrowUsage(baseEscrow(false, 600_000, 0.5), { tokens: 10_000, cost_usd: 0.5 })
    expect(escrowExhausted(escrow)).toBe(true)
  })

  test("free worker with $0 paid budget does not trip on paid budget", () => {
    const escrow = recordEscrowUsage(baseEscrow(true, 600_000, 0), { tokens: 10_000, cost_usd: 0 })
    expect(escrowExhausted(escrow)).toBe(false)
  })

  test("settleEscrow records terminal status", () => {
    const settled = settleEscrow(baseEscrow(false), "completed")
    expect(settled.status).toBe("completed")
    const exhausted = settleEscrow(baseEscrow(false), "exhausted")
    expect(exhausted.status).toBe("exhausted")
  })
})
