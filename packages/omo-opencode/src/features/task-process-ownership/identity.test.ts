import { describe, expect, test } from "bun:test"

import { parseProcessStat, readProcessIdentity, readSelfIdentity } from "./identity"

describe("process identity", () => {
  describe("#given a /proc stat line with a comm containing spaces and parens", () => {
    const raw = "4242 (tsgo (wrapper) x) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 3 0 987654 0 0"

    test("#when parsed #then comm, pgid, and starttime are exact", () => {
      const identity = parseProcessStat(4242, raw)

      expect(identity).toEqual({
        pid: 4242,
        ppid: 1,
        pgid: 4242,
        startTime: "987654",
        state: "S",
        comm: "tsgo (wrapper) x",
      })
    })
  })

  describe("#given a malformed stat line", () => {
    test("#when parsed #then it is rejected", () => {
      expect(parseProcessStat(1, "1 (short) S 1")).toBeUndefined()
      expect(parseProcessStat(0, "")).toBeUndefined()
    })
  })

  describe("#given the current test process", () => {
    test("#when identity is read #then pid and pgid are live", () => {
      const self = readSelfIdentity()
      const direct = readProcessIdentity(process.pid)

      expect(self?.pid).toBe(process.pid)
      expect(self?.startTime).toBe(direct?.startTime)
      expect(self?.pgid).toBeGreaterThan(0)
    })
  })

  describe("#given a pid that does not exist", () => {
    test("#when identity is read #then it is undefined", () => {
      expect(readProcessIdentity(2_147_483_600)).toBeUndefined()
    })
  })
})
