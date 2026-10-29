import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readProcessIdentity } from "./identity"
import { createTaskProcessOwnership } from "./ownership"

type TreeStatus = { pid: number; port: number; grandchild: number }

const CHILD_SOURCE = `
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() { return new Response("ok") },
})
const grandchild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
})
await Bun.write(process.env.STATUS_FILE, JSON.stringify({
  pid: process.pid,
  port: server.port,
  grandchild: grandchild.pid,
}))
setInterval(() => {}, 1000)
`

const roots: string[] = []
const cleanupPids: number[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omo-process-tree-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const pid of cleanupPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(intervalMs)
  }
  throw new Error("timed out waiting for condition")
}

async function waitForStatus(path: string, timeoutMs: number): Promise<TreeStatus> {
  return waitFor(() => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as TreeStatus
      return parsed.port > 0 ? parsed : undefined
    } catch {
      return undefined
    }
  }, timeoutMs)
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(intervalMs)
  }
  throw new Error("timed out waiting for async condition")
}

async function portOpen(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) })
    await response.text()
    return true
  } catch {
    return false
  }
}

function spawnTree(root: string, label: string): { task: ReturnType<typeof Bun.spawn>; statusPath: string } {
  const scriptPath = join(root, `${label}-child.ts`)
  const statusPath = join(root, `${label}-status.json`)
  writeFileSync(scriptPath, CHILD_SOURCE, "utf8")
  const task = Bun.spawn([process.execPath, scriptPath], {
    cwd: root,
    env: { ...process.env, STATUS_FILE: statusPath },
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  cleanupPids.push(task.pid)
  return { task, statusPath }
}

describe("task-owned process tree", () => {
  test(
    "#given a detached child with a grandchild HTTP server #when the task is cancelled #then the tree and port are gone and an unrelated sleeper survives",
    async () => {
      const root = tempRoot()
      const { task, statusPath } = spawnTree(root, "first")
      const status = await waitForStatus(statusPath, 8_000)
      const leader = readProcessIdentity(task.pid)
      expect(leader?.pgid).toBe(task.pid)
      expect(await portOpen(status.port)).toBe(true)

      const unrelated = Bun.spawn(["/bin/sleep", "60"], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      cleanupPids.push(unrelated.pid)

      const ownership = createTaskProcessOwnership({
        rootDir: join(root, "registry"),
        owner: { instanceID: "integration-live" },
        graceMs: 1_500,
        pollMs: 25,
      })
      const record = ownership.registerProcessGroup({
        taskID: "ses_integration",
        pid: task.pid,
        command: "integration test server",
      })
      expect(record?.scope.kind).toBe("process-group")

      const summary = await ownership.cleanupTask("ses_integration", "cancel")
      expect(summary.cleaned).toBe(1)

      await waitFor(() => (readProcessIdentity(status.pid) === undefined ? true : undefined), 5_000)
      await waitFor(() => (readProcessIdentity(status.grandchild) === undefined ? true : undefined), 5_000)
      await waitForAsync(async () => !(await portOpen(status.port)), 5_000)
      expect(readProcessIdentity(unrelated.pid)).toBeDefined()
    },
    30_000,
  )

  test(
    "#given a tree registered by an owner that has since died #when a new plugin instance recovers #then the tree and port are gone",
    async () => {
      const root = tempRoot()
      const { task, statusPath } = spawnTree(root, "second")
      const status = await waitForStatus(statusPath, 8_000)
      expect(await portOpen(status.port)).toBe(true)

      const rootDir = join(root, "registry")
      const deadOwner = createTaskProcessOwnership({
        rootDir,
        owner: { instanceID: "integration-dead", pid: 999_999, startTime: "0" },
        graceMs: 1_500,
        pollMs: 25,
      })
      const record = deadOwner.registerProcessGroup({
        taskID: "ses_restart",
        pid: task.pid,
        command: "integration test server",
      })
      expect(record?.scope.kind).toBe("process-group")
      expect(existsSync(join(rootDir, "integration-dead.json"))).toBe(true)

      const liveOwner = createTaskProcessOwnership({
        rootDir,
        owner: { instanceID: "integration-new" },
        graceMs: 1_500,
        pollMs: 25,
      })
      const recovered = await liveOwner.recover()

      expect(recovered).toBe(1)
      await waitFor(() => (readProcessIdentity(status.pid) === undefined ? true : undefined), 5_000)
      await waitFor(() => (readProcessIdentity(status.grandchild) === undefined ? true : undefined), 5_000)
      await waitForAsync(async () => !(await portOpen(status.port)), 5_000)
      expect(existsSync(join(rootDir, "integration-dead.json"))).toBe(false)
    },
    30_000,
  )
})
