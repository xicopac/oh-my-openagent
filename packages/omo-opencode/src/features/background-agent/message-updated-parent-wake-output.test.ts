import { describe, expect, test } from "bun:test"

import {
  messageUpdatedInfoHasParentWakeOutput,
  parentWakeOutputIsCausallyNewer,
} from "./message-updated-parent-wake-output"
import type { PendingParentWake } from "./parent-wake-dedupe"

function wake(): PendingParentWake {
  return {
    promptContext: {},
    notifications: ["terminal worker"],
    shouldReply: true,
    preDispatchAssistantMessageID: "msg_existing",
  }
}

describe("parent wake causal output", () => {
  test("pre-existing assistant activity cannot acknowledge a newly dispatched wake", () => {
    const pending = wake()

    expect(parentWakeOutputIsCausallyNewer("msg_existing", pending)).toBe(false)
    expect(messageUpdatedInfoHasParentWakeOutput({
      id: "msg_existing",
      tokens: { output: 10, reasoning: 0 },
    }, "assistant", pending)).toBe(false)
  })

  test("a causally newer assistant message with real output can acknowledge the wake", () => {
    const pending = wake()

    expect(messageUpdatedInfoHasParentWakeOutput({
      id: "msg_after_wake",
      tokens: { output: 10, reasoning: 0 },
    }, "assistant", pending)).toBe(true)
  })

  test("a created but empty assistant shell cannot acknowledge the wake", () => {
    expect(messageUpdatedInfoHasParentWakeOutput({
      id: "msg_after_wake",
      finish: "stop",
      tokens: { input: 10, output: 0, reasoning: 0 },
    }, "assistant", wake())).toBe(false)
  })
})
