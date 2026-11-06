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
})
