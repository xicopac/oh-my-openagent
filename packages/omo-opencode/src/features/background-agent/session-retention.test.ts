import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"

import type { PluginInput } from "@opencode-ai/plugin"

import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

type FakeTimers = {
  runAll: () => Promise<void>
  restore: () => void
}

function installFakeTimers(): FakeTimers {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void | Promise<void>>()

  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0]): ReturnType<typeof setTimeout> => {
    if (typeof handler !== "function") {
      throw new Error("Expected a function timeout handler")
    }
    const token = originalSetTimeout(() => {}, 60_000)
    originalClearTimeout(token)
    callbacks.set(token, handler as () => void | Promise<void>)
    return token
  }) as typeof setTimeout

  globalThis.clearTimeout = ((token: ReturnType<typeof setTimeout>): void => {
    callbacks.delete(token)
  }) as typeof clearTimeout

  return {
    async runAll() {
      for (const [token, callback] of [...callbacks.entries()]) {
        callbacks.delete(token)
        await callback()
      }
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}

function createTask(status: BackgroundTask["status"], sessionID: string): BackgroundTask {
  return {
    id: `bg_${status}`,
    status,
    queuedAt: new Date("2026-10-26T00:00:00.000Z"),
    startedAt: new Date("2026-10-26T00:00:01.000Z"),
    completedAt: new Date("2026-10-26T00:00:02.000Z"),
    description: `${status} worker`,
    prompt: "do work",
    agent: "explore",
    parentSessionId: "ses_parent",
    parentMessageId: "msg_parent",
    sessionId: sessionID,
  }
}

let managerUnderTest: BackgroundManager | undefined
let timersUnderTest: FakeTimers | undefined

afterEach(() => {
  managerUnderTest?.shutdown()
  timersUnderTest?.restore()
  managerUnderTest = undefined
  timersUnderTest = undefined
})

function getTasks(manager: BackgroundManager): Map<string, BackgroundTask> {
  return Reflect.get(manager, "tasks") as Map<string, BackgroundTask>
}

function scheduleTaskRemoval(manager: BackgroundManager, taskID: string): void {
  const schedule = Reflect.get(manager, "scheduleTaskRemoval") as (id: string) => void
  schedule.call(manager, taskID)
}

function createManager(deletedSessions: string[]): BackgroundManager {
  const client = {
    session: {
      delete: async ({ path }: { path: { id: string } }) => {
        deletedSessions.push(path.id)
        return {}
      },
      messages: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      abort: async () => ({}),
    },
  }
  return new BackgroundManager({
    pluginContext: { client, directory: tmpdir() } as unknown as PluginInput,
    config: { taskCleanupDelayMs: 60_000 },
    enableParentSessionNotifications: false,
  })
}

describe("terminal subagent session retention", () => {
  test("#given a cancelled worker #when terminal cleanup runs #then its session record is retained", async () => {
    // given
    timersUnderTest = installFakeTimers()
    const deletedSessions: string[] = []
    const manager = createManager(deletedSessions)
    managerUnderTest = manager
    const task = createTask("cancelled", "ses_cancelled_worker")
    getTasks(manager).set(task.id, task)

    // when
    scheduleTaskRemoval(manager, task.id)
    await timersUnderTest.runAll()

    // then
    expect(deletedSessions).toEqual([])
  })

  test("#given a failed worker #when terminal cleanup runs #then its session record is retained", async () => {
    // given
    timersUnderTest = installFakeTimers()
    const deletedSessions: string[] = []
    const manager = createManager(deletedSessions)
    managerUnderTest = manager
    const task = createTask("error", "ses_failed_worker")
    getTasks(manager).set(task.id, task)

    // when
    scheduleTaskRemoval(manager, task.id)
    await timersUnderTest.runAll()

    // then
    expect(deletedSessions).toEqual([])
  })

  test("#given a completed worker #when terminal cleanup runs #then the disposable session is deleted", async () => {
    // given
    timersUnderTest = installFakeTimers()
    const deletedSessions: string[] = []
    const manager = createManager(deletedSessions)
    managerUnderTest = manager
    const task = createTask("completed", "ses_completed_worker")
    getTasks(manager).set(task.id, task)

    // when
    scheduleTaskRemoval(manager, task.id)
    await timersUnderTest.runAll()

    // then
    expect(deletedSessions).toEqual(["ses_completed_worker"])
  })
})
