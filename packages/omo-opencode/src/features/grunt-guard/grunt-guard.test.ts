import { describe, expect, test } from "bun:test"
import { detectGruntWorkCycle } from "./detector"
import type { ToolActivityEvent } from "./detector"

const T0 = 1_000_000

function ev(tool: string, atMs: number): ToolActivityEvent {
  return { tool, atMs }
}

describe("grunt-guard detector", () => {
  test("flags a search/read burst within the window as grunt work", () => {
    // given a grep/read/read/grep/read cycle with no delegation
    const events = [
      ev("grep", T0),
      ev("read", T0 + 1_000),
      ev("read", T0 + 2_000),
      ev("grep", T0 + 3_000),
      ev("read", T0 + 4_000),
    ]

    // when the cycle is classified
    const verdict = detectGruntWorkCycle(events)

    // then it is grunt work with a reason and a count of 5
    expect(verdict.grunt).toBe(true)
    expect(verdict.gruntCount).toBe(5)
    expect(verdict.reason).toBe("5 search/read tool calls without delegation in window")
  })

  test("resets the counter when the root delegates via task", () => {
    // given the same burst interrupted by a task delegation
    const events = [
      ev("grep", T0),
      ev("read", T0 + 1_000),
      ev("read", T0 + 2_000),
      ev("task", T0 + 3_000),
      ev("grep", T0 + 4_000),
      ev("read", T0 + 5_000),
    ]

    // when the cycle is classified
    const verdict = detectGruntWorkCycle(events)

    // then the delegation reset the counter below the threshold
    expect(verdict.grunt).toBe(false)
    expect(verdict.reason).toBeNull()
    expect(verdict.gruntCount).toBe(2)
  })

  test("does not flag a burst below the threshold", () => {
    // given only two search/read calls
    const events = [ev("grep", T0), ev("read", T0 + 1_000)]

    // when the cycle is classified
    const verdict = detectGruntWorkCycle(events)

    // then it is not grunt work
    expect(verdict.grunt).toBe(false)
    expect(verdict.reason).toBeNull()
    expect(verdict.gruntCount).toBe(2)
  })

  test("returns a clean verdict for empty input", () => {
    // given no events
    const events: ToolActivityEvent[] = []

    // when the cycle is classified
    const verdict = detectGruntWorkCycle(events)

    // then it is not grunt work with a zero count
    expect(verdict).toEqual({ grunt: false, reason: null, gruntCount: 0 })
  })

  test("ignores events older than the window", () => {
    // given a search/read burst that happened before the window
    const events = [
      ev("grep", T0),
      ev("read", T0 + 1_000),
      ev("read", T0 + 2_000),
      ev("grep", T0 + 3_000),
      ev("read", T0 + 4_000),
      ev("read", T0 + 200_000),
    ]

    // when the cycle is classified with a 120s window
    const verdict = detectGruntWorkCycle(events)

    // then the stale burst does not count, only the single trailing read
    expect(verdict.grunt).toBe(false)
    expect(verdict.gruntCount).toBe(1)
  })

  test("does not count non-grunt tools toward the counter", () => {
    // given bash/write/edit activity mixed with a couple of reads
    const events = [
      ev("bash", T0),
      ev("write", T0 + 1_000),
      ev("edit", T0 + 2_000),
      ev("read", T0 + 3_000),
      ev("read", T0 + 4_000),
    ]

    // when the cycle is classified
    const verdict = detectGruntWorkCycle(events)

    // then only the two reads count, below the threshold
    expect(verdict.grunt).toBe(false)
    expect(verdict.gruntCount).toBe(2)
  })
})
