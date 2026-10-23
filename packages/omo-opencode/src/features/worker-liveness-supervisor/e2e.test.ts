import { describe, expect, test } from "bun:test"
import { createLivenessSupervisor } from "./supervisor"
import type { SupervisorDeps, SupervisorEvent, SupervisorPolicy } from "./types"

function spawnDelegatedProcess() {
  // Spawn the SAME runtime that is executing this test (process.execPath), not
  // the `bun` on PATH: PATH may resolve to a wrapper that never dies on SIGKILL,
  // which would hang `await proc.exited` forever.
  const proc = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"])
  return proc
}

describe("liveness-supervisor:e2e", () => {
  test("real process: detects process_exit/SIGKILL, retries once, then blocked; latency measured; one terminal wake; zero paid-root wakes before terminal", async () => {
    const fastPolicy: SupervisorPolicy = {
      launchAckDeadlineMs: 200,
      heartbeatIntervalMs: 300,
      missingHeartbeatDeadlineMs: 500,
      progressStallMs: 600,
      completionGraceMs: 10_000,
      orphanIdleMs: 120_000,
      maxAttempts: 2,
      circuitBreakerFailureThreshold: 2,
      circuitBreakerCooldownMs: 300_000,
      notificationBatchWindowMs: 60_000,
    }

    const testClock = {
      nowMs: 1_000_000,
      advance(ms: number) {
        testClock.nowMs += ms
      },
    }

    const proc = spawnDelegatedProcess()

    const events: SupervisorEvent[] = []
    let dispatchCount = 0
    let sup: ReturnType<typeof createLivenessSupervisor> | undefined
    try {
      await new Promise((r) => setTimeout(r, 100))

      const workerId = proc.pid.toString()

      sup = createLivenessSupervisor({
        now: () => testClock.nowMs,
        freeWorkerLane: null,
        dispatchRetry: async (req) => {
          dispatchCount += 1
          return true
        },
        cancel: () => {},
        onEvent: (e) => events.push(e),
      }, fastPolicy)

      const spawnedAt = testClock.nowMs

      sup.register({
        id: "e2e-del-1",
        workerId,
        providerId: "p1",
        parentId: "parent-1",
        freeLane: true,
        pid: proc.pid,
      })

      sup.acknowledge("e2e-del-1")

      sup.heartbeat("e2e-del-1")
      sup.progress("e2e-del-1")

      testClock.advance(501)

      sup.tick()

      const recAfterHb = sup.snapshot("e2e-del-1")
      expect(recAfterHb?.failure).toBe("heartbeat_missing")

      proc.kill("SIGKILL")

      await proc.exited

      testClock.advance(10)

      sup.tick()

      const recAfterExit = sup.snapshot("e2e-del-1")
      expect(recAfterExit?.failure).toBe("process_exit")
      expect(recAfterExit?.status).toBe("recovering")

      const detectedAt = testClock.nowMs
      expect(detectedAt - spawnedAt).toBeLessThan(2000)

      expect(dispatchCount).toBe(1)

      // A later failure ends blocked with no third dispatch.
      testClock.advance(2000)
      sup.fail("e2e-del-1", "process_exit")

      const finalRec = sup.snapshot("e2e-del-1")
      expect(finalRec?.status).toBe("blocked")
      expect(dispatchCount).toBe(1)

      const terminalWakes = events.filter((e) => e.kind === "delegation_completed" || e.kind === "wake_parent").length
      expect(terminalWakes).toBe(1)

      const firstTerminalIndex = events.findIndex((e) => e.kind === "delegation_completed" || e.kind === "wake_parent")
      const paidRootBeforeTerminal = events
        .slice(0, firstTerminalIndex === -1 ? events.length : firstTerminalIndex)
        .filter((e) => e.kind === "wake_parent" && (e as { paidRootWake?: boolean }).paidRootWake === true).length
      expect(paidRootBeforeTerminal).toBe(0)

      const totalElapsedMs = testClock.nowMs - spawnedAt
      expect(totalElapsedMs).toBeLessThan(3000)
    } finally {
      try {
        proc.kill("SIGKILL")
      } catch {
        // ignore
      }
      try {
        sup?.stop()
      } catch {
        // ignore
      }
    }
  })
})