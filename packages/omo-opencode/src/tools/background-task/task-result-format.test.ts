import { describe, expect, test } from "bun:test"

import type { BackgroundTask } from "../../features/background-agent"
import type { BackgroundOutputClient } from "./clients"
import { formatTaskResult } from "./task-result-format"

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    sessionId: "ses-1",
    parentSessionId: "main-1",
    parentMessageId: "msg-1",
    description: "background task",
    prompt: "do work",
    agent: "test-agent",
    status: "completed",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:05.000Z"),
    ...overrides,
  }
}

describe("formatTaskResult", () => {
  test("returns assistant session errors instead of masking them as success text", async () => {
    const task = createTask()
    const client: BackgroundOutputClient = {
      session: {
        messages: async () => ({
          data: [
            {
              info: {
                role: "assistant",
                time: { created: 1 },
                error: { data: { message: "Forbidden: Selected provider is forbidden" } },
              },
              parts: [],
            },
          ],
        }),
      },
    }

    const output = await formatTaskResult(task, client)

    expect(output).toContain("Session error")
    expect(output).toContain("Forbidden: Selected provider is forbidden")
  })

  test("returns the durable blocked reason after the terminal worker session is gone", async () => {
    let messageReads = 0
    const task = createTask({
      status: "blocked",
      error: "BLOCKED: assistant turn completed with no output",
    })
    const client: BackgroundOutputClient = {
      session: {
        messages: async () => {
          messageReads += 1
          throw new Error("session deleted")
        },
      },
    }

    const output = await formatTaskResult(task, client)

    expect(output).toContain("Task ID: task-1")
    expect(output).toContain("BLOCKED: assistant turn completed with no output")
    expect(output).not.toContain("Error fetching messages")
    expect(messageReads).toBe(0)
  })

  test("returns durable provider quota details after the worker session is gone", async () => {
    const task = createTask({
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
    })
    const client: BackgroundOutputClient = {
      session: {
        messages: async () => {
          throw new Error("session deleted")
        },
      },
    }

    const output = await formatTaskResult(task, client)

    expect(output).toContain("BLOCKED: provider quota exhausted")
    expect(output).toContain("Provider Error:")
    expect(output).toContain("openai/gpt-fake-free")
    expect(output).toContain("Retryable: false")
    expect(output).toContain("Quota exhausted: true")
  })
})
