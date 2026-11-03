const { afterEach, describe, expect, test } = require("bun:test")
const { createToolExecuteBeforeHandler } = require("./tool-execute-before")
const { createRootWorkerState } = require("../features/delegation-first/root-worker-state")
const { subagentSessions } = require("../features/claude-code-session-state")
const {
  markBtwSideSession,
  resetBtwSideSessionRegistryForTesting,
} = require("../features/btw-side/server-session-registry")

describe("tool-execute-before delegation boundary integration", () => {
  afterEach(() => {
    resetBtwSideSessionRegistryForTesting()
    subagentSessions.clear()
  })

  function stateBackedBoundaryRuntime() {
    const state = createRootWorkerState()
    return {
      preGruntCheck(sessionID: string, tool: string, hint: Record<string, unknown>) {
        const decision = state.decide(sessionID, tool, hint)
        return {
          ...decision,
          steering: decision.block ? `BLOCKED_BY_ROOT_WORKER_STATE:${decision.reason}` : null,
          recoveryAuthorized: decision.recoveryCategory !== null,
          materializationAuthorized: decision.materializationCategory === "materialization",
        }
      },
    }
  }

  test("root session calling broad MCP tool is evaluated through boundary gate", async () => {
    //#given
    const sessionID = "ses_root_main"
    const observedTools: string[] = []

    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
      delegationFirstRuntime: {
        preGruntCheck(_sessionID: string, tool: string) {
          observedTools.push(tool)
          return { block: false, steering: null }
        },
      },
    })

    //#when
    const runs = [
      handler({ tool: "session_list", sessionID, callID: "call_1" }, { args: {} as Record<string, unknown> }),
      handler({ tool: "mcp_foo", sessionID, callID: "call_2" }, { args: {} as Record<string, unknown> }),
      handler({ tool: "mcp_background_output", sessionID, callID: "call_3" }, { args: {} as Record<string, unknown> }),
    ]

    //#then
    for (const run of runs) {
      await expect(run).resolves.toBeUndefined()
    }
    expect(observedTools).toEqual(["session_list", "mcp_foo", "background_output"])
  })

  test("root session session_list call is subject to the gate; subagent session_list call is allowed", async () => {
    //#given
    const rootSessionID = "ses_root"
    const workerSessionID = "ses_worker"

    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    //#when
    // Root session calling session_list - evaluated through the gate
    const rootCall = handler(
      { tool: "session_list", sessionID: rootSessionID, callID: "call_root" },
      { args: {} as Record<string, unknown> },
    )

    // Worker/subagent session calling session_list - skipped gate entirely
    const workerCall = handler(
      { tool: "session_list", sessionID: workerSessionID, callID: "call_worker" },
      { args: {} as Record<string, unknown> },
    )

    //#then
    // Both should resolve, but root goes through gate evaluation
    await expect(rootCall).resolves.toBeUndefined()
    await expect(workerCall).resolves.toBeUndefined()
  })

  test("root session grep call is evaluated through the gate with hint", async () => {
    //#given
    const sessionID = "ses_root_grep"

    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    //#when
    // Root session calling grep with a specific target
    const run = handler(
      { tool: "grep", sessionID, callID: "call_grep" },
      { args: { target: "src" } as Record<string, unknown> },
    )

    //#then
    // Below threshold: should be allowed (not blocked)
    await expect(run).resolves.toBeUndefined()
  })

  test("root session interactive_bash call is evaluated through the boundary gate", async () => {
    //#given
    const sessionID = "ses_root_interactive_bash"

    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    //#when
    const run = handler(
      { tool: "interactive_bash", sessionID, callID: "call_ib" },
      { args: { command: "ls" } as Record<string, unknown> },
    )

    //#then
    await expect(run).resolves.toBeUndefined()
  })

  test("worker session interactive_bash call is allowed with no steering", async () => {
    //#given
    const workerSessionID = "ses_worker_ib"

    // Mark as worker by adding to subagentSessions? The handler uses subagentSessions set.
    // We rely on classifyBoundaryRole; worker sessions are those in subagentSessions.
    subagentSessions.add(workerSessionID)

    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    //#when
    const run = handler(
      { tool: "interactive_bash", sessionID: workerSessionID, callID: "call_ib_worker" },
      { args: { command: "ls" } as Record<string, unknown> },
    )

    //#then
    await expect(run).resolves.toBeUndefined()

    subagentSessions.delete(workerSessionID)
  })

  test("root apply_patch is blocked after delegation is required while a registered worker is allowed", async () => {
    const rootSessionID = "ses_root_patch"
    const workerSessionID = "ses_worker_patch"
    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
      delegationFirstRuntime: stateBackedBoundaryRuntime(),
    })

    await expect(handler(
      { tool: "bash", sessionID: rootSessionID, callID: "call_broad" },
      { args: { command: "rg TODO ." } as Record<string, unknown> },
    )).rejects.toThrow("BLOCKED_BY_ROOT_WORKER_STATE")

    const patchText = [
      "*** Begin Patch",
      "*** Update File: packages/omo-opencode/src/index.ts",
      "@@",
      "-export const value = 1",
      "+export const value = 2",
      "*** End Patch",
    ].join("\n")

    await expect(handler(
      { tool: "apply_patch", sessionID: rootSessionID, callID: "call_root_patch" },
      { args: { patchText } as Record<string, unknown> },
    )).rejects.toThrow("BLOCKED_BY_ROOT_WORKER_STATE")

    subagentSessions.add(workerSessionID)
    await expect(handler(
      { tool: "apply_patch", sessionID: workerSessionID, callID: "call_worker_patch" },
      { args: { patchText } as Record<string, unknown> },
    )).resolves.toBeUndefined()
  })

  test("apply_patch passes every durable target and destructive intent to the policy boundary", async () => {
    let observedHint: Record<string, unknown> | undefined
    const runtime = {
      preGruntCheck(_sessionID: string, _tool: string, hint: Record<string, unknown>) {
        observedHint = hint
        return {
          block: false,
          steering: null,
          recoveryAuthorized: false,
          materializationAuthorized: false,
          humanAuthorized: false,
        }
      },
    }
    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
      delegationFirstRuntime: runtime,
    })
    const patchText = [
      "*** Begin Patch",
      "*** Add File: .omo/evidence/run/result.txt",
      "+ok",
      "*** Update File: .omo/plans/stabilization.md",
      "@@",
      "+done",
      "*** End Patch",
    ].join("\n")

    await handler(
      { tool: "apply_patch", sessionID: "ses_patch_scope", callID: "call_patch_scope" },
      { args: { patchText } as Record<string, unknown> },
    )

    expect(observedHint?.materializationTargets).toEqual([
      ".omo/evidence/run/result.txt",
      ".omo/plans/stabilization.md",
    ])
    expect(observedHint?.materializationDestructive).toBe(false)
    expect(observedHint?.materialization).toBe(true)
  })

  test("grep pattern is not mistaken for a scoped path", async () => {
    const observedHints: Record<string, unknown>[] = []
    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
      delegationFirstRuntime: {
        preGruntCheck(_sessionID: string, _tool: string, hint: Record<string, unknown>) {
          observedHints.push(hint)
          return { block: false, steering: null }
        },
      },
    })

    await handler(
      { tool: "grep", sessionID: "ses_grep_unscoped", callID: "call_grep_unscoped" },
      { args: { pattern: "TODO" } as Record<string, unknown> },
    )
    await handler(
      { tool: "grep", sessionID: "ses_grep_scoped", callID: "call_grep_scoped" },
      { args: { pattern: "TODO", path: "src" } as Record<string, unknown> },
    )

    expect(observedHints[0]?.target).toBeUndefined()
    expect(observedHints[1]?.target).toBe("src")
  })
})
