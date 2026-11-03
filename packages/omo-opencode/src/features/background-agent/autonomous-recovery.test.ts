import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"

import { createDelegationFirstRuntime } from "../delegation-first/runtime"
import { createRootWorkerState } from "../delegation-first/root-worker-state"
import { createRecoveryCoordinator } from "../worker-supervisor"
import { createWatchdog } from "../worker-supervisor/watchdog"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import { BackgroundManager } from "./manager"
import { createWorkerRecordStore, type WorkerRecord, type WorkerRecordStore } from "./worker-record"
import type { BackgroundTask } from "./types"

const managers: BackgroundManager[] = []
const stores: WorkerRecordStore[] = []
const tempDirs: string[] = []

afterEach(async () => {
  while (managers.length > 0) {
    await managers.pop()?.shutdown()
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
  stores.length = 0
  releaseAllPromptAsyncReservationsForTesting()
})

type FakeClient = {
  client: PluginInput["client"]
  promptAsyncCalls: Array<{ body?: Record<string, unknown> }>
  abortedSessions: string[]
}

function createFakeClient(options: {
  status?: Record<string, { type: string }>
  messages?: Record<string, unknown[]>
  messagesError?: Error
} = {}): FakeClient {
  const promptAsyncCalls: Array<{ body?: Record<string, unknown> }> = []
  const abortedSessions: string[] = []
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_child" } }),
      get: async () => ({ data: { directory: tmpdir() } }),
      messages: async ({ path }: { path: { id: string } }) => {
        if (options.messagesError) throw options.messagesError
        return { data: options.messages?.[path.id] ?? [] }
      },
      status: async () => ({ data: options.status ?? {} }),
      promptAsync: async (input: { body?: Record<string, unknown> }) => {
        promptAsyncCalls.push(input)
        return { data: {} }
      },
      abort: async ({ path }: { path: { id: string } }) => {
        abortedSessions.push(path.id)
        return { data: true }
      },
      delete: async () => ({}),
    },
  } as unknown as PluginInput["client"]
  return { client, promptAsyncCalls, abortedSessions }
}

function createManager(client: PluginInput["client"], store?: WorkerRecordStore): BackgroundManager {
  const dir = mkdtempSync(join(tmpdir(), "omo-worker-recovery-"))
  tempDirs.push(dir)
  const manager = new BackgroundManager({
    pluginContext: {
      client,
      directory: dir,
    } as unknown as PluginInput,
    workerRecordStore: store ?? createStore(),
    enableParentSessionNotifications: true,
    config: { taskCleanupDelayMs: 60_000 },
  })
  managers.push(manager)
  return manager
}

function createStore(): WorkerRecordStore {
  const dir = mkdtempSync(join(tmpdir(), "omo-worker-records-"))
  tempDirs.push(dir)
  const store = createWorkerRecordStore({ rootDir: dir })
  stores.push(store)
  return store
}

function task(overrides: Partial<BackgroundTask> & { id: string; parentSessionId: string }): BackgroundTask {
  return {
    id: overrides.id,
    ...(overrides.sessionId ? { sessionId: overrides.sessionId } : {}),
    parentSessionId: overrides.parentSessionId,
    parentMessageId: overrides.parentMessageId ?? "msg_parent",
    description: overrides.description ?? "worker",
    prompt: overrides.prompt ?? "do work",
    agent: overrides.agent ?? "explore",
    status: overrides.status ?? "running",
    startedAt: overrides.startedAt ?? new Date(Date.now() - 120_000),
    ...(overrides.progress ? { progress: overrides.progress } : { progress: { toolCalls: 1, lastUpdate: new Date(Date.now() - 120_000) } }),
    ...(overrides.model ? { model: overrides.model } : {}),
  }
}

function addTask(manager: BackgroundManager, value: BackgroundTask): void {
  const add = Reflect.get(manager, "addTask") as (task: BackgroundTask) => void
  add.call(manager, value)
}

