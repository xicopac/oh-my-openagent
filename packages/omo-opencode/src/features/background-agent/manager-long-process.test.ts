import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"

import type { PluginInput } from "@opencode-ai/plugin"

import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "../delegation-first"
import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import { resetLiveServerRouteForTesting } from "../../shared/live-server-route"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { BackgroundManager } from "./manager"
import { clearBackgroundTaskRegistryForTesting } from "./task-registry"

const ROOT_SESSION = "ses_root"
const PARENT_SESSION = "ses_parent"
const LONG_PROCESS_PROBE_MS = 200_000

type Harness = {
  runtime: DelegationFirstRuntime
  manager: BackgroundManager
}

function createHarness(): Harness {
  const runtime = createDelegationFirstRuntime(undefined, {})
  runtime.attachChildSession(ROOT_SESSION, PARENT_SESSION)
  runtime.markRequestStarted(PARENT_SESSION)

  const client = {
    session: {
      get: async () => ({ data: { id: PARENT_SESSION, directory: "/parent" } }),
      create: async () => ({ data: { id: `ses_bg_${crypto.randomUUID().slice(0, 8)}` } }),
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      messages: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      children: async () => ({ data: [] }),
    },
  }

  const manager = new BackgroundManager({
    pluginContext: unsafeTestValue<PluginInput>({ client, directory: tmpdir() }),
    enableParentSessionNotifications: false,
    delegationFirstRuntime: runtime,
  })

  return { runtime, manager }
}

function stallModeAt(runtime: DelegationFirstRuntime, nowMs: number): string | null {
  return runtime.checkWatchdog(PARENT_SESSION, nowMs).stallMode
}

function launchTask(manager: BackgroundManager, description: string) {
  return manager.launch({
    description,
    prompt: "do work",
    agent: "explore",
    parentSessionId: PARENT_SESSION,
    parentMessageId: "msg_parent",
  })
}

let harness: Harness | undefined

beforeEach(() => {
  releaseAllPromptAsyncReservationsForTesting()
  resetLiveServerRouteForTesting()
})

afterEach(async () => {
  await harness?.manager.shutdown()
  harness?.runtime.dispose()
  harness = undefined
  clearBackgroundTaskRegistryForTesting()
})

describe("delegation-first long-process lifecycle through background tasks", () => {
  test("#given a background task launched by a registered parent #when it is cancelled #then the long-process flag toggles off", async () => {
    // given
    harness = createHarness()
    const startedAt = Date.now()
    const task = await launchTask(harness.manager, "background work")

    // when
    await harness.manager.cancelTask(task.id)

    // then
    expect(stallModeAt(harness.runtime, startedAt + LONG_PROCESS_PROBE_MS)).toBe("PROVIDER_RESPONSE_STALL")
  })

  test("#given a launched background task #when the task is still active #then the parent long-process flag is active", async () => {
    // given
    harness = createHarness()
    const startedAt = Date.now()

    // when
    await launchTask(harness.manager, "background work")

    // then
    expect(stallModeAt(harness.runtime, startedAt + LONG_PROCESS_PROBE_MS)).toBe("QUIET_BUT_ACTIVE")
  })

  test("#given two background tasks from one parent #when only the first reaches terminal state #then the flag stays active until the last ends", async () => {
    // given
    harness = createHarness()
    const startedAt = Date.now()
    const first = await launchTask(harness.manager, "first background work")
    const second = await launchTask(harness.manager, "second background work")

    // when
    await harness.manager.cancelTask(first.id)

    // then
    expect(stallModeAt(harness.runtime, startedAt + LONG_PROCESS_PROBE_MS)).toBe("QUIET_BUT_ACTIVE")

    // when
    await harness.manager.cancelTask(second.id)

    // then
    expect(stallModeAt(harness.runtime, startedAt + LONG_PROCESS_PROBE_MS)).toBe("PROVIDER_RESPONSE_STALL")
  })
})
