import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "./manager"

function cast<T>(value: unknown): T {
  return value as T
}

function createManager(): BackgroundManager {
  const client = {
    session: {
      get: async () => ({ data: { directory: "/test/dir" } }),
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
    },
  }
  return new BackgroundManager({ pluginContext: cast<PluginInput>({ client, directory: tmpdir() }) })
}

function getRootDescendantCounts(manager: BackgroundManager): Map<string, number> {
  return (cast<{ rootDescendantCounts: Map<string, number> }>(manager)).rootDescendantCounts
}

let manager: BackgroundManager | undefined

afterEach(() => {
  manager?.shutdown()
  manager = undefined
})

describe("sync subagent spawn reservations release the live descendant count", () => {
  describe("#given one root with sequential sync-style reservations", () => {
    test("#when N reservations are reserved, committed, and released #then the count returns to its pre-task value", async () => {
      // given
      manager = createManager()
      const counts = getRootDescendantCounts(manager)
      const preTaskValue = counts.get("session-root") ?? 0

      // when
      for (let i = 0; i < 5; i += 1) {
        const reservation = await manager.reserveSubagentSpawn("session-root")
        expect(counts.get(reservation.spawnContext.rootSessionID)).toBe(preTaskValue + 1)
        reservation.commit(`ses-sync-${i}`)
        manager.releaseSubagentSpawn(`ses-sync-${i}`)
        // then (per iteration)
        expect(counts.get(reservation.spawnContext.rootSessionID) ?? 0).toBe(preTaskValue)
      }

      // then
      expect(counts.get("session-root") ?? 0).toBe(preTaskValue)
    })
  })

  describe("#given a committed sync reservation", () => {
    test("#when release is called twice #then the second call is a safe no-op", async () => {
      // given
      manager = createManager()
      const counts = getRootDescendantCounts(manager)
      const reservation = await manager.reserveSubagentSpawn("session-root")
      reservation.commit("ses-sync-double")

      // when
      manager.releaseSubagentSpawn("ses-sync-double")
      manager.releaseSubagentSpawn("ses-sync-double")

      // then
      expect(counts.get(reservation.spawnContext.rootSessionID) ?? 0).toBe(0)
    })

    test("#when rollback runs after commit #then a later release does not double-decrement", async () => {
      // given
      manager = createManager()
      const counts = getRootDescendantCounts(manager)
      const reservation = await manager.reserveSubagentSpawn("session-root")
      reservation.commit("ses-sync-rollback")

      // when
      reservation.rollback()
      manager.releaseSubagentSpawn("ses-sync-rollback")

      // then
      expect(counts.get(reservation.spawnContext.rootSessionID) ?? 0).toBe(0)
    })
  })

  describe("#given no reservation was ever made", () => {
    test("#when release is called for an unknown session #then it is a safe no-op", () => {
      // given
      manager = createManager()
      const counts = getRootDescendantCounts(manager)

      // when
      manager.releaseSubagentSpawn("ses-never-reserved")
      manager.releaseRootDescendantForSession("ses-never-reserved")

      // then
      expect(counts.size).toBe(0)
    })
  })

  describe("#given a reservation that was rolled back before commit", () => {
    test("#when release is called afterwards #then the count stays at zero", async () => {
      // given
      manager = createManager()
      const counts = getRootDescendantCounts(manager)
      const reservation = await manager.reserveSubagentSpawn("session-root")

      // when
      reservation.rollback()
      manager.releaseSubagentSpawn("ses-sync-abandoned", reservation.spawnContext.rootSessionID)

      // then
      expect(counts.get(reservation.spawnContext.rootSessionID) ?? 0).toBe(0)
    })
  })
})
