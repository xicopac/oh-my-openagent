import { afterEach, describe, expect, test } from "bun:test"

import { subagentSessions } from "../features/claude-code-session-state"
import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "../features/delegation-first"
import { createToolExecuteAfterHandler } from "./tool-execute-after"
import { createToolExecuteBeforeHandler } from "./tool-execute-before"

const ROOT_SESSION = "ses_root"
const CHILD_SESSION = "ses_child"
const LONG_PROCESS_PROBE_MS = 200_000

type Harness = {
  runtime: DelegationFirstRuntime
  before: ReturnType<typeof createToolExecuteBeforeHandler>
  after: ReturnType<typeof createToolExecuteAfterHandler>
}

function createHarness(): Harness {
  const runtime = createDelegationFirstRuntime(undefined, {})
  runtime.attachChildSession(ROOT_SESSION, CHILD_SESSION)
  runtime.markRequestStarted(CHILD_SESSION)
  subagentSessions.add(CHILD_SESSION)
  return {
    runtime,
    before: createToolExecuteBeforeHandler({
      ctx: { client: { session: { messages: async () => ({ data: [] }) } } } as never,
      hooks: {} as never,
      delegationFirstRuntime: runtime,
    }),
    after: createToolExecuteAfterHandler({
      ctx: {} as never,
      hooks: {} as never,
      delegationFirstRuntime: runtime,
    }),
  }
}

function stallModeAt(runtime: DelegationFirstRuntime, nowMs: number): string | null {
  return runtime.checkWatchdog(CHILD_SESSION, nowMs).stallMode
}

afterEach(() => {
  subagentSessions.delete(CHILD_SESSION)
})

describe("delegation-first long-process lifecycle through the tool hooks", () => {
  test("#given a registered child #when tool.execute.before handles bash #then the long-process flag is active", async () => {
    // given
    const { runtime, before } = createHarness()
    const startedAt = Date.now()

    // when
    await before(
      { tool: "bash", sessionID: CHILD_SESSION, callID: "call_bash_1" },
      { args: { command: "echo hi" } },
    )

    // then
    expect(stallModeAt(runtime, startedAt + LONG_PROCESS_PROBE_MS)).toBe("QUIET_BUT_ACTIVE")
    runtime.dispose()
  })

  test("#given an active bash long process #when tool.execute.after handles it #then the flag clears", async () => {
    // given
    const { runtime, before, after } = createHarness()
    const startedAt = Date.now()
    await before(
      { tool: "bash", sessionID: CHILD_SESSION, callID: "call_bash_2" },
      { args: { command: "echo hi" } },
    )

    // when
    await after(
      { tool: "bash", sessionID: CHILD_SESSION, callID: "call_bash_2" },
      { title: "bash", output: "hi", metadata: {} },
    )

    // then
    expect(stallModeAt(runtime, startedAt + LONG_PROCESS_PROBE_MS)).toBe("PROVIDER_RESPONSE_STALL")
    runtime.dispose()
  })

  test("#given two overlapping bash calls #when the first finishes #then the flag stays active until the last finishes", async () => {
    // given
    const { runtime, before, after } = createHarness()
    const startedAt = Date.now()
    await before(
      { tool: "bash", sessionID: CHILD_SESSION, callID: "call_bash_3a" },
      { args: { command: "echo first" } },
    )
    await before(
      { tool: "interactive_bash", sessionID: CHILD_SESSION, callID: "call_bash_3b" },
      { args: { tmux_command: "list-sessions" } },
    )

    // when
    await after(
      { tool: "bash", sessionID: CHILD_SESSION, callID: "call_bash_3a" },
      { title: "bash", output: "first", metadata: {} },
    )

    // then
    expect(stallModeAt(runtime, startedAt + LONG_PROCESS_PROBE_MS)).toBe("QUIET_BUT_ACTIVE")

    // when
    await after(
      { tool: "interactive_bash", sessionID: CHILD_SESSION, callID: "call_bash_3b" },
      { title: "interactive_bash", output: "", metadata: {} },
    )

    // then
    expect(stallModeAt(runtime, startedAt + LONG_PROCESS_PROBE_MS)).toBe("PROVIDER_RESPONSE_STALL")
    runtime.dispose()
  })

  test("#given a registered child #when tool.execute.before handles interactive_bash #then the long-process flag is active", async () => {
    // given
    const { runtime, before } = createHarness()
    const startedAt = Date.now()

    // when
    await before(
      { tool: "interactive_bash", sessionID: CHILD_SESSION, callID: "call_bash_4" },
      { args: { tmux_command: "list-sessions" } },
    )

    // then
    expect(stallModeAt(runtime, startedAt + LONG_PROCESS_PROBE_MS)).toBe("QUIET_BUT_ACTIVE")
    runtime.dispose()
  })

  test("#given a subagent child #when tool hooks run #then process and grunt signals target the emitting session", async () => {
    // given
    const calls: Array<{ method: string; sessionID: string }> = []
    const runtime = {
      watchdogProcessStart: (sessionID: string) => calls.push({ method: "process_start", sessionID }),
      watchdogProcessEnd: (sessionID: string) => calls.push({ method: "process_end", sessionID }),
      onToolActivity: (sessionID: string) => calls.push({ method: "tool_activity", sessionID }),
    }
    const before = createToolExecuteBeforeHandler({
      ctx: {} as never,
      hooks: {} as never,
      delegationFirstRuntime: runtime as never,
    })
    const after = createToolExecuteAfterHandler({
      ctx: {} as never,
      hooks: {} as never,
      delegationFirstRuntime: runtime as never,
    })
    subagentSessions.add(CHILD_SESSION)

    // when
    await before(
      { tool: "bash", sessionID: CHILD_SESSION, callID: "call_child" },
      { args: { command: "echo child" } },
    )
    await after(
      { tool: "bash", sessionID: CHILD_SESSION, callID: "call_child" },
      undefined,
    )
    await after(
      { tool: "read", sessionID: "ses_root", callID: "call_root" },
      undefined,
    )

    // then
    expect(calls).toEqual([
      { method: "process_start", sessionID: CHILD_SESSION },
      { method: "process_end", sessionID: CHILD_SESSION },
      { method: "tool_activity", sessionID: "ses_root" },
    ])
  })
})
