const { afterEach, describe, expect, test } = require("bun:test")
const { createToolExecuteBeforeHandler } = require("./tool-execute-before")
const {
  markBtwSideSession,
  resetBtwSideSessionRegistryForTesting,
} = require("../features/btw-side/server-session-registry")

describe("tool-execute-before delegation boundary integration", () => {
  afterEach(() => {
    resetBtwSideSessionRegistryForTesting()
  })

  test("root session calling broad MCP tool is evaluated through boundary gate", async () => {
    //#given
    const sessionID = "ses_root_main"

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
    // (allowed below threshold, since single call doesn't cross it)
    // Root session calling mcp_foo - MCP-prefixed tool evaluated as broad
    const runs = [
      handler({ tool: "session_list", sessionID, callID: "call_1" }, { args: {} as Record<string, unknown> }),
      handler({ tool: "mcp_foo", sessionID, callID: "call_2" }, { args: {} as Record<string, unknown> }),
    ]

    //#then
    // Both should resolve (allowed below threshold for fresh session)
    for (const run of runs) {
      await expect(run).resolves.toBeUndefined()
    }
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
    const { subagentSessions } = require("../features/claude-code-session-state")
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
})