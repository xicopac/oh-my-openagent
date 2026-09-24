import { describe, expect, test } from "bun:test"

import { createRootWorkerState, type DelegationFailureEvidence } from "./root-worker-state"

function failure(
  id: string,
  kind: DelegationFailureEvidence["kind"] = "child_startup_failure",
): DelegationFailureEvidence {
  return {
    id,
    kind,
    reason: `${kind}:${id}`,
    observedAtMs: 1,
    taskID: id,
  }
}

describe("watchdog-controlled delegation recovery state", () => {
  test("does not expose an assertion-only recovery entry method", () => {
    const state = createRootWorkerState()
    expect("noteRootRepairEntered" in state).toBe(false)
    expect("enterRecovery" in state).toBe(false)
    expect(state.phase("root")).toBe("bootstrap")
  })

  test("one machine failure degrades but does not grant direct repair authority", () => {
    const state = createRootWorkerState()
    const transition = state.recordDelegationFailure("root", failure("bg-1"))

    expect(transition).toMatchObject({ accepted: true, before: "bootstrap", after: "delegation_degraded" })
    expect(state.phase("root")).toBe("delegation_degraded")
    expect(state.decide("root", "edit", { target: "apps/storefront/cart.ts" }).block).toBe(true)
  })

  test("deduplicates repeated reports for the same failed attempt", () => {
    const state = createRootWorkerState()
    expect(state.recordDelegationFailure("root", failure("bg-1")).accepted).toBe(true)
    expect(state.recordDelegationFailure("root", failure("bg-1")).accepted).toBe(false)
    expect(state.recoverySnapshot("root").evidence).toHaveLength(1)
    expect(state.phase("root")).toBe("delegation_degraded")
  })

  test("two distinct machine failures enter constrained recovery mode", () => {
    const state = createRootWorkerState()
    state.recordDelegationFailure("root", failure("bg-1"))
    const transition = state.recordDelegationFailure("root", failure("bg-2", "routing_exhausted"))

    expect(transition.after).toBe("recovery_mode")
    expect(state.decide("root", "read", {
      target: "packages/omo-opencode/src/features/delegation-first/runtime.ts",
    }).block).toBe(false)
    expect(state.decide("root", "edit", { target: "packages/web/src/app/page.tsx" })).toMatchObject({
      block: true,
      reason: "outside_delegation_recovery_scope",
    })
  })

  test("a prior failure plus watchdog-blocked repair detects the circular deadlock without retrying forever", () => {
    const state = createRootWorkerState()
    state.recordDelegationFailure("root", failure("bg-1"))

    const decision = state.decide("root", "edit", {
      target: "packages/omo-opencode/src/features/delegation-first/runtime.ts",
    })

    expect(decision).toMatchObject({ block: false, phase: "recovery_mode" })
    expect(state.recoverySnapshot("root").evidence.map((item) => item.kind)).toEqual([
      "child_startup_failure",
      "circular_deadlock",
    ])
  })

  test("only one explicit verification probe can start in recovery mode", () => {
    const state = createRootWorkerState({ recoveryEvidenceThreshold: 1 })
    state.recordDelegationFailure("root", failure("bg-1"))

    expect(state.beginRecoveryProbe("root", "probe-1", "nonce-1")).toBe(true)
    expect(state.beginRecoveryProbe("root", "probe-2", "nonce-2")).toBe(false)
    expect(state.decide("root", "task", { recoveryProbe: true }).block).toBe(false)
    expect(state.decide("root", "task", { recoveryProbe: false }).block).toBe(true)
  })

  test("verified recovery requires handoff before halt and blocks normal continuation at every terminal phase", () => {
    const state = createRootWorkerState({ recoveryEvidenceThreshold: 1 })
    state.recordDelegationFailure("root", failure("bg-1"))
    state.beginRecoveryProbe("root", "probe-1", "nonce-1")

    expect(state.markRecoveryVerified("root", "probe-1")).toBe(true)
    expect(state.phase("root")).toBe("recovery_verified")
    expect(state.decide("root", "read", { target: "packages/omo-opencode/src/features/delegation-first/runtime.ts" }).block).toBe(true)

    expect(state.markRecoveryHandoff("root", "/project/.omo/handoffs/recovery.md")).toBe(true)
    expect(state.phase("root")).toBe("handoff")
    state.markRecoveryHalted("root")
    expect(state.phase("root")).toBe("halt")
    expect(state.decide("root", "task", { recoveryProbe: true })).toMatchObject({
      block: true,
      reason: "delegation_recovery_halted",
    })

    expect(state.phase("fresh-root")).toBe("bootstrap")
    expect(state.recoverySnapshot("fresh-root").evidence).toEqual([])
  })

  test("bounded verification failure halts without ever marking recovery verified", () => {
    const state = createRootWorkerState({ recoveryEvidenceThreshold: 1, maxRecoveryVerificationAttempts: 2 })
    state.recordDelegationFailure("root", failure("bg-1"))

    state.beginRecoveryProbe("root", "probe-1", "nonce-1")
    expect(state.recordRecoveryProbeFailure("root", "probe-1", "wrong result")).toBe("recovery_mode")
    state.beginRecoveryProbe("root", "probe-2", "nonce-2")
    expect(state.recordRecoveryProbeFailure("root", "probe-2", "still wrong")).toBe("halt")

    expect(state.phase("root")).toBe("halt")
    expect(state.recoverySnapshot("root")).toMatchObject({ verified: false, failureReason: "still wrong" })
  })
})
