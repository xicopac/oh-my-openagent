import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { readOwnCgroup } from "./cgroup"
import { AI_JOB_BIN, buildAiJobCommand, type JobType } from "./router"

const AI_JOB_HELPER = "/usr/local/libexec/ai-job-helper"
const aiJobAvailable = existsSync(AI_JOB_BIN)
const describeAiJob = aiJobAvailable ? describe : describe.skip

interface LaunchedJob {
  readonly unit: string
}

let unitCounter = 0

function nextUnit(type: JobType): string {
  unitCounter += 1
  const pidHex = process.pid.toString(16).slice(-4).padStart(4, "0")
  const counterHex = unitCounter.toString(16).padStart(2, "0")
  return `ai-${type}-${pidHex}${counterHex}.service`
}

function testRunsInsideDisposableUnit(): boolean {
  const cgroup = readOwnCgroup()
  return cgroup.includes("/ai.slice/ai-work.slice/") || cgroup.includes("/ai.slice/ai-emulator.slice/")
}

function launchJob(type: JobType, timeoutSec: number, script: string): LaunchedJob {
  const unit = nextUnit(type)
  const result = testRunsInsideDisposableUnit()
    ? spawnSync(
      "sudo",
      [
        "-n",
        AI_JOB_HELPER,
        "run",
        type,
        unit,
        String(timeoutSec),
        process.cwd(),
        "--env",
        `PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
        "--",
        "/bin/bash",
        "-lc",
        script,
      ],
      { encoding: "utf8", timeout: 15_000 },
    )
    : spawnSync(
      AI_JOB_BIN,
      [
        "run",
        type,
        "--timeout",
        String(timeoutSec),
        "--name",
        unit.slice(unit.lastIndexOf("-") + 1, -8),
        "--background",
        "--",
        "/bin/bash",
        "-lc",
        script,
      ],
      { encoding: "utf8", timeout: 15_000 },
    )
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  if (result.status !== 0 || !output.includes(`AI_JOB_UNIT=${unit}`)) {
    throw new Error(`[test] failed to launch ${unit}: ${result.error?.message ?? output}`)
  }
  return { unit }
}

function systemctlValue(unit: string, property: "ActiveState" | "ControlGroup" | "Slice"): string {
  const result = spawnSync("systemctl", ["show", "-p", property, "--value", unit], { encoding: "utf8" })
  return (result.stdout ?? "").trim()
}

function waitFor(predicate: () => boolean, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    spawnSync("sleep", ["0.2"])
  }
  return predicate()
}

function unitIsActive(unit: string): boolean {
  return systemctlValue(unit, "ActiveState") === "active"
}

function unitIsStopped(unit: string): boolean {
  const state = systemctlValue(unit, "ActiveState")
  return state === "" || state === "inactive" || state === "failed"
}

function cgroupPids(controlGroup: string): number[] {
  if (!controlGroup) return []
  try {
    return readFileSync(`/sys/fs/cgroup${controlGroup}/cgroup.procs`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((pid) => Number.parseInt(pid, 10))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

function processCommand(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

function cgroupSleepPids(controlGroup: string, seconds: string): number[] {
  return cgroupPids(controlGroup).filter((pid) => {
    const command = processCommand(pid)
    return (command[0]?.endsWith("/sleep") || command[0] === "sleep") && command[1] === seconds
  })
}

function stopUnit(unit: string): boolean {
  if (unitIsStopped(unit)) return true
  const result = spawnSync(AI_JOB_BIN, ["stop", unit], { encoding: "utf8", timeout: 15_000 })
  return result.status === 0 && unitIsStopped(unit)
}

function cleanupUnit(unit: string | undefined): void {
  if (unit) stopUnit(unit)
}

describeAiJob(
  aiJobAvailable ? "systemd integration (live)" : "systemd integration skipped: ai-job unavailable",
  () => {
    test("timeout kills the disposable unit and every process captured from its cgroup", () => {
      // given
      let launched: LaunchedJob | undefined
      try {
        launched = launchJob("heavy", 5, "sleep 100 & wait")
        expect(waitFor(() => unitIsActive(launched?.unit ?? ""), 5_000)).toBe(true)
        const controlGroup = systemctlValue(launched.unit, "ControlGroup")
        const capturedPids = cgroupPids(controlGroup)
        expect(capturedPids.length).toBeGreaterThan(0)

        // when
        const stopped = waitFor(() => unitIsStopped(launched?.unit ?? ""), 15_000)

        // then
        expect(stopped).toBe(true)
        expect(waitFor(() => capturedPids.every((pid) => !existsSync(`/proc/${pid}`)), 5_000)).toBe(true)
        expect(cgroupPids(controlGroup)).toEqual([])
      } finally {
        cleanupUnit(launched?.unit)
      }
    }, { timeout: 35_000 })

    test("stopping a unit kills a setsid process that reparents", () => {
      // given
      let launched: LaunchedJob | undefined
      try {
        launched = launchJob("heavy", 60, "setsid sleep 300 & wait")
        expect(waitFor(() => unitIsActive(launched?.unit ?? ""), 5_000)).toBe(true)
        const controlGroup = systemctlValue(launched.unit, "ControlGroup")
        expect(waitFor(() => cgroupSleepPids(controlGroup, "300").length > 0, 5_000)).toBe(true)
        const escapedPids = cgroupSleepPids(controlGroup, "300")

        // when
        const stopped = stopUnit(launched.unit)

        // then
        expect(stopped).toBe(true)
        expect(waitFor(() => escapedPids.every((pid) => !existsSync(`/proc/${pid}`)), 5_000)).toBe(true)
      } finally {
        cleanupUnit(launched?.unit)
      }
    }, { timeout: 30_000 })

    test("the controller remains responsive after a work unit is stopped", () => {
      let launched: LaunchedJob | undefined
      try {
        // given
        launched = launchJob("heavy", 60, "sleep 20")
        expect(waitFor(() => unitIsActive(launched?.unit ?? ""), 5_000)).toBe(true)
        expect(stopUnit(launched.unit)).toBe(true)

        // when
        const list = spawnSync(AI_JOB_BIN, ["list"], { encoding: "utf8", timeout: 10_000 })
        const echo = spawnSync("/bin/bash", ["-lc", "echo alive"], { encoding: "utf8", timeout: 5_000 })

        // then
        expect(list.status).toBe(0)
        expect((echo.stdout ?? "").trim()).toBe("alive")
      } finally {
        cleanupUnit(launched?.unit)
      }
    }, { timeout: 30_000 })

    test("stopping one concurrent job leaves the other active", () => {
      // given
      let first: LaunchedJob | undefined
      let second: LaunchedJob | undefined
      try {
        first = launchJob("heavy", 60, "sleep 20")
        second = launchJob("heavy", 60, "sleep 20")
        expect(first.unit).not.toBe(second.unit)
        expect(waitFor(() => unitIsActive(first?.unit ?? "") && unitIsActive(second?.unit ?? ""), 5_000)).toBe(true)

        // when
        expect(stopUnit(first.unit)).toBe(true)

        // then
        expect(unitIsStopped(first.unit)).toBe(true)
        expect(unitIsActive(second.unit)).toBe(true)
        expect(stopUnit(second.unit)).toBe(true)
      } finally {
        cleanupUnit(first?.unit)
        cleanupUnit(second?.unit)
      }
    }, { timeout: 40_000 })

    test("a rewritten heavy fixture runs in ai-work.slice and not ai-control.slice", () => {
      // given
      const rewritten = buildAiJobCommand("heavy", "sleep 30", 60)
      expect(rewritten).toContain("ai-job run heavy --timeout 60")
      expect(rewritten).toContain("ai-work.slice")
      expect(rewritten).not.toContain("/ai.slice/ai-control.slice/")
      let launched: LaunchedJob | undefined

      try {
        launched = launchJob("heavy", 60, "sleep 30")
        expect(waitFor(() => unitIsActive(launched?.unit ?? ""), 5_000)).toBe(true)

        // when
        const slice = systemctlValue(launched.unit, "Slice")
        const controlGroup = systemctlValue(launched.unit, "ControlGroup")

        // then
        expect(slice).toBe("ai-work.slice")
        expect(controlGroup).toContain("/ai.slice/ai-work.slice/")
        expect(controlGroup).not.toContain("/ai.slice/ai-control.slice/")
      } finally {
        cleanupUnit(launched?.unit)
      }
    }, { timeout: 30_000 })
  },
)
