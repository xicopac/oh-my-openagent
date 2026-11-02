import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PricingCatalog } from "../../hooks/resource-governor/pricing"
import type { RedispatchAction } from "./failover"
import type { ReplayableAssignment } from "./replay"
import {
  authorizeRecoveryRelaunch,
  filterFreeRecoveryFallbackChain,
  type AuthorizeRecoveryRelaunchInput,
} from "./recovery-relaunch-authorization"
import { createRecoveryRelaunchHandler } from "../background-agent/recovery-relaunch"
import { createDelegationFirstRuntime } from "./runtime"

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

const FREE_MODEL = "openai/free-a"
const PAID_MODEL = "openai/paid-b"
const UNKNOWN_MODEL = "openai/unknown-c"

const PRICING: PricingCatalog = {
  [FREE_MODEL]: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  [PAID_MODEL]: { input: 5, output: 20, cache_read: 0, cache_write: 0 },
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-recovery-relaunch-"))
  tempDirs.push(dir)
  return dir
}

function approvalPath(entries: Array<{ model: string }>): string {
  const path = join(tempDir(), "paid-model-approvals.json")
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      approved: entries.map((entry) => ({
        model: entry.model,
        approvedBy: "operator",
        approvedAt: "2026-10-28T00:00:00.000Z",
        reason: "test approval",
      })),
    }),
  )
  return path
}

function baseInput(overrides: Partial<AuthorizeRecoveryRelaunchInput> = {}): AuthorizeRecoveryRelaunchInput {
  return {
    pricing: PRICING,
    rootSessionID: "root",
    requestingSessionID: "root",
    ...overrides,
  }
}

function makeAssignment(overrides: Partial<ReplayableAssignment> = {}): ReplayableAssignment {
  return {
    assignment_id: "asg-1",
    root_session_id: "root",
    parent_session_id: "root",
    parent_message_id: "msg-1",
    prompt: "do the work",
    agent: "explore",
    workers: [
      { model_id: FREE_MODEL, tier: "free", capability: 0.7, free: true },
      { model_id: PAID_MODEL, tier: "cheap_paid", capability: 1, free: false },
    ],
    ...overrides,
  }
}

const paidAction: RedispatchAction = {
  kind: "alternate_worker",
  worker: { model_id: PAID_MODEL, tier: "cheap_paid", capability: 1, free: false },
  worker_index: 1,
  preserveFindings: [],
  reason: "provider response stall",
}

describe("recovery relaunch authorization", () => {
  test("#given a provably free model #when a recovery relaunch is evaluated #then it is allowed", () => {
    const decision = authorizeRecoveryRelaunch(baseInput({ model: FREE_MODEL }))
    expect(decision).toEqual({ allowed: true, kind: "free", model: FREE_MODEL })
  })

  test("#given a live-verified free candidate absent from the static catalog #when evaluated #then it is allowed", () => {
    const decision = authorizeRecoveryRelaunch(
      baseInput({ model: "local/contributor-free", verifiedFree: true }),
    )
    expect(decision).toEqual({ allowed: true, kind: "free", model: "local/contributor-free" })
  })

  test("#given an unknown-cost model with no live evidence #when evaluated #then it is denied", () => {
    const decision = authorizeRecoveryRelaunch(baseInput({ model: UNKNOWN_MODEL }))
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.code).toBe("MODEL_UNKNOWN_COST")
  })

  test("#given a paid model with no approval #when evaluated #then it is denied fail-closed", () => {
    const decision = authorizeRecoveryRelaunch(baseInput({ model: PAID_MODEL }))
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.code).toBe("MODEL_PAID")
  })

  test("#given a static approval-file entry for a paid model #when automatic recovery evaluates it #then it still fails closed", () => {
    approvalPath([{ model: PAID_MODEL }])
    const decision = authorizeRecoveryRelaunch(baseInput({ model: PAID_MODEL }))
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.code).toBe("MODEL_PAID")
  })

  test("#given paid workers disabled by policy #when a paid model is evaluated #then even an approval cannot permit it", () => {
    const decision = authorizeRecoveryRelaunch(
      baseInput({
        model: PAID_MODEL,
        modelRouting: {
          allow_paid_workers: true,
          max_concurrent_paid_workers: 1,
          paid_workers: { policy: "disabled", max_concurrent: 1 },
        },
      }),
    )
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.code).toBe("PAID_POLICY_DISABLED")
  })

  test("#given a non-root requesting session #when a paid model is evaluated #then authority is rejected", () => {
    const decision = authorizeRecoveryRelaunch(
      baseInput({
        model: PAID_MODEL,
        requestingSessionID: "child",
      }),
    )
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.code).toBe("PAID_AUTHORITY_REJECTED")
  })

  test("#given an invalid approval file #when automatic recovery evaluates a paid model #then the file is irrelevant and spending is denied", () => {
    const path = join(tempDir(), "paid-model-approvals.json")
    writeFileSync(path, "{not-json")
    const decision = authorizeRecoveryRelaunch(baseInput({ model: PAID_MODEL }))
    expect(decision.allowed).toBe(false)
    if (decision.allowed) return
    expect(decision.code).toBe("MODEL_PAID")
  })
})

