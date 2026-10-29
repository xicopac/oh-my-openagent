import { afterEach, describe, expect, test } from "bun:test"
import { classifyTerminalQuotaOutcome, TERMINAL_QUOTA_OUTCOME } from "./terminal-quota-outcome"
import { createMessageUpdateHandler } from "./message-update-handler"
import { createSessionStatusHandler } from "./session-status-handler"
import { createAutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { subagentSessions } from "../../features/claude-code-session-state"
import { installRuntimeFallbackTestClock, restoreRuntimeFallbackTestClock } from "./test-timeout-clock.test-support"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"

const LONG_PROVIDER_RETRY_MS = 3_600_000

type ClientCalls = {
  readonly abort: string[]
  prompt: number
}

function createContext(calls: ClientCalls): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async ({ path }: { path: { id: string } }) => {
          calls.abort.push(path.id)
          return {}
        },
        messages: async () => ({ data: [] }),
        promptAsync: async () => {
          calls.prompt += 1
          return {}
        },
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test/dir",
  }
}

function createDeps(calls: ClientCalls, pluginConfig: Record<string, unknown> = {}): HookDeps {
  return {
    ctx: createContext(calls),
    config: {
      enabled: true,
      retry_on_errors: [402, 429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      notify_on_fallback: false,
      restore_primary_after_cooldown: false,
    },
    options: { session_timeout_ms: LONG_PROVIDER_RETRY_MS },
    pluginConfig: pluginConfig as never,
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
    internallyAbortedSessions: new Set(),
  }
}

const FALLBACK_CONFIG = {
  agents: {
    "sisyphus-junior": {
      model: "litellm/kimi-k3",
      fallback_models: ["litellm/gpt-5.6-sol"],
    },
  },
}

const QUOTA_ERROR = {
  name: "QuotaExceededError",
  message: "You exceeded your current quota. Please check your plan and billing details.",
}

const TERMINAL_QUOTA_ERROR = {
  name: "ProviderError",
  message: "Account locked",
  data: { detail: { error: { type: "terminal_quota_exhausted" } } },
}

afterEach(() => {
  restoreRuntimeFallbackTestClock()
  subagentSessions.clear()
})

describe("runtime fallback terminal quota outcome", () => {
  test("#given a quota error #when classified #then it is BLOCKED_QUOTA", () => {
    // given
    const error = QUOTA_ERROR

    // when
    const outcome = classifyTerminalQuotaOutcome(error)

    // then
    expect(outcome).toBe(TERMINAL_QUOTA_OUTCOME)
    expect(outcome).toBe("BLOCKED_QUOTA")
  })

  test("#given a provider terminal quota #when classified #then it is BLOCKED_QUOTA", () => {
    // given
    const error = TERMINAL_QUOTA_ERROR

    // when
    const outcome = classifyTerminalQuotaOutcome(error)

    // then
    expect(outcome).toBe("BLOCKED_QUOTA")
  })

  test("#given a user abort #when classified #then it is NOT BLOCKED_QUOTA", () => {
    // given
    const error = { name: "MessageAbortedError", message: "The user aborted this request." }

    // when
    const outcome = classifyTerminalQuotaOutcome(error)

    // then
    expect(outcome).toBeUndefined()
  })

  test("#given a subagent quota exhaustion with no fallback and a long retry timer #when the same event repeats #then BLOCKED_QUOTA cancels the timer and wakes the parent exactly once", async () => {
    // given
    const clock = installRuntimeFallbackTestClock()
    const sessionID = "ses_blocked_quota_subagent"
    const calls: ClientCalls = { abort: [], prompt: 0 }
    const deps = createDeps(calls)
    subagentSessions.add(sessionID)
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.5"))
    const helpers = createAutoRetryHelpers(deps)
    helpers.scheduleSessionFallbackTimeout(sessionID)
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(true)
    const handler = createMessageUpdateHandler(deps, helpers)
    const quotaEvent = {
      info: {
        sessionID,
        role: "assistant",
        model: "openai/gpt-5.5",
        status: "quota exceeded [retrying in ~2 weeks attempt #1]",
        error: QUOTA_ERROR,
      },
    }

    // when
    await handler(quotaEvent)
    await handler(quotaEvent)
    await clock.advanceBy(LONG_PROVIDER_RETRY_MS)

    // then
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
    expect(calls.abort).toEqual([sessionID])
    expect(calls.prompt).toBe(0)
  })

  test("#given a provider terminal quota with a fallback chain and a long retry timer #when the assistant error fires #then BLOCKED_QUOTA cancels the timer, aborts once, and dispatches no fallback", async () => {
    // given
    const clock = installRuntimeFallbackTestClock()
    const sessionID = "ses_blocked_quota_terminal"
    const calls: ClientCalls = { abort: [], prompt: 0 }
    const deps = createDeps(calls, FALLBACK_CONFIG)
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.5"))
    const helpers = createAutoRetryHelpers(deps)
    helpers.scheduleSessionFallbackTimeout(sessionID)
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(true)
    const handler = createMessageUpdateHandler(deps, helpers)

    // when
    await handler({
      info: {
        sessionID,
        role: "assistant",
        model: "openai/gpt-5.5",
        agent: "sisyphus-junior",
        status: "usage limit reached [retrying in 1h attempt #3]",
        error: TERMINAL_QUOTA_ERROR,
      },
    })

    // then
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
    expect(calls.abort).toEqual([sessionID])
    expect(calls.prompt).toBe(0)

    // when
    await clock.advanceBy(LONG_PROVIDER_RETRY_MS)

    // then
    expect(calls.abort).toEqual([sessionID])
    expect(calls.prompt).toBe(0)
  })

  test("#given a session already recorded as BLOCKED_QUOTA #when the provider emits another retry status #then no abort and no fallback dispatch happen", async () => {
    // given
    const sessionID = "ses_blocked_quota_status_repeat"
    const calls: ClientCalls = { abort: [], prompt: 0 }
    const deps = createDeps(calls, FALLBACK_CONFIG)
    deps.terminalQuotaSessions = new Set([sessionID])
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.5"))
    const helpers = createAutoRetryHelpers(deps)
    const handler = createSessionStatusHandler(deps, helpers, deps.sessionStatusRetryKeys)

    // when
    await handler({
      sessionID,
      agent: "sisyphus-junior",
      model: "openai/gpt-5.5",
      status: { type: "retry", message: "quota exceeded, retrying in 60s attempt #1" },
    })

    // then
    expect(calls.abort).toEqual([])
    expect(calls.prompt).toBe(0)
  })
})
