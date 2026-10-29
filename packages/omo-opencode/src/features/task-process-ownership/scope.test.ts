import { describe, expect, test } from "bun:test"

import { cleanupAiJobScope, cleanupProcessGroupScope } from "./scope"
import type {
  AiJobScope,
  CommandResult,
  CommandRunner,
  OwnershipSystem,
  ProcessGroupScope,
  ProcessIdentity,
  SignalSender,
} from "./types"

type RecordedCommand = { argv: readonly string[]; result: CommandResult }

function createAiJobSystem(options: {
  marker: string
  slice?: string
  active: boolean
  stopRemaining?: number
  stopClearsActive?: boolean
}): { system: OwnershipSystem; commands: RecordedCommand[]; isActive: () => boolean } {
  let active = options.active
  const commands: RecordedCommand[] = []
  const runCommand: CommandRunner = async (argv) => {
    let result: CommandResult = { code: 0, stdout: "", stderr: "" }
    const command = argv.join(" ")
    if (command.includes("-p LoadState")) result = { code: 0, stdout: "loaded\n", stderr: "" }
    else if (command.includes("-p ActiveState")) result = { code: 0, stdout: active ? "active\n" : "inactive\n", stderr: "" }
    else if (command.includes("-p Slice")) result = { code: 0, stdout: `${options.slice ?? "ai-work.slice"}\n`, stderr: "" }
    else if (command.includes("-p ExecStart")) {
      result = {
        code: 0,
        stdout: `ExecStart={ path=/bin/bash ; argv[]=/bin/bash -lc export OMO_TASK_OWNER=${options.marker}; sleep 30 }\n`,
        stderr: "",
      }
    } else if (argv[0]?.endsWith("ai-job") && argv[1] === "stop") {
      const remaining = options.stopRemaining ?? 0
      if (remaining === 0 && options.stopClearsActive !== false) active = false
      result = { code: 0, stdout: `AI_JOB_STOP_REMAINING_PROCESSES=${remaining}\n`, stderr: "" }
    }
    commands.push({ argv: [...argv], result })
    return result
  }
  return {
    system: {
      readIdentity: () => undefined,
      listGroupMembers: () => [],
      signal: () => {},
      runCommand,
      sleep: async () => {},
    },
    commands,
    isActive: () => active,
  }
}

const aiJobScope = (marker: string, unit = "ai-test-abc123.service"): AiJobScope => ({
  kind: "ai-job",
  unit,
  slice: "ai-work.slice",
  marker,
})

describe("ai-job scope cleanup", () => {
  describe("#given an active unit with the matching ownership marker", () => {
    test("#when cleaned #then ai-job stop is called once and the unit is gone", async () => {
      const fake = createAiJobSystem({ marker: "marker-1", active: true })
      const outcome = await cleanupAiJobScope(aiJobScope("marker-1"), {
        system: fake.system,
        aiJobBin: "/usr/local/bin/ai-job",
        graceMs: 10,
        pollMs: 1,
      })

      expect(outcome.ok).toBe(true)
      expect(outcome.signals).toEqual(["SIGTERM", "SIGKILL"])
      expect(fake.commands.filter((entry) => entry.argv[1] === "stop")).toHaveLength(1)
      expect(fake.isActive()).toBe(false)
    })
  })

  describe("#given an active unit whose marker appears quoted in ExecStart", () => {
    test("#when cleaned #then the quote-tolerant check still stops it", async () => {
      const fake = createAiJobSystem({ marker: "'quoted-marker'", active: true })
      const outcome = await cleanupAiJobScope(aiJobScope("quoted-marker"), {
        system: fake.system,
        aiJobBin: "/usr/local/bin/ai-job",
        graceMs: 10,
        pollMs: 1,
      })

      expect(outcome.ok).toBe(true)
      expect(fake.commands.filter((entry) => entry.argv[1] === "stop")).toHaveLength(1)
    })
  })

  describe("#given an active unit whose ExecStart belongs to a different owner", () => {
    test("#when cleaned #then it refuses without stopping the unit", async () => {
      const fake = createAiJobSystem({ marker: "other-marker", active: true })
      const outcome = await cleanupAiJobScope(aiJobScope("my-marker"), {
        system: fake.system,
        aiJobBin: "/usr/local/bin/ai-job",
        graceMs: 10,
        pollMs: 1,
      })

      expect(outcome.ok).toBe(false)
      expect(outcome.detail).toBe("refused-ownership-marker-mismatch")
      expect(fake.commands.filter((entry) => entry.argv[1] === "stop")).toHaveLength(0)
      expect(fake.isActive()).toBe(true)
    })
  })

  describe("#given an active unit outside the disposable slices", () => {
    test("#when cleaned #then it refuses", async () => {
      const fake = createAiJobSystem({ marker: "m", active: true, slice: "ai-control.slice" })
      const outcome = await cleanupAiJobScope(aiJobScope("m"), {
        system: fake.system,
        aiJobBin: "/usr/local/bin/ai-job",
        graceMs: 10,
        pollMs: 1,
      })

      expect(outcome.ok).toBe(false)
      expect(outcome.detail).toContain("refused-slice")
    })
  })
})

