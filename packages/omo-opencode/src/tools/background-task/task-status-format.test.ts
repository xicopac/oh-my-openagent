import { describe, expect, test } from "bun:test"

import type { BackgroundTask } from "../../features/background-agent"
import { formatTaskStatus } from "./task-status-format"

describe("formatTaskStatus", () => {
  test("blocked status reports the actual terminal reason instead of claiming recovery exhaustion", () => {
    const task: BackgroundTask = {
      id: "bg-empty",
      parentSessionId: "ses-parent",
      parentMessageId: "msg-parent",
      description: "empty worker",
      prompt: "work",
      agent: "explore",
      status: "blocked",
      error: "BLOCKED: assistant turn completed with no output",
    }

    const output = formatTaskStatus(task)

    expect(output).toContain("assistant turn completed with no output")
    expect(output).not.toContain("Automatic recovery is exhausted")
  })

  test("blocked quota status exposes the structured provider error", () => {
    const task: BackgroundTask = {
      id: "bg-quota",
      parentSessionId: "ses-parent",
      parentMessageId: "msg-parent",
      description: "quota worker",
      prompt: "work",
      agent: "explore",
      status: "blocked",
      error: "BLOCKED: provider quota exhausted: Free usage exceeded, subscribe to Go",
      terminalReasonCode: "provider_quota_exhausted",
      providerError: {
        providerID: "openai",
        modelID: "gpt-fake-free",
        code: "insufficient_quota",
        message: "Free usage exceeded, subscribe to Go",
        statusCode: 429,
        retryable: false,
        quotaExhausted: true,
      },
    }

    const output = formatTaskStatus(task)

    expect(output).toContain("BLOCKED: provider quota exhausted")
    expect(output).toContain("Free usage exceeded, subscribe to Go")
    expect(output).toContain("openai/gpt-fake-free")
    expect(output).toContain("Retryable | false")
    expect(output).toContain("Quota exhausted | true")
  })
})
