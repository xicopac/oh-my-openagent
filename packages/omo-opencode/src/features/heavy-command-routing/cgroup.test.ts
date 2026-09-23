import { describe, expect, test } from "bun:test"
import { __resetOwnCgroupCacheForTests, isInsideControlSlice } from "./cgroup"

describe("isInsideControlSlice", () => {
  test("cgroup v2 form with ai-control.slice -> true", () => {
    // given
    const cgroup = "0::/ai.slice/ai-control.slice/run-x.scope"

    // when
    const result = isInsideControlSlice(cgroup)

    // then
    expect(result).toBe(true)
  })

  test("legacy form with ai-control.slice -> true", () => {
    // given
    const cgroup = "10:devices:/ai.slice/ai-control.slice/run-x.scope"

    // when
    const result = isInsideControlSlice(cgroup)

    // then
    expect(result).toBe(true)
  })

  test("ai-work.slice -> false", () => {
    // given
    const cgroup = "0::/ai.slice/ai-work.slice/run-x.scope"

    // when
    const result = isInsideControlSlice(cgroup)

    // then
    expect(result).toBe(false)
  })

  test("empty string -> false", () => {
    // given
    const cgroup = ""

    // when
    const result = isInsideControlSlice(cgroup)

    // then
    expect(result).toBe(false)
  })

  test("root cgroup -> false", () => {
    // given
    const cgroup = "0::/"

    // when
    const result = isInsideControlSlice(cgroup)

    // then
    expect(result).toBe(false)
  })

  test("cache reset exposed for tests", () => {
    // given
    __resetOwnCgroupCacheForTests()

    // when
    const result = isInsideControlSlice("0::/ai.slice/ai-control.slice/x")

    // then
    expect(result).toBe(true)
  })
})
