import { describe, expect, test } from "bun:test"
import { createRecoveryCoordinator } from "./recovery"

describe("recovery coordinator episode-key budget", () => {
  test("budget is shared across replacement-child reclaims in the SAME episode", () => {
    // given: policy allows 2 reclaims per logical episode
    const c = createRecoveryCoordinator({ sameWorkerMaxReclaims: 2 })
    // when: first reclaim in episode job-1
    c.recordReclaim("job-1", "openai/gpt-4")
    const first = c.evaluate("job-1", "openai/gpt-4", "PROVIDER_RESPONSE_STALL", true)
    // then: still has budget -> retry:true
    expect(first.kind).toBe("reclaim")
    if (first.kind === "reclaim") expect(first.retry).toBe(true)

    // when: second reclaim in SAME episode (simulates redispatch -> new child session, same job-1)
    c.recordReclaim("job-1", "openai/gpt-4")
    const second = c.evaluate("job-1", "openai/gpt-4", "PROVIDER_RESPONSE_STALL", true)
    // then: budget exhausted -> retry:false (would have been retry:true if keyed per-child session)
    expect(second.kind).toBe("reclaim")
    if (second.kind === "reclaim") {
      expect(second.retry).toBe(false)
      expect(second.reason).toContain("same-worker reclaim budget exhausted")
    }
  })

  test("different episodes have independent budgets", () => {
    // given
    const c = createRecoveryCoordinator({ sameWorkerMaxReclaims: 2 })
    c.recordReclaim("job-1", "openai/gpt-4")
    c.recordReclaim("job-1", "openai/gpt-4")
    // when: evaluate a DIFFERENT episode job-2 that has never been reclaimed
    const d = c.evaluate("job-2", "openai/gpt-4", "PROVIDER_RESPONSE_STALL", true)
    // then: still has budget -> retry:true (independent)
    expect(d.kind).toBe("reclaim")
    if (d.kind === "reclaim") expect(d.retry).toBe(true)
  })

  test("reset clears only the targeted episode budget", () => {
    // given: two episodes, one exhausted
    const c = createRecoveryCoordinator({ sameWorkerMaxReclaims: 1 })
    c.recordReclaim("job-1", "p/m")
    expect(c.reclaimCount("job-1")).toBe(1)
    expect(c.reclaimCount("job-2")).toBe(0)
    // when: reset job-1
    c.reset("job-1")
    // then: job-1 budget cleared, evaluate again allows retry
    expect(c.reclaimCount("job-1")).toBe(0)
    const d = c.evaluate("job-1", "p/m", "PROVIDER_RESPONSE_STALL", true)
    expect(d.kind).toBe("reclaim")
    if (d.kind === "reclaim") expect(d.retry).toBe(true)
  })

  test("reclaimCount is keyed by episode, not by transient child session", () => {
    // given: simulate two child sessions belonging to same assignment job-1
    const c = createRecoveryCoordinator({ sameWorkerMaxReclaims: 1 })
    // when: record reclaim for episode job-1 (not child1 session id)
    c.recordReclaim("job-1", "p/m")
    // then: count for episode is 1, and per-child would be 0 if we queried child id
    expect(c.reclaimCount("job-1")).toBe(1)
    expect(c.reclaimCount("child-session-1")).toBe(0)
    expect(c.reclaimCount("child-session-2")).toBe(0)
  })
})
