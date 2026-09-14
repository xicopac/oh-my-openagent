import { describe, expect, test } from "bun:test"

import { checkDuplicate, type WorkerTrace } from "./duplicate"

describe("duplicate", () => {
  // #14 spec: duplicate worker is prevented/reused where appropriate
  test("identifies an essentially identical active question", () => {
    // given an active worker investigating the same thing
    const workers: WorkerTrace[] = [
      { actor_id: "w1", role: "explorer", question: "find auth middleware in src/api", status: "active" },
    ]
    // when a near-identical question arrives
    const result = checkDuplicate(
      { role: "explorer", question: "locate the auth middleware under src/api" },
      workers,
    )
    // then it reuses the active worker
    expect(result.duplicate).toBe(true)
    if (result.duplicate) expect(result.reason).toBe("active")
  })

  test("reuses a completed worker's result", () => {
    // given a completed worker with the same topic
    const workers: WorkerTrace[] = [
      { actor_id: "w1", role: "explorer", question: "call-site search for validateEmail", status: "completed" },
    ]
    // when
    const result = checkDuplicate(
      { role: "explorer", question: "search call sites of validate email" },
      workers,
    )
    // then
    expect(result.duplicate).toBe(true)
    if (result.duplicate) expect(result.reason).toBe("completed")
  })

  test("does not flag different roles or unrelated topics", () => {
    // given a worker on a different question
    const workers: WorkerTrace[] = [
      { actor_id: "w1", role: "explorer", question: "map the repository layout", status: "active" },
    ]
    // when an unrelated question in the same role arrives
    const unrelated = checkDuplicate(
      { role: "explorer", question: "enumerate all zod schemas and their defaults" },
      workers,
    )
    // then it is not a duplicate
    expect(unrelated.duplicate).toBe(false)
  })

  test("role mismatch disables duplicate matching", () => {
    const workers: WorkerTrace[] = [
      { actor_id: "w1", role: "explorer", question: "find auth middleware", status: "active" },
    ]
    const result = checkDuplicate(
      { role: "reviewer", question: "find auth middleware" },
      workers,
    )
    expect(result.duplicate).toBe(false)
  })
})
