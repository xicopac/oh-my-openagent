import { describe, test, expect } from "bun:test"
import { createDelegationFirstRuntime } from "../../features/delegation-first/runtime"
import { appendRecoveryProbeDirective, createDelegateTask, maybeVerifyRecoveryProbe } from "./tools"
import { executeBackgroundTask } from "./background-task"
import type { GovernanceAuditWriter } from "../../shared/governance-audit"
import type { LaunchInput } from "../../features/background-agent/types"

function fakeAudit(): GovernanceAuditWriter {
  return {
    write: () => {},
    path: () => "",
    flush: async () => {},
  } as unknown as GovernanceAuditWriter
}

function distinctFailures(sessionID: string) {
  return [
    {
      id: `fail-1:${sessionID}`,
      kind: "child_startup_failure" as const,
      reason: "child_startup_failure",
      observedAtMs: 1,
      taskID: "bg-1",
    },
    {
      id: `fail-2:${sessionID}`,
      kind: "routing_exhausted" as const,
      reason: "routing_exhausted",
      observedAtMs: 2,
      taskID: "bg-2",
    },
  ]
}

describe("recovery probe driver", () => {
  test("auto-begins probe on task preGruntCheck in recovery_mode", () => {
    // given: runtime in recovery_mode (threshold 2)
    const audit = fakeAudit()
    const rt = createDelegationFirstRuntime(audit)
    const sessionID = "ses-probe-auto-begin"

    for (const ev of distinctFailures(sessionID)) {
      rt.recordDelegationFailure(sessionID, ev)
    }
    // when: preGruntCheck with task and no active probe
    expect(rt.recoverySnapshot(sessionID).phase).toBe("recovery_mode")
    expect(rt.recoverySnapshot(sessionID).activeProbe).toBeNull()

    const decision = rt.preGruntCheck(sessionID, "task")

    // then: probe auto-started, phase stays recovery_mode, decision allows delegation probe
    const snap = rt.recoverySnapshot(sessionID)
    expect(snap.activeProbe).not.toBeNull()
    expect(snap.phase).toBe("recovery_mode")
    expect(snap.activeProbe?.probeID.startsWith("probe-")).toBe(true)
    expect(snap.activeProbe?.nonce.length).toBeGreaterThan(0)
    expect(decision.delegated).toBe(true)

    rt.dispose()
  })

  test("does not auto-begin for child sessions", () => {
    // given: parent in recovery_mode with a child session attached
    const audit = fakeAudit()
    const rt = createDelegationFirstRuntime(audit)
    const parent = "ses-parent-no-auto"
    for (const ev of distinctFailures(parent)) {
      rt.recordDelegationFailure(parent, ev)
    }
    const child = "ses-child-no-auto"
    rt.attachChildSession(parent, child)

    // when: child calls preGruntCheck task while parent is in recovery_mode but child is not
    // then: child itself never auto-begins (recovery is per-session, child has no failure evidence)
    const childDecision = rt.preGruntCheck(child, "task")
    expect(rt.recoverySnapshot(child).activeProbe).toBeNull()
    expect(rt.recoverySnapshot(child).phase).toBe("normal")

    // when: parent is a child session (isChildSession true), auto-begin must be rejected
    // simulate by making parent itself a child of another root
    const root = "ses-root-for-child-test"
    for (const ev of distinctFailures(root)) {
      rt.recordDelegationFailure(root, ev)
    }
    rt.attachChildSession(root, parent)
    // parent is now a child session; task should not auto-begin for it if we treat child sessions as non-roots
    // our runtime correctly rejects nested_child_probe_rejected inside beginRecoveryProbe,
    // but preGruntCheck guards via isChildSession check
    const childProbeAttempt = rt.beginRecoveryProbe(parent, "probe-wrong", "nonce-wrong")
    expect(childProbeAttempt).toBe(false)

    rt.dispose()
  })

  test("markRecoveryVerified succeeds with active probeID", () => {
    // given: recovery_mode with auto-started probe
    const audit = fakeAudit()
    const rt = createDelegationFirstRuntime(audit)
    const sessionID = "ses-verify-ok"
    for (const ev of distinctFailures(sessionID)) {
      rt.recordDelegationFailure(sessionID, ev)
    }
    rt.preGruntCheck(sessionID, "task")
    const snap = rt.recoverySnapshot(sessionID)
    // when: mark verified with correct probeID
    const ok = rt.markRecoveryVerified(sessionID, snap.activeProbe!.probeID)
    // then: succeeds and moves to recovery_verified
    expect(ok).toBe(true)
    expect(rt.recoverySnapshot(sessionID).phase).toBe("recovery_verified")
    expect(rt.rootPhase(sessionID)).toBe("recovery_verified")

    rt.dispose()
  })

  test("helper verifies nonce-containing result and marks verified", () => {
    // given: recovery_mode with active probe
    const audit = fakeAudit()
    const rt = createDelegationFirstRuntime(audit)
    const sessionID = "ses-helper-verify"
    for (const ev of distinctFailures(sessionID)) {
      rt.recordDelegationFailure(sessionID, ev)
    }
    rt.preGruntCheck(sessionID, "task")
    const before = rt.recoverySnapshot(sessionID)
    const nonce = before.activeProbe!.nonce
    const probeID = before.activeProbe!.probeID
    // when: helper sees result containing nonce
    const resultText = `worker completed successfully; nonce=${nonce}; deliverable at src/foo.ts:10`
    const verified = maybeVerifyRecoveryProbe(rt, sessionID, resultText)
    // then: helper returns true and runtime moves to verified
    expect(verified).toBe(true)
    expect(rt.recoverySnapshot(sessionID).phase).toBe("recovery_verified")
    expect(rt.recoverySnapshot(sessionID).activeProbe?.probeID).toBe(probeID)

    rt.dispose()
  })

  test("helper does not verify when nonce absent", () => {
    // given: recovery_mode with active probe
    const audit = fakeAudit()
    const rt = createDelegationFirstRuntime(audit)
    const sessionID = "ses-helper-no-nonce"
    for (const ev of distinctFailures(sessionID)) {
      rt.recordDelegationFailure(sessionID, ev)
    }
    rt.preGruntCheck(sessionID, "task")
    // when: result does NOT contain nonce
    const verified = maybeVerifyRecoveryProbe(rt, sessionID, "worker completed but no nonce here")
    // then: not verified, stays in recovery_mode
    expect(verified).toBe(false)
    expect(rt.recoverySnapshot(sessionID).phase).toBe("recovery_mode")

    rt.dispose()
  })

  test("beginRecoveryProbe returns false for wrong probeID (invalid authorization)", () => {
    // given: recovery_mode with active probe
    const audit = fakeAudit()
    const rt = createDelegationFirstRuntime(audit)
    const sessionID = "ses-wrong-probe"
    for (const ev of distinctFailures(sessionID)) {
      rt.recordDelegationFailure(sessionID, ev)
    }
    rt.preGruntCheck(sessionID, "task")
    const snap = rt.recoverySnapshot(sessionID)
    expect(snap.activeProbe).not.toBeNull()
    // when: attempt to begin again with different probeID while one is active
    const secondBegin = rt.beginRecoveryProbe(sessionID, "probe-wrong-id", "nonce-wrong")
    // then: denied
    expect(secondBegin).toBe(false)
    // when: attempt to verify with wrong probeID
    const wrongVerify = rt.markRecoveryVerified(sessionID, "probe-wrong-id")
    // then: denied, stays in recovery_mode
    expect(wrongVerify).toBe(false)
    expect(rt.recoverySnapshot(sessionID).phase).toBe("recovery_mode")
    // when: verify with correct ID still works
    const correctVerify = rt.markRecoveryVerified(sessionID, snap.activeProbe!.probeID)
    expect(correctVerify).toBe(true)

    rt.dispose()
  })

  test("background LaunchInput carries recoveryProbe when probe is active", async () => {
    // given: runtime in recovery_mode with active probe
    const audit = fakeAudit()
    const rt = createDelegationFirstRuntime(audit)
    const sessionID = "ses-bg-probe-active"
    for (const ev of distinctFailures(sessionID)) {
      rt.recordDelegationFailure(sessionID, ev)
    }
    rt.preGruntCheck(sessionID, "task")
    const snap = rt.recoverySnapshot(sessionID)
    expect(snap.activeProbe).not.toBeNull()
    // when: background task is launched with recoveryProbe derived from snapshot
    let captured: LaunchInput | undefined
    const fakeManager = {
      launch: async (input: LaunchInput) => {
        captured = input
        return {
          id: "bg_test123",
          description: input.description,
          agent: input.agent,
          status: "running" as const,
          sessionId: "ses-child-bg",
          parentSessionId: sessionID,
        }
      },
      getTask: () => ({ id: "bg_test123", status: "running" as const, sessionId: "ses-child-bg" }),
    }
    const recoveryProbe = rt.recoverySnapshot(sessionID).activeProbe != null
    expect(recoveryProbe).toBe(true)
    const parentContext = { sessionID, messageID: "msg-1", agent: "sisyphus", model: undefined }
    const executorCtx = {
      manager: fakeManager,
      client: { session: { get: async () => ({ data: {} }) } },
      directory: "/tmp",
    } as unknown as Parameters<typeof executeBackgroundTask>[2]
    // then: LaunchInput must carry recoveryProbe true so authorizeLaunch early-ALLOWs
    await executeBackgroundTask(
      { description: "probe", prompt: "recover", load_skills: [], run_in_background: true } as unknown as Parameters<typeof executeBackgroundTask>[0],
      { sessionID, messageID: "msg-1", agent: "sisyphus", abort: new AbortController().signal } as unknown as Parameters<typeof executeBackgroundTask>[1],
      executorCtx,
      parentContext as unknown as Parameters<typeof executeBackgroundTask>[3],
      "explore",
      undefined,
      undefined,
      undefined,
      false,
      recoveryProbe,
    )
    expect(captured?.recoveryProbe).toBe(true)
    rt.dispose()
  })

  test("background LaunchInput omits recoveryProbe when no probe", async () => {
    // given: runtime in normal phase (no probe)
    const audit = fakeAudit()
    const rt = createDelegationFirstRuntime(audit)
    const sessionID = "ses-bg-no-probe"
    expect(rt.recoverySnapshot(sessionID).activeProbe).toBeNull()
    // when: background task launched with recoveryProbe false
    let captured: LaunchInput | undefined
    const fakeManager = {
      launch: async (input: LaunchInput) => {
        captured = input
        return {
          id: "bg_test456",
          description: input.description,
          agent: input.agent,
          status: "running" as const,
          sessionId: "ses-child-bg2",
          parentSessionId: sessionID,
        }
      },
      getTask: () => ({ id: "bg_test456", status: "running" as const, sessionId: "ses-child-bg2" }),
    }
    const recoveryProbe = rt.recoverySnapshot(sessionID).activeProbe != null
    expect(recoveryProbe).toBe(false)
    const parentContext = { sessionID, messageID: "msg-1", agent: "sisyphus", model: undefined }
    const executorCtx = {
      manager: fakeManager,
      client: { session: { get: async () => ({ data: {} }) } },
      directory: "/tmp",
    } as unknown as Parameters<typeof executeBackgroundTask>[2]
    await executeBackgroundTask(
      { description: "normal", prompt: "do thing", load_skills: [], run_in_background: true } as unknown as Parameters<typeof executeBackgroundTask>[0],
      { sessionID, messageID: "msg-1", agent: "sisyphus", abort: new AbortController().signal } as unknown as Parameters<typeof executeBackgroundTask>[1],
      executorCtx,
      parentContext as unknown as Parameters<typeof executeBackgroundTask>[3],
      "explore",
      undefined,
      undefined,
      undefined,
      false,
      recoveryProbe,
    )
    // then: recoveryProbe must be absent/undefined, so governor does not early-ALLOW
    expect(captured?.recoveryProbe).toBeUndefined()
    rt.dispose()
  })

  test("probe prompt carries nonce token to background child via task tool", async () => {
    // given: runtime in recovery_mode with auto-begun probe
    const audit = fakeAudit()
    const rt = createDelegationFirstRuntime(audit)
    const sessionID = "ses-probe-prompt-token"
    for (const ev of distinctFailures(sessionID)) {
      rt.recordDelegationFailure(sessionID, ev)
    }
    rt.preGruntCheck(sessionID, "task")
    const snap = rt.recoverySnapshot(sessionID)
    expect(snap.activeProbe).not.toBeNull()
    const nonce = snap.activeProbe!.nonce
    const token = `RECOVERY_PROBE_ECHO:${nonce}`
    // when: task tool launches a background child while probe is active
    let captured: LaunchInput | undefined
    const fakeManager = {
      launch: async (input: LaunchInput) => {
        captured = input
        return {
          id: "bg_probe_token",
          description: input.description,
          agent: input.agent,
          status: "running" as const,
          sessionId: "ses-child-probe",
          parentSessionId: sessionID,
        }
      },
      getTask: () => ({ id: "bg_probe_token", status: "running" as const, sessionId: "ses-child-probe" }),
    }
    const fakeClient = {
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: { model: "anthropic/claude-sonnet-4-6" } }) },
      provider: { list: async () => ({ data: { connected: ["openai"] } }) },
      model: { list: async () => ({ data: [{ provider: "openai", id: "gpt-5.5" }] }) },
      session: {
        create: async () => ({ data: { id: "ses-child-probe" } }),
        prompt: async () => ({ data: {} }),
        promptAsync: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: {} }),
        get: async () => ({ data: { parentID: null } }),
      },
    } as unknown as Parameters<typeof createDelegateTask>[0]["client"]
    const tool = createDelegateTask({
      isRootSession: true,
      manager: fakeManager as unknown as Parameters<typeof createDelegateTask>[0]["manager"],
      client: fakeClient,
      delegationFirstRuntime: rt,
      availableModelsOverride: new Set(["kimi-for-coding/kimi-for-coding-highspeed"]),
      pricingCatalog: { "kimi-for-coding/kimi-for-coding-highspeed": { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
    })
    const toolCtx = {
      sessionID,
      messageID: "msg-probe",
      agent: "sisyphus",
      abort: new AbortController().signal,
      ask: async () => {},
      callID: "call-probe",
    } as unknown as Parameters<ReturnType<typeof createDelegateTask>["execute"]>[1]
    await tool.execute(
      { description: "probe task", prompt: "do recovery probe work", category: "quick", run_in_background: true, load_skills: [] },
      toolCtx,
    )
    // then: launched prompt contains the exact nonce token so child can echo it
    expect(captured).toBeDefined()
    expect(captured?.prompt).toBeDefined()
    expect(captured?.prompt).toContain(token)
    rt.dispose()
  })

  test("full round trip: probe prompt with nonce echo verifies recovery", () => {
    // given: runtime in recovery_mode with auto-begun probe
    const audit = fakeAudit()
    const rt = createDelegationFirstRuntime(audit)
    const sessionID = "ses-probe-roundtrip"
    for (const ev of distinctFailures(sessionID)) {
      rt.recordDelegationFailure(sessionID, ev)
    }
    rt.preGruntCheck(sessionID, "task")
    const snap = rt.recoverySnapshot(sessionID)
    expect(snap.activeProbe).not.toBeNull()
    expect(snap.phase).toBe("recovery_mode")
    const nonce = snap.activeProbe!.nonce
    const probeID = snap.activeProbe!.probeID
    // when: prompt is built with nonce directive and child echoes the token
    const promptWithNonce = appendRecoveryProbeDirective("do recovery probe work", nonce)
    expect(promptWithNonce).toContain(`RECOVERY_PROBE_ECHO:${nonce}`)
    const childResult = `work done\nRECOVERY_PROBE_ECHO:${nonce}\nadditional context`
    const verified = maybeVerifyRecoveryProbe(rt, sessionID, childResult)
    // then: verification succeeds and moves to recovery_verified
    expect(verified).toBe(true)
    expect(rt.recoverySnapshot(sessionID).phase).toBe("recovery_verified")
    expect(rt.recoverySnapshot(sessionID).activeProbe?.probeID).toBe(probeID)
    expect(rt.rootPhase(sessionID)).toBe("recovery_verified")
    rt.dispose()
  })
})
