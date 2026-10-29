/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"

import type { PluginInput } from "@opencode-ai/plugin"

import { subagentSessions } from "../claude-code-session-state"
import { createDelegationFirstRuntime } from "../delegation-first"
import { BackgroundManager } from "./manager"

async function waitForEvent(events: readonly string[], eventName: string): Promise<void> {
  const deadlineAt = Date.now() + 1_000
  while (!events.includes(eventName)) {
    if (Date.now() > deadlineAt) {
      throw new Error(`timed out waiting for ${eventName}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadlineAt = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() > deadlineAt) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function createClient(events: string[]): PluginInput["client"] {
  return {
    session: {
      get: async ({ path }: { path: { id: string } }) => ({
        data: { id: path.id, directory: tmpdir() },
      }),
      create: async () => {
        events.push("session.create")
        return { data: { id: "child-session" } }
      },
      promptAsync: async () => {
        events.push("promptAsync")
        return { data: {} }
      },
      abort: async () => ({}),
    },
  } as PluginInput["client"]
}

afterEach(() => {
  subagentSessions.clear()
})

describe("BackgroundManager session created callback", () => {
  test("fires onSessionCreated before the launch prompt is sent", async () => {
    //#given
    const events: string[] = []
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({
          data: { id: path.id, directory: tmpdir() },
        }),
        create: async () => {
          events.push("session.create")
          return { data: { id: "child-session" } }
        },
        promptAsync: async () => {
          events.push("promptAsync")
          return { data: {} }
        },
      },
    }
    const manager = new BackgroundManager({
      pluginContext: { client, directory: tmpdir() } as PluginInput,
    })

    //#when
    await manager.launch({
      description: "Create child",
      prompt: "Do work",
      agent: "general",
      parentSessionId: "parent-session",
      parentMessageId: "parent-message",
      onSessionCreated: (sessionId) => {
        events.push(`onSessionCreated:${sessionId}`)
      },
    })
    await waitForEvent(events, "promptAsync")

    //#then
    expect(events).toEqual([
      "session.create",
      "onSessionCreated:child-session",
      "promptAsync",
    ])

    manager.shutdown()
  })

  test("registers the child before awaiting onSessionCreated so early progress is retained", async () => {
    //#given
    const events: string[] = []
    const order: string[] = []
    const runtime = createDelegationFirstRuntime(undefined, {})
    let isSubagentDuringCallback = false
    let stageDuringCallback: string | undefined
    const manager = new BackgroundManager({
      pluginContext: { client: createClient(events), directory: tmpdir() } as PluginInput,
      delegationFirstRuntime: runtime,
      onSubagentSessionAttached: (event) => {
        order.push(`attach:${event.sessionID}`)
        runtime.attachChildSession(event.parentID, event.sessionID)
      },
      onSubagentRequestStarted: (sessionID) => {
        runtime.markRequestStarted(sessionID)
      },
    })

    //#when: the callback emits an early child progress event while it is awaited
    await manager.launch({
      description: "Create child",
      prompt: "Do work",
      agent: "general",
      parentSessionId: "parent-session",
      parentMessageId: "parent-message",
      onSessionCreated: (sessionId) => {
        order.push(`callback:${sessionId}`)
        isSubagentDuringCallback = subagentSessions.has(sessionId)
        runtime.watchdogActivity(sessionId, "progress")
        stageDuringCallback = runtime.checkWatchdog(sessionId).stage
      },
    })
    await waitForEvent(events, "promptAsync")

    //#then: registration happened first and the early event was not dropped
    expect(order).toEqual(["attach:child-session", "callback:child-session"])
    expect(isSubagentDuringCallback).toBe(true)
    expect(stageDuringCallback).toBe("first_response")
    expect(runtime.checkWatchdog("child-session").stage).toBe("first_response")

    manager.shutdown()
    runtime.dispose()
  })

  test("alive activity during onSessionCreated does not fabricate a provider response", async () => {
    //#given
    const events: string[] = []
    const runtime = createDelegationFirstRuntime(undefined, {})
    let stageDuringCallback: string | undefined
    const manager = new BackgroundManager({
      pluginContext: { client: createClient(events), directory: tmpdir() } as PluginInput,
      delegationFirstRuntime: runtime,
      onSubagentSessionAttached: (event) => {
        runtime.attachChildSession(event.parentID, event.sessionID)
      },
      onSubagentRequestStarted: (sessionID) => {
        runtime.markRequestStarted(sessionID)
      },
    })

    //#when: the callback only proves the session is alive
    await manager.launch({
      description: "Create child",
      prompt: "Do work",
      agent: "general",
      parentSessionId: "parent-session",
      parentMessageId: "parent-message",
      onSessionCreated: (sessionId) => {
        runtime.watchdogActivity(sessionId)
        stageDuringCallback = runtime.checkWatchdog(sessionId).stage
      },
    })
    await waitForEvent(events, "promptAsync")

    //#then: the lifecycle reaches request_started, never first_response
    expect(stageDuringCallback).toBe("session_created")
    expect(runtime.checkWatchdog("child-session").stage).toBe("request_started")

    manager.shutdown()
    runtime.dispose()
  })

  test("cleans up early registration when onSessionCreated throws", async () => {
    //#given
    const events: string[] = []
    const aborted: string[] = []
    const client = createClient(events)
    client.session.abort = async ({ path }: { path: { id: string } }) => {
      aborted.push(path.id)
      return {}
    }
    const manager = new BackgroundManager({
      pluginContext: { client, directory: tmpdir() } as PluginInput,
    })

    //#when
    await manager.launch({
      description: "Create child",
      prompt: "Do work",
      agent: "general",
      parentSessionId: "parent-session",
      parentMessageId: "parent-message",
      onSessionCreated: () => {
        throw new Error("callback failed")
      },
    })
    await waitFor(() => aborted.length > 0, "session abort after callback failure")

    //#then
    expect(aborted).toEqual(["child-session"])
    expect(subagentSessions.has("child-session")).toBe(false)

    manager.shutdown()
  })
})