type FakeTable = Map<number, ProcessIdentity>

function createGroupSystem(table: FakeTable): {
  system: OwnershipSystem
  signals: Array<{ pid: number; signal: string }>
} {
  const signals: Array<{ pid: number; signal: string }> = []
  const signal: SignalSender = (pid, name) => {
    signals.push({ pid, signal: name })
    if (name === "SIGKILL") {
      if (pid < 0) {
        for (const [memberPID, identity] of table) {
          if (identity.pgid === -pid) table.delete(memberPID)
        }
      } else {
        table.delete(pid)
      }
    }
  }
  return {
    system: {
      readIdentity: (pid) => table.get(pid),
      listGroupMembers: (pgid) => [...table.values()].filter((identity) => identity.pgid === pgid),
      signal,
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      sleep: async () => {},
    },
    signals,
  }
}

const groupScope = (): ProcessGroupScope => ({
  kind: "process-group",
  pgid: 4_001,
  leaderPid: 4_001,
  leaderStartTime: "100",
  members: [
    { pid: 4_001, startTime: "100" },
    { pid: 4_002, startTime: "101" },
  ],
})

describe("process-group scope cleanup", () => {
  describe("#given a verified leader and a grandchild that ignore SIGTERM", () => {
    test("#when cleaned #then the group is TERMed then KILLed", async () => {
      const table: FakeTable = new Map([
        [4_001, { pid: 4_001, ppid: 1, pgid: 4_001, startTime: "100", state: "S", comm: "child" }],
        [4_002, { pid: 4_002, ppid: 4_001, pgid: 4_001, startTime: "101", state: "S", comm: "grandchild" }],
      ])
      const fake = createGroupSystem(table)
      const outcome = await cleanupProcessGroupScope(groupScope(), {
        system: fake.system,
        graceMs: 10,
        pollMs: 1,
      })

      expect(outcome.ok).toBe(true)
      expect(fake.signals).toContainEqual({ pid: -4_001, signal: "SIGTERM" })
      expect(fake.signals).toContainEqual({ pid: -4_001, signal: "SIGKILL" })
      expect(table.size).toBe(0)
    })
  })

  describe("#given a recycled pid whose starttime no longer matches", () => {
    test("#when cleaned #then nothing is signalled", async () => {
      const table: FakeTable = new Map([
        [4_001, { pid: 4_001, ppid: 1, pgid: 4_001, startTime: "999", state: "S", comm: "unrelated" }],
      ])
      const fake = createGroupSystem(table)
      const outcome = await cleanupProcessGroupScope(groupScope(), {
        system: fake.system,
        graceMs: 10,
        pollMs: 1,
      })

      expect(outcome.ok).toBe(true)
      expect(outcome.detail).toBe("group-absent")
      expect(fake.signals).toHaveLength(0)
      expect(table.get(4_001)?.comm).toBe("unrelated")
    })
  })

  describe("#given a scope that shares the caller's own process group", () => {
    test("#when cleaned #then it refuses", async () => {
      const table: FakeTable = new Map([
        [4_001, { pid: 4_001, ppid: 1, pgid: 4_001, startTime: "100", state: "S", comm: "child" }],
        [process.pid, { pid: process.pid, ppid: 1, pgid: 4_001, startTime: "1", state: "S", comm: "self" }],
      ])
      const fake = createGroupSystem(table)
      const outcome = await cleanupProcessGroupScope(groupScope(), {
        system: fake.system,
        graceMs: 10,
        pollMs: 1,
      })

      expect(outcome.ok).toBe(false)
      expect(outcome.detail).toBe("refused-unsafe-pgid")
      expect(fake.signals).toHaveLength(0)
    })
  })
})
