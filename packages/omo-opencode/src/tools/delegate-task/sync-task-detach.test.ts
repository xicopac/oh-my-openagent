import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createDelegationFirstRuntime,
  type DelegationFirstRuntime,
} from "../../features/delegation-first/runtime"
import { executeSyncTask } from "./sync-task"

const tempDirs: string[] = []

function tempAvailabilityFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-task-detach-availability-"))
  tempDirs.push(dir)
  return join(dir, "model-availability.json")
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const args = {
  prompt: "test prompt",
  description: "test task",
  category: "quick",
  load_skills: [],
  run_in_background: false,
  command: null,
}

function toolContext() {
  return {
    sessionID: "parent-session",
    callID: "call-123",
    metadata: () => {},
  }
}

function attachViaLifecycle(runtime: DelegationFirstRuntime, attached: string[]) {
  return async (event: { sessionID: string; parentID: string; title: string }) => {
    attached.push(event.sessionID)
    runtime.attachChildSession(event.parentID, event.sessionID)
  }
}

describe("executeSyncTask - watchdog registration pairing", () => {
  test("detaches the sync child from the delegation-first runtime on completion", async () => {
    // given: a runtime that registers sync children exactly like the plugin callback
    const runtime = createDelegationFirstRuntime(undefined, {
      modelAvailabilityFilePath: tempAvailabilityFile(),
    })
    const attached: string[] = []
    const executorCtx = {
      client: {},
      directory: "/tmp",
      delegationFirstRuntime: runtime,
      onSyncSessionCreated: attachViaLifecycle(runtime, attached),
    }
    const deps = {
      createSyncSession: async () => ({ ok: true as const, sessionID: "ses_sync_detach_1" }),
      sendSyncPrompt: async () => null,
      pollSyncSession: async () => null,
      fetchSyncResult: async () => ({ ok: true as const, textContent: "sync result" }),
    }

    try {
      // when: the sync task completes
      const result = await executeSyncTask(
        args,
        toolContext(),
        executorCtx,
        { sessionID: "parent-session" },
        "test-agent",
        undefined,
        undefined,
        undefined,
        undefined,
        deps,
      )

      // then: attach and detach are paired, so no registration is leaked
      expect(result).toContain("sync result")
      expect(attached).toEqual(["ses_sync_detach_1"])
      expect(runtime.sessions()).toEqual([])
      expect(runtime.liveChildCount("parent-session")).toBe(0)
    } finally {
      runtime.dispose()
    }
  })

  test("detaches an abandoned retry session with a failed terminal stage", async () => {
    // given: a first session that fails over to a second session
    const runtime = createDelegationFirstRuntime(undefined, {
      modelAvailabilityFilePath: tempAvailabilityFile(),
    })
    const attached: string[] = []
    const executorCtx = {
      client: {},
      directory: "/tmp",
      delegationFirstRuntime: runtime,
      onSyncSessionCreated: attachViaLifecycle(runtime, attached),
    }
    let created = 0
    const deps = {
      createSyncSession: async () => {
        created += 1
        return { ok: true as const, sessionID: created === 1 ? "ses_retry_first" : "ses_retry_second" }
      },
      sendSyncPrompt: async () => null,
      pollSyncSession: async (_ctx: unknown, _client: unknown, input: { sessionID: string }) =>
        input.sessionID === "ses_retry_first" ? "Forbidden: Selected provider is forbidden" : null,
      fetchSyncResult: async (_client: unknown, sessionID: string) => ({
        ok: true as const,
        textContent: `Result from ${sessionID}`,
      }),
    }
    const fallbackChain = [
      { providers: ["genai-proxy-openai"], model: "gpt-5.6-luna-fast" },
      { providers: ["genai-proxy-aws"], model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
    ]

    try {
      // when: the retry replaces the abandoned first session
      const result = await executeSyncTask(
        args,
        toolContext(),
        executorCtx,
        { sessionID: "parent-session" },
        "sisyphus-junior",
        { providerID: "genai-proxy-openai", modelID: "gpt-5.6-luna-fast", variant: undefined },
        undefined,
        undefined,
        fallbackChain,
        deps,
      )

      // then: both sessions were attached, but neither registration leaked
      expect(result).toContain("Result from ses_retry_second")
      expect(attached).toEqual(["ses_retry_first", "ses_retry_second"])
      expect(runtime.sessions()).toEqual([])
    } finally {
      runtime.dispose()
    }
  })
})
