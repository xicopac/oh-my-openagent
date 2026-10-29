import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { GovernanceAuditWriter } from "../../shared/governance-audit"
import { createTaskProcessOwnership } from "./ownership"
import { alertsFilePath, listOwnerFilePaths, readOwnerFile } from "./registry"
import type {
  CommandResult,
  CommandRunner,
  OwnershipSystem,
  ProcessIdentity,
  SignalSender,
} from "./types"

type AuditRecord = { sessionID: string; fields: Record<string, unknown> }

function createAudit(): { writer: GovernanceAuditWriter; records: AuditRecord[] } {
  const records: AuditRecord[] = []
  return {
    records,
    writer: {
      write: (sessionID, fields) => {
        records.push({ sessionID, fields })
      },
      path: () => "",
      flush: async () => {},
    },
  }
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "omo-task-process-ownership-"))
}

const createdRoots: string[] = []
function newRoot(): string {
  const root = tempRoot()
  createdRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

type UnitState = { active: boolean; marker: string; remaining?: number }

function createAiJobSystem(units: Map<string, UnitState>): {
  system: OwnershipSystem
  calls: string[][]
} {
  const calls: string[][] = []
  const runCommand: CommandRunner = async (argv): Promise<CommandResult> => {
    calls.push([...argv])
    const unit = argv[argv.length - 1] ?? ""
    const state = units.get(unit)
    const joined = argv.join(" ")
    if (joined.includes("-p LoadState")) {
      return { code: 0, stdout: `${state ? "loaded" : "not-found"}\n`, stderr: "" }
    }
    if (joined.includes("-p ActiveState")) {
      return { code: 0, stdout: `${state?.active ? "active" : "inactive"}\n`, stderr: "" }
    }
    if (joined.includes("-p Slice")) {
      return { code: 0, stdout: "ai-work.slice\n", stderr: "" }
    }
    if (joined.includes("-p ExecStart")) {
      return {
        code: 0,
        stdout: state
          ? `ExecStart={ path=/bin/bash ; argv[]=/bin/bash -lc export OMO_TASK_OWNER=${state.marker}; sleep 30 }\n`
          : "",
        stderr: "",
      }
    }
    if (argv[1] === "stop") {
      const remaining = state?.remaining ?? 0
      if (remaining === 0 && state) state.active = false
      return { code: 0, stdout: `AI_JOB_STOP_REMAINING_PROCESSES=${remaining}\n`, stderr: "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  return {
    calls,
    system: {
      readIdentity: () => undefined,
      listGroupMembers: () => [],
      signal: () => {},
      runCommand,
      sleep: async () => {},
    },
  }
}

function registerUnit(
  ownership: ReturnType<typeof createTaskProcessOwnership>,
  taskID: string,
  callID: string,
): { unit: string; marker: string } {
  const registration = ownership.registerAiJob({
    taskID,
    callID,
    jobType: "test",
    slice: "ai-work.slice",
    timeoutSec: 30,
    command: "bun test packages/example",
  })
  if (!registration || registration.record.scope.kind !== "ai-job") {
    throw new Error("registration failed")
  }
  return { unit: registration.record.scope.unit, marker: registration.record.scope.marker }
}

describe("task process ownership", () => {
  describe("#given a heavy command routed into an ai-job unit", () => {
    test("#when registered #then a durable owner file and marker prefix are written", () => {
      const root = newRoot()
      const audit = createAudit()
      const units = new Map<string, UnitState>()
      const { system } = createAiJobSystem(units)
      const ownership = createTaskProcessOwnership({ rootDir: root, audit: audit.writer, owner: { instanceID: "owner-a" }, system })

      const registration = ownership.registerAiJob({
        taskID: "ses_parent",
        callID: "call_1",
        jobType: "test",
        slice: "ai-work.slice",
        timeoutSec: 30,
        command: "bun test packages/example",
      })

      expect(registration?.binding.unitName).toMatch(/^ai-test-[0-9a-f]{6}\.service$/)
      expect(registration?.binding.commandPrefix).toContain(`OMO_TASK_OWNER=${registration?.binding.marker}`)
      const files = listOwnerFilePaths(root)
      expect(files).toHaveLength(1)
      const file = readOwnerFile(files[0]!)
      expect(file?.owner.instanceID).toBe("owner-a")
      expect(Object.values(file?.records ?? {})).toHaveLength(1)
      expect(audit.records.some((record) => record.fields.event === "task_process_registered")).toBe(true)
    })
  })

  describe("#given a registered unit that finished normally", () => {
    test("#when the call finishes #then it is observed inactive without a stop", async () => {
      const root = newRoot()
      const units = new Map<string, UnitState>()
      const { system, calls } = createAiJobSystem(units)
      const ownership = createTaskProcessOwnership({ rootDir: root, owner: { instanceID: "owner-b" }, system })
      const { unit, marker } = registerUnit(ownership, "ses_a", "call_a")
      units.set(unit, { active: false, marker })

      await ownership.finishCall("ses_a", "call_a")

      expect(ownership.snapshot()[0]?.state).toBe("completed")
      expect(calls.some((argv) => argv[1] === "stop")).toBe(false)
    })
  })

  describe("#given two concurrent task-owned units", () => {
    test("#when one task is cleaned #then the other unit is untouched", async () => {
      const root = newRoot()
      const units = new Map<string, UnitState>()
      const { system, calls } = createAiJobSystem(units)
      const ownership = createTaskProcessOwnership({ rootDir: root, owner: { instanceID: "owner-c" }, system })
      const a = registerUnit(ownership, "ses_a", "call_a")
      const b = registerUnit(ownership, "ses_b", "call_b")
      units.set(a.unit, { active: true, marker: a.marker })
      units.set(b.unit, { active: true, marker: b.marker })

      const summary = await ownership.cleanupTask("ses_a", "cancel")

      expect(summary.cleaned).toBe(1)
      expect(units.get(a.unit)?.active).toBe(false)
      expect(units.get(b.unit)?.active).toBe(true)
      expect(ownership.snapshot().find((record) => record.taskID === "ses_b")?.state).toBe("registered")
      expect(calls.filter((argv) => argv[1] === "stop").map((argv) => argv.at(-1))).toEqual([a.unit])
    })
  })

  describe("#given a unit whose cleanup cannot reach zero processes", () => {
    test("#when cleaned #then it fails, alerts, and records the failure", async () => {
      const root = newRoot()
      const audit = createAudit()
      const units = new Map<string, UnitState>()
      const { system } = createAiJobSystem(units)
      const ownership = createTaskProcessOwnership({
        rootDir: root,
        audit: audit.writer,
        owner: { instanceID: "owner-d" },
        system,
        graceMs: 5,
        pollMs: 1,
      })
      const { unit, marker } = registerUnit(ownership, "ses_fail", "call_fail")
      units.set(unit, { active: true, marker, remaining: 2 })

      const summary = await ownership.cleanupTask("ses_fail", "failure")

      expect(summary.failed).toBe(1)
      expect(ownership.snapshot()[0]?.state).toBe("cleanup_failed")
      expect(audit.records.some((record) => record.fields.event === "task_process_cleanup_failed")).toBe(true)
      const alertLines = readFileSync(alertsFilePath(root), "utf8").trim().split("\n")
      const alert = JSON.parse(alertLines[0]!) as Record<string, unknown>
      expect(alert.event).toBe("task_process_cleanup_failed")
      expect(alert.remaining_pids).toEqual([2])
    })
  })

  describe("#given a HOLD for a task with an active unit", () => {
    test("#when quiesced #then the unit is stopped within the bounded deadline", async () => {
      const root = newRoot()
      const audit = createAudit()
      const units = new Map<string, UnitState>()
      const { system } = createAiJobSystem(units)
      const ownership = createTaskProcessOwnership({
        rootDir: root,
        audit: audit.writer,
        owner: { instanceID: "owner-e" },
        system,
        holdGraceMs: 5,
        pollMs: 1,
      })
      const { unit, marker } = registerUnit(ownership, "ses_hold", "call_hold")
      units.set(unit, { active: true, marker })

      const summary = await ownership.holdTask("ses_hold", "terminal-circuit-open")

      expect(summary.cleaned).toBe(1)
      expect(units.get(unit)?.active).toBe(false)
      expect(audit.records.some((record) => record.fields.event === "task_process_quiesced_on_hold")).toBe(true)
    })
  })

  describe("#given an active unit past its registration timeout", () => {
    test("#when the periodic sweep enforces timeouts #then the unit is stopped with reason timeout", async () => {
      const root = newRoot()
      const units = new Map<string, UnitState>()
      const { system } = createAiJobSystem(units)
      let clock = 1_000_000
      const ownership = createTaskProcessOwnership({
        rootDir: root,
        owner: { instanceID: "owner-timeout" },
        system,
        now: () => clock,
        pollMs: 1,
      })
      const { unit, marker } = registerUnit(ownership, "ses_timeout", "call_timeout")
      units.set(unit, { active: true, marker })

      clock += 30_000 + 120_000 + 1
      await ownership.sweep()

      expect(units.get(unit)?.active).toBe(false)
      const record = ownership.snapshot().find((entry) => entry.taskID === "ses_timeout")
      expect(record?.state).toBe("cleaned")
      expect(record?.cleanup?.reason).toBe("timeout")
    })
  })

  describe("#given a scope registered by an owner that has since died", () => {
    test("#when a new instance recovers #then the owned tree is terminated and the file is removed", async () => {
      const root = newRoot()
      const audit = createAudit()
      const table = new Map<number, ProcessIdentity>([
        [process.pid, { pid: process.pid, ppid: 1, pgid: process.pid, startTime: "1", state: "S", comm: "self" }],
        [5_001, { pid: 5_001, ppid: 1, pgid: 5_001, startTime: "500", state: "S", comm: "child" }],
        [5_002, { pid: 5_002, ppid: 5_001, pgid: 5_001, startTime: "501", state: "S", comm: "grandchild" }],
      ])
      const signals: Array<{ pid: number; signal: string }> = []
      const signal: SignalSender = (pid, name) => {
        signals.push({ pid, signal: name })
        if (name !== "SIGKILL") return
        if (pid < 0) {
          for (const [memberPID, identity] of table) {
            if (identity.pgid === -pid) table.delete(memberPID)
          }
        } else {
          table.delete(pid)
        }
      }
      const system: OwnershipSystem = {
        readIdentity: (pid) => table.get(pid),
        listGroupMembers: (pgid) => [...table.values()].filter((identity) => identity.pgid === pgid),
        signal,
        runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
        sleep: async () => {},
      }
      const deadOwner = createTaskProcessOwnership({
        rootDir: root,
        audit: audit.writer,
        owner: { instanceID: "owner-dead", pid: 999_999, startTime: "0" },
        system,
      })
      const record = deadOwner.registerProcessGroup({ taskID: "ses_orphan", pid: 5_001, command: "test server" })
      expect(record?.scope.kind).toBe("process-group")
      const deadFile = listOwnerFilePaths(root).find((path) => path.includes("owner-dead"))
      expect(deadFile).toBeDefined()

      const liveOwner = createTaskProcessOwnership({
        rootDir: root,
        audit: audit.writer,
        owner: { instanceID: "owner-live" },
        system,
        graceMs: 5,
        pollMs: 1,
      })
      const recovered = await liveOwner.recover()

      expect(recovered).toBe(1)
      expect(table.has(5_001)).toBe(false)
      expect(table.has(5_002)).toBe(false)
      expect(existsSync(deadFile!)).toBe(false)
      expect(audit.records.some((record) => record.fields.event === "task_process_orphan_recovered")).toBe(true)
      expect(liveOwner.snapshot()).toHaveLength(0)
    })
  })

  describe("#given a shutdown while a unit is still active", () => {
    test("#when disposed #then the synchronous stop runs before the async pass", async () => {
      const root = newRoot()
      const units = new Map<string, UnitState>()
      const { system, calls } = createAiJobSystem(units)
      const ownership = createTaskProcessOwnership({
        rootDir: root,
        owner: { instanceID: "owner-dispose" },
        system,
        stopAiJobSync: (scope) => {
          const state = units.get(scope.unit)
          if (state) state.active = false
          calls.push(["sync-stop", scope.unit])
          return { ok: true, detail: "stopped-sync" }
        },
      })
      const { unit, marker } = registerUnit(ownership, "ses_dispose", "call_dispose")
      units.set(unit, { active: true, marker })

      await ownership.dispose()

      expect(ownership.snapshot()[0]?.state).toBe("cleaned")
      expect(calls.filter((argv) => argv[0] === "sync-stop")).toHaveLength(1)
      expect(units.get(unit)?.active).toBe(false)
    })
  })

  describe("#given cleanup is explicitly disabled", () => {
    test("#when a heavy command registers #then no scope is recorded", async () => {
      const root = newRoot()
      const ownership = createTaskProcessOwnership({ rootDir: root, enabled: false, owner: { instanceID: "owner-off" } })

      expect(ownership.registerAiJob({
        taskID: "ses_off",
        callID: "call_off",
        jobType: "test",
        slice: "ai-work.slice",
        timeoutSec: 30,
        command: "bun test",
      })).toBeUndefined()
      expect(existsSync(root) ? readdirSync(root) : []).toHaveLength(0)
    })
  })
})