describe("recovery fallback-chain sanitization", () => {
  test("#given a mixed free/paid/unknown chain #when filtered #then only free or live-verified entries remain", () => {
    const chain = [
      { providers: ["openai"], model: "free-a" },
      { providers: ["openai"], model: "paid-b" },
      { providers: ["local"], model: "contributor-free" },
      { providers: ["openai"], model: "unknown-c" },
    ]

    const filtered = filterFreeRecoveryFallbackChain(chain, {
      pricing: PRICING,
      verifiedFreeModels: new Set(["local/contributor-free"]),
    })

    expect(filtered).toEqual([
      { providers: ["openai"], model: "free-a" },
      { providers: ["local"], model: "contributor-free" },
    ])
  })

  test("#given an entry with any unverified provider #when filtered #then the whole entry is dropped", () => {
    const chain = [{ providers: ["openai", "other"], model: "free-a" }]
    const filtered = filterFreeRecoveryFallbackChain(chain, { pricing: PRICING })
    expect(filtered).toBeUndefined()
  })
})

describe("recovery relaunch handler", () => {
  test("#given a paid next worker and no approval #when the handler runs #then it blocks and never launches", async () => {
    const launches: unknown[] = []
    const handler = createRecoveryRelaunchHandler({
      backgroundManager: {
        launch: async (input) => {
          launches.push(input)
          return { id: "bg-1", sessionId: "ses-1" }
        },
      },
      pricing: () => PRICING,
    })

    const outcome = await handler(makeAssignment(), paidAction, "replacement")

    expect(outcome.kind).toBe("blocked")
    expect(launches).toHaveLength(0)
  })

  test("#given a free next worker #when the handler runs #then it launches with a free-only fallback chain", async () => {
    const launches: Array<{ fallbackChain?: Array<{ model: string }> }> = []
    const audits: Array<Record<string, unknown>> = []
    const handler = createRecoveryRelaunchHandler({
      backgroundManager: {
        launch: async (input) => {
          launches.push(input)
          return { id: "bg-1", sessionId: "ses-1" }
        },
      },
      pricing: () => PRICING,
      audit: {
        write: (_sessionID, fields) => {
          audits.push(fields)
        },
        path: () => "",
        flush: async () => {},
      },
    })
    const action: RedispatchAction = {
      kind: "alternate_worker",
      worker: { model_id: FREE_MODEL, tier: "free", capability: 0.7, free: true },
      worker_index: 0,
      preserveFindings: [],
      reason: "provider response stall",
    }

    const outcome = await handler(
      makeAssignment({
        fallback_chain: [
          { providers: ["openai"], model: "free-a" },
          { providers: ["openai"], model: "paid-b" },
        ],
      }),
      action,
      "replacement",
    )

    expect(outcome.kind).toBe("launched")
    expect(launches).toHaveLength(1)
    expect(launches[0]?.fallbackChain).toEqual([{ providers: ["openai"], model: "free-a" }])
    const authorized = audits.find((event) => event.event === "recovery_relaunch_authorized")
    expect(authorized?.fallback_chain_configured).toBe(2)
    expect(authorized?.fallback_chain_kept).toBe(1)
    expect(authorized?.fallback_chain_dropped).toBe(1)
  })
})

describe("recovery runtime terminal handling", () => {
  test("#given a denied paid relaunch #when a stalled child is reclaimed #then the child becomes BLOCKED and the parent is woken with no launch", () => {
    // given
    const now = Date.now()
    const runtime = createDelegationFirstRuntime(undefined, { recovery: { sameWorkerMaxReclaims: 1 } })
    const launches: unknown[] = []
    const cancels: Array<{ sessionID: string; reason: string; options?: { suppressNotification?: boolean; blocked?: boolean } }> = []
    const handler = createRecoveryRelaunchHandler({
      backgroundManager: {
        launch: async (input) => {
          launches.push(input)
          return { id: "bg-1", sessionId: "ses-1" }
        },
      },
      pricing: () => PRICING,
    })
    runtime.setRecoverySink({
      cancel: (sessionID, reason, options) => {
        cancels.push({ sessionID, reason, options })
      },
      relaunch: handler,
    })
    runtime.retainAssignment(
      makeAssignment({ workers: [
        { model_id: FREE_MODEL, tier: "free", capability: 0.7, free: true },
        { model_id: PAID_MODEL, tier: "cheap_paid", capability: 1, free: false },
      ] }),
      "child-1",
    )
    runtime.attachChildSession("root", "child-1")
    runtime.markRequestStarted("child-1")

    // when
    runtime.reclaimStalled("child-1", FREE_MODEL, now + 200_000)

    // then
    expect(launches).toHaveLength(0)
    expect(cancels).toHaveLength(1)
    expect(cancels[0]?.options?.blocked).toBe(true)
    expect(cancels[0]?.options?.suppressNotification).toBe(false)
    expect(cancels[0]?.reason).toContain("RECOVERY_RELAUNCH_DENIED")
    expect(runtime.checkWatchdog("child-1").health).toBe("TERMINAL")
    runtime.dispose()
  })
})