function pendingWakes(manager: BackgroundManager): Map<string, { notifications: string[]; shouldReply: boolean; workerIDs?: string[] }> {
  const notifier = Reflect.get(manager, "parentWakeNotifier") as {
    getPendingParentWakes: () => Map<string, { notifications: string[]; shouldReply: boolean; workerIDs?: string[] }>
  }
  return notifier.getPendingParentWakes()
}

async function flushWake(manager: BackgroundManager, parentSessionID: string): Promise<void> {
  const flush = Reflect.get(manager, "flushPendingParentWake") as (sessionID: string) => Promise<void>
  await flush.call(manager, parentSessionID)
}

describe("autonomous worker lifecycle", () => {
  test("#given a worker completes #when the terminal path runs #then the result is persisted and the idle parent is woken once", async () => {
    // given
    const fake = createFakeClient({
      messages: {
        ses_child: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "worker answer" }] }],
      },
    })
    const store = createStore()
    const manager = createManager(fake.client, store)
    const value = task({ id: "bg_done", parentSessionId: "ses_parent", sessionId: "ses_child" })
    addTask(manager, value)

    // when
    const complete = Reflect.get(manager, "tryCompleteTask") as (task: BackgroundTask, source: string) => Promise<boolean>
    await complete.call(manager, value, "test completion")
    await flushWake(manager, "ses_parent")

    // then
    expect(value.status).toBe("completed")
    expect(value.result).toBe("worker answer")
    const record = store.get("bg_done")
    expect(record?.terminalOutcome).toBe("completed")
    expect(record?.result).toBe("worker answer")
    expect(record?.wakeState).toBe("dispatched")
    expect(record?.wakeDispatchedAt).toBeDefined()
    expect(record?.notificationDeliveredAt).toBeUndefined()
    expect(fake.promptAsyncCalls).toHaveLength(1)
    const body = fake.promptAsyncCalls[0]?.body as { noReply?: boolean; parts?: Array<{ text?: string }> } | undefined
    expect(body?.noReply).toBe(false)
    expect(body?.parts?.[0]?.text).toContain("[BACKGROUND TASK COMPLETED]")

    manager.handleEvent({
      type: "message.updated",
      properties: { sessionID: "ses_parent", info: { sessionID: "ses_parent", role: "assistant", finish: "stop" } },
    })
    expect(store.get("bg_done")?.wakeState).toBe("acknowledged")
    expect(store.get("bg_done")?.wakeAcknowledgedAt).toBeDefined()
  })

  test("#given a completed worker #when child teardown starts #then result and pending outbox already exist on disk", async () => {
    const fake = createFakeClient({
      messages: {
        ses_child: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "answer before teardown" }] }],
      },
    })
    const store = createStore()
    let recordAtAbort: WorkerRecord | undefined
    ;(fake.client.session as unknown as { abort: (input: { path: { id: string } }) => Promise<unknown> }).abort = async () => {
      recordAtAbort = store.get("bg_ordered")
      return { data: true }
    }
    const manager = createManager(fake.client, store)
    const value = task({ id: "bg_ordered", parentSessionId: "ses_parent", sessionId: "ses_child" })
    addTask(manager, value)

    const complete = Reflect.get(manager, "tryCompleteTask") as (task: BackgroundTask, source: string) => Promise<boolean>
    await complete.call(manager, value, "ordering proof")

    expect(recordAtAbort).toMatchObject({
      terminalOutcome: "completed",
      result: "answer before teardown",
      wakeState: "pending",
    })
  })

  test("#given cancellation abort fails for a live child #when completion later wins #then no provisional terminal record blocks the truthful outcome", async () => {
    const fake = createFakeClient({
      messages: {
        ses_child: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "eventual answer" }] }],
      },
    })
    ;(fake.client.session as unknown as { abort: () => Promise<unknown> }).abort = async () => ({
      error: { message: "session still active" },
    })
    const store = createStore()
    const manager = createManager(fake.client, store)
    const value = task({ id: "bg_abort_failed", parentSessionId: "ses_parent", sessionId: "ses_child" })
    addTask(manager, value)

    expect(await manager.cancelTask(value.id, { source: "test", skipNotification: true })).toBe(false)
    expect(value.status).toBe("running")
    expect(store.get(value.id)?.terminalAt).toBeUndefined()

    const complete = Reflect.get(manager, "tryCompleteTask") as (task: BackgroundTask, source: string) => Promise<boolean>
    expect(await complete.call(manager, value, "completion after failed cancellation")).toBe(true)
    expect(store.get(value.id)).toMatchObject({
      terminalOutcome: "completed",
      result: "eventual answer",
      wakeState: "pending",
    })
  })

  test("#given pending or unacknowledged dispatched outbox #when manager restarts #then replay continues until parent output acknowledges it", async () => {
    const fake = createFakeClient()
    const store = createStore()
    store.save({
      schemaVersion: 1,
      workerID: "bg_restart",
      sessionID: "ses_deleted",
      parentSessionID: "ses_parent",
      parentMessageID: "msg_parent",
      agent: "explore",
      description: "restart worker",
      state: "running",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
    })
    store.terminalize("bg_restart", {
      state: "completed",
      terminalOutcome: "completed",
      terminalAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      terminalAttemptID: "att_restart",
      result: "restart answer",
    })

    const first = createManager(fake.client, store)
    const recoverFirst = Reflect.get(first, "recoverTerminalWorkerRecords") as () => Promise<void>
    await recoverFirst.call(first)
    expect(pendingWakes(first).get("ses_parent")?.workerIDs).toEqual(["bg_restart"])
    await flushWake(first, "ses_parent")
    expect(store.get("bg_restart")?.wakeState).toBe("dispatched")

    await first.shutdown()
    releaseAllPromptAsyncReservationsForTesting()
    const second = createManager(fake.client, store)
    const recoverSecond = Reflect.get(second, "recoverTerminalWorkerRecords") as () => Promise<void>
    await recoverSecond.call(second)
    expect(pendingWakes(second).get("ses_parent")?.workerIDs).toEqual(["bg_restart"])
    await flushWake(second, "ses_parent")
    second.handleEvent({
      type: "message.updated",
      properties: { sessionID: "ses_parent", info: { sessionID: "ses_parent", role: "assistant", finish: "stop" } },
    })
    expect(store.get("bg_restart")?.wakeState).toBe("acknowledged")

    await second.shutdown()
    releaseAllPromptAsyncReservationsForTesting()
    const third = createManager(fake.client, store)
    const recoverThird = Reflect.get(third, "recoverTerminalWorkerRecords") as () => Promise<void>
    await recoverThird.call(third)
    expect(pendingWakes(third).has("ses_parent")).toBe(false)
  })

  test("#given a busy worker ends on an empty assistant turn #when the poller checks it #then the task becomes BLOCKED and the parent is notified", async () => {
    // given
    const fake = createFakeClient({
      status: { ses_child: { type: "busy" } },
      messages: {
        ses_child: [{ info: { role: "assistant", finish: "stop", tokens: { input: 10, output: 0, reasoning: 0 } }, parts: [] }],
      },
    })
    const store = createStore()
    const manager = createManager(fake.client, store)
    const value = task({ id: "bg_empty", parentSessionId: "ses_parent", sessionId: "ses_child" })
    addTask(manager, value)

    // when
    const poll = Reflect.get(manager, "pollRunningTasks") as () => Promise<void>
    await poll.call(manager)
    await new Promise((resolve) => setTimeout(resolve, 20))

    // then
    expect(value.status).toBe("blocked")
    expect(value.error).toContain("BLOCKED")
    expect(store.get("bg_empty")?.terminalOutcome).toBe("blocked")
    const notification = pendingWakes(manager).get("ses_parent")?.notifications.join("\n") ?? ""
    expect(notification).toContain("BLOCKED")
    expect(notification).toContain("ALL BACKGROUND TASKS FINISHED")
  })

  test("#given a worker session disappears without a terminal result #when session.deleted is handled #then the task is BLOCKED and the parent is woken", async () => {
    // given
    const fake = createFakeClient()
    const store = createStore()
    const manager = createManager(fake.client, store)
    const value = task({ id: "bg_vanished", parentSessionId: "ses_parent", sessionId: "ses_child" })
    addTask(manager, value)

    // when
    await manager.handleEvent({ type: "session.deleted", properties: { sessionID: "ses_child" } })
    await new Promise((resolve) => setTimeout(resolve, 25))

    // then
    expect(value.status).toBe("blocked")
    expect(store.get("bg_vanished")?.terminalOutcome).toBe("blocked")
    expect(pendingWakes(manager).get("ses_parent")?.shouldReply).toBe(true)
  })

  test("#given a completed worker session is deleted #when the result is requested later #then the durable terminal result is returned", async () => {
    // given
    const fake = createFakeClient({ messagesError: new Error("session deleted") })
    const store = createStore()
    const manager = createManager(fake.client, store)
    store.save({
      schemaVersion: 1,
      workerID: "bg_retained",
      sessionID: "ses_deleted",
      parentSessionID: "ses_parent",
      agent: "explore",
      description: "retained worker",
      state: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      terminalAt: new Date().toISOString(),
      terminalOutcome: "completed",
      result: "retained answer",
    })

    // when
    const recovered = manager.getTask("bg_retained")
    const format = await import("../../tools/background-task/task-result-format")
    const output = recovered ? await format.formatTaskResult(recovered, fake.client) : ""

    // then
    expect(recovered?.status).toBe("completed")
    expect(recovered?.result).toBe("retained answer")
    expect(output).toContain("retained answer")
  })

  test("#given a provider request stops responding #when the watchdog checks past the response deadline #then it reports a provider response stall", () => {
    // given
    let now = 1_000
    const watchdog = createWatchdog({}, { now: () => now })
    watchdog.register("ses_child", "ses_child", "session_created")
    watchdog.markRequestStarted("ses_child")

    // when
    now += 181_000
    const result = watchdog.check("ses_child", now)

    // then
    expect(result.stallMode).toBe("PROVIDER_RESPONSE_STALL")
    expect(result.timedOut).toBe(true)
  })

  test("#given a long-running tool keeps reporting liveness #when the watchdog checks #then it does not reclaim before the wedged deadline", () => {
    // given
    let now = 1_000
    const watchdog = createWatchdog({}, { now: () => now })
    watchdog.register("ses_child", "ses_child", "session_created")
    watchdog.markRequestStarted("ses_child")
    watchdog.onActivity("ses_child", "progress")
    watchdog.onProcessStart("ses_child")

    // when
    now += 200_000
    const healthy = watchdog.check("ses_child", now)
    now += 200_000
    const wedged = watchdog.check("ses_child", now)

    // then
    expect(healthy.stallMode).toBe("QUIET_BUT_ACTIVE")
    expect(healthy.timedOut).toBe(false)
    expect(wedged.stallMode).toBe("TOOL_STALL")
    expect(wedged.timedOut).toBe(true)
  })

  test("#given duplicate terminal notifications #when the parent wake is queued twice #then exactly one actionable wake is retained", async () => {
    // given
    const fake = createFakeClient()
    const manager = createManager(fake.client, createStore())

    // when
    await manager.notifyWorkerBlocked({ sessionID: "ses_orphan", parentSessionID: "ses_parent", reason: "stalled" })
    await manager.notifyWorkerBlocked({ sessionID: "ses_orphan", parentSessionID: "ses_parent", reason: "stalled" })

    // then
    const wake = pendingWakes(manager).get("ses_parent")
    expect(wake?.notifications).toHaveLength(1)
    expect(wake?.shouldReply).toBe(true)
  })

  test("#given a retryable stall #when the recovery coordinator evaluates twice #then the retry budget allows exactly one retry", () => {
    // given
    const coordinator = createRecoveryCoordinator({ sameWorkerMaxReclaims: 1 })

    // when
    const first = coordinator.evaluate("episode", "openai/free", "EXECUTION_STALL", true)
    coordinator.recordReclaim("episode", "openai/free")
    const second = coordinator.evaluate("episode", "openai/free", "EXECUTION_STALL", true)

    // then
    expect(first.kind).toBe("reclaim")
    expect(first.kind === "reclaim" ? first.retry : false).toBe(true)
    expect(second.kind).toBe("reclaim")
    expect(second.kind === "reclaim" ? second.retry : true).toBe(false)
  })

  test("#given recovery exhausted into HOLD #when the root requests diagnostics and dispatch #then diagnostics are allowed and new dispatch is blocked", () => {
    // given
    const state = createRootWorkerState()
    const sessionID = "ses_root"
    state.recordDelegationFailure(sessionID, { id: "f1", kind: "child_lost", reason: "lost", observedAtMs: Date.now() })
    state.recordDelegationFailure(sessionID, { id: "f2", kind: "child_lost", reason: "lost", observedAtMs: Date.now() })
    state.beginRecoveryProbe(sessionID, "p1", "n1")
    state.recordRecoveryProbeFailure(sessionID, "p1", "failed")
    state.beginRecoveryProbe(sessionID, "p2", "n2")
    state.recordRecoveryProbeFailure(sessionID, "p2", "failed")

    // when
    const read = state.decide(sessionID, "read", { target: "README.md" })
    const output = state.decide(sessionID, "background_output", {})
    const dispatch = state.decide(sessionID, "task", { target: "delegate" })

    // then
    expect(state.phase(sessionID)).toBe("halt")
    expect(read.block).toBe(false)
    expect(output.block).toBe(false)
    expect(dispatch.block).toBe(true)
  })

  test("#given a runtime with a retained assignment #when a timed-out stall is reclaimed #then the governed relaunch path is used once", () => {
    // given
    const now = Date.now()
    const runtime = createDelegationFirstRuntime(undefined, { recovery: { sameWorkerMaxReclaims: 1 } })
    const cancels: string[] = []
    const relaunches: string[] = []
    runtime.setRecoverySink({
      cancel: (sessionID) => { cancels.push(sessionID) },
      relaunch: (assignment, action) => {
        relaunches.push(action.worker.model_id)
        return { kind: "launched", taskID: `bg_retry_${relaunches.length}`, sessionID: `ses_retry_${relaunches.length}` }
      },
    })
    runtime.retainAssignment({
      assignment_id: "asg_1",
      root_session_id: "ses_root",
      parent_session_id: "ses_parent",
      parent_message_id: "msg_parent",
      prompt: "do work",
      agent: "explore",
      workers: [
        { model_id: "openai/free-a", provider_id: "openai", cost: 0, tier: "free", capabilities: {} },
        { model_id: "openai/free-b", provider_id: "openai", cost: 0, tier: "free", capabilities: {} },
      ],
    } as never, "ses_child")
    runtime.attachChildSession("ses_parent", "ses_child")
    runtime.markRequestStarted("ses_child")
    runtime.watchdogActivity("ses_child", "provider_response")
    runtime.watchdogActivity("ses_child", "progress")
    runtime.watchdogActivity("ses_child", "progress")

    // when
    runtime.reclaimStalled("ses_child", "openai/free-a", now + 200_000)

    // then
    expect(cancels).toEqual(["ses_child"])
    expect(relaunches).toHaveLength(1)
  })
})
