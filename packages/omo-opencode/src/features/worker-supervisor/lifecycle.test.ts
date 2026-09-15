import { describe, expect, test } from "bun:test"
import {
  advanceStage,
  isTerminalStage,
  milestoneForStage,
  CHILD_MILESTONE_EVENTS,
} from "./lifecycle"
import type { ChildStage } from "./types"

describe("lifecycle stages and milestones", () => {
  test("maps every stage to its child_* milestone event", () => {
    // given
    const expectMap: Record<ChildStage, string> = {
      dispatch_authorized: "child_dispatch_authorized",
      session_created: "child_session_created",
      request_started: "child_model_request_started",
      first_response: "child_first_provider_response",
      completed: "child_completed",
      failed: "child_failed",
      cancelled: "child_cancelled",
    }
    // when / then
    for (const [stage, event] of Object.entries(expectMap) as Array<[ChildStage, string]>) {
      expect(milestoneForStage(stage)).toBe(event)
    }
  })

  test("advances monotonically forward and never backwards", () => {
    // given
    const forward: Array<[ChildStage | undefined, ChildStage]> = [
      [undefined, "dispatch_authorized"],
      ["dispatch_authorized", "session_created"],
      ["session_created", "request_started"],
      ["request_started", "first_response"],
      ["first_response", "completed"],
    ]
    // when / then
    for (const [cur, next] of forward) {
      expect(advanceStage(cur, next)).toBe(next)
    }
    // then: a backwards transition is rejected
    expect(advanceStage("request_started", "session_created")).toBe("request_started")
  })

  test("terminal stages are absorbing (a later terminal does not overwrite)", () => {
    // given
    expect(advanceStage("cancelled", "completed")).toBe("cancelled")
    expect(advanceStage("failed", "cancelled")).toBe("failed")
    expect(advanceStage("completed", "cancelled")).toBe("completed")
  })

  test("isTerminalStage recognizes only terminal stages", () => {
    expect(isTerminalStage("completed")).toBe(true)
    expect(isTerminalStage("failed")).toBe(true)
    expect(isTerminalStage("cancelled")).toBe(true)
    expect(isTerminalStage("request_started")).toBe(false)
    expect(isTerminalStage("first_response")).toBe(false)
  })

  test("CHILD_MILESTONE_EVENTS contains all eight milestone names", () => {
    expect(CHILD_MILESTONE_EVENTS).toEqual([
      "child_dispatch_authorized",
      "child_session_created",
      "child_model_request_started",
      "child_first_provider_response",
      "child_first_progress",
      "child_completed",
      "child_failed",
      "child_cancelled",
    ])
  })
})
