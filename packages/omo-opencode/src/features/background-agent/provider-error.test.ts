import { describe, expect, test } from "bun:test"

import { buildProviderErrorSnapshot, formatProviderBlockedReason } from "./provider-error"
import type { BackgroundTask } from "./types"

function createTask(): BackgroundTask {
  return {
    id: "bg_quota",
    parentSessionId: "parent-session",
    parentMessageId: "parent-message",
    description: "quota worker",
    prompt: "work",
    agent: "general",
    status: "running",
    model: { providerID: "openai", modelID: "gpt-fake-free" },
  }
}

describe("provider error snapshots", () => {
  test("classifies the Garmin quota message as non-retryable quota exhaustion", () => {
    const snapshot = buildProviderErrorSnapshot(
      createTask(),
      { name: "APIError", message: "Free usage exceeded, subscribe to Go", statusCode: 429 },
      { name: "APIError", message: "Free usage exceeded, subscribe to Go", statusCode: 429 },
    )

    expect(snapshot).toMatchObject({
      providerID: "openai",
      modelID: "gpt-fake-free",
      name: "APIError",
      code: "insufficient_quota",
      message: "Free usage exceeded, subscribe to Go",
      statusCode: 429,
      retryable: false,
      quotaExhausted: true,
    })
  })

  test("formats an actionable blocked reason with the exact provider message", () => {
    const snapshot = buildProviderErrorSnapshot(
      createTask(),
      { name: "APIError", message: "Free usage exceeded, subscribe to Go", statusCode: 429 },
    )

    expect(snapshot).toBeDefined()
    const reason = formatProviderBlockedReason(snapshot!)

    expect(reason).toContain("BLOCKED: provider quota exhausted")
    expect(reason).toContain("Free usage exceeded, subscribe to Go")
    expect(reason).toContain("openai/gpt-fake-free")
    expect(reason).toContain("retryable=false")
    expect(reason).toContain("paid fallback requires explicit authorization")
  })

  test("does not classify a generic provider error as quota exhaustion", () => {
    const snapshot = buildProviderErrorSnapshot(
      createTask(),
      { name: "APIError", message: "Service temporarily unavailable", statusCode: 503 },
    )

    expect(snapshot).toMatchObject({
      message: "Service temporarily unavailable",
      retryable: true,
      quotaExhausted: false,
    })
  })
})
