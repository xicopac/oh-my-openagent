import { execFile, execFileSync } from "node:child_process"

import { listProcessGroupMembers, readProcessIdentity } from "./identity"
import type {
  AiJobScope,
  CommandResult,
  CommandRunner,
  OwnershipSystem,
  ProcessGroupScope,
  ScopeCleanupOutcome,
  TaskProcessRecord,
} from "./types"

export const DEFAULT_AI_JOB_BIN = "/usr/local/bin/ai-job"
export const ALLOWED_AI_JOB_SLICES: readonly string[] = ["ai-work.slice", "ai-emulator.slice"]
export const DEFAULT_CLEANUP_GRACE_MS = 3_000
export const DEFAULT_HOLD_GRACE_MS = 5_000
export const DEFAULT_POLL_MS = 100

const ACTIVE_STATES = new Set(["active", "activating", "deactivating", "reloading"])

export type ScopeCleanupDeps = {
  readonly system: OwnershipSystem
  readonly aiJobBin?: string
  readonly graceMs?: number
  readonly pollMs?: number
}

export async function cleanupScope(
  record: TaskProcessRecord,
  deps: ScopeCleanupDeps,
): Promise<ScopeCleanupOutcome> {
  if (record.scope.kind === "ai-job") return cleanupAiJobScope(record.scope, deps)
  return cleanupProcessGroupScope(record.scope, deps)
}

export function createDefaultOwnershipSystem(): OwnershipSystem {
  return {
    readIdentity: (pid) => readProcessIdentity(pid),
    listGroupMembers: (pgid) => listProcessGroupMembers(pgid),
    signal: (pid, signal) => {
      try {
        process.kill(pid, signal)
      } catch {
        // ESRCH / EPERM: the scope is already gone or not ours; verification
        // below decides success, never an unhandled exception.
      }
    },
    runCommand: defaultRunCommand,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

function defaultRunCommand(argv: readonly string[], opts?: { timeoutMs?: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (argv.length === 0) {
      resolve({ code: 1, stdout: "", stderr: "empty command" })
      return
    }
    execFile(
      argv[0]!,
      argv.slice(1) as string[],
      {
        timeout: opts?.timeoutMs ?? 15_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const numeric = (error as { code?: unknown } | null)?.code
        const code = typeof numeric === "number" ? numeric : error ? 1 : 0
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
      },
    )
  })
}

export async function cleanupAiJobScope(
  scope: AiJobScope,
  deps: ScopeCleanupDeps,
): Promise<ScopeCleanupOutcome> {
  const { system } = deps
  const signals: string[] = []
  const loadState = await showValue(system, "LoadState", scope.unit)
  if (loadState === "not-found" || loadState.length === 0) {
    return { ok: true, signals, remainingPids: [], detail: "unit-absent" }
  }

  const activeState = await showValue(system, "ActiveState", scope.unit)
  if (!ACTIVE_STATES.has(activeState)) {
    return { ok: true, signals, remainingPids: [], detail: `unit-${activeState || "inactive"}` }
  }

  const slice = await showValue(system, "Slice", scope.unit)
  if (!ALLOWED_AI_JOB_SLICES.includes(slice)) {
    return {
      ok: false,
      signals,
      remainingPids: [],
      detail: `refused-slice:${slice || "unknown"}`,
    }
  }

  const execStart = await system.runCommand(["systemctl", "show", "-p", "ExecStart", scope.unit])
  if (!execStartCarriesMarker(execStart.stdout, scope.marker)) {
    return {
      ok: false,
      signals,
      remainingPids: [],
      detail: "refused-ownership-marker-mismatch",
    }
  }

  const aiJobBin = deps.aiJobBin ?? DEFAULT_AI_JOB_BIN
  let remaining = await stopUnit(system, aiJobBin, scope.unit)
  signals.push("SIGTERM", "SIGKILL")
  if (remaining === 0) return { ok: true, signals, remainingPids: [], detail: "stopped" }

  const graceMs = deps.graceMs ?? DEFAULT_CLEANUP_GRACE_MS
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if ((await showValue(system, "ActiveState", scope.unit)) === "inactive") {
      return { ok: true, signals, remainingPids: [], detail: "stopped-after-grace" }
    }
    await system.sleep(pollMs)
  }

  remaining = await stopUnit(system, aiJobBin, scope.unit)
  if (remaining === 0) return { ok: true, signals, remainingPids: [], detail: "stopped-second-pass" }
  return {
    ok: false,
    signals,
    remainingPids: remaining === undefined ? [] : [remaining],
    detail: remaining === undefined ? "stop-unverified" : `remaining-${remaining}`,
  }
}

export function execStartCarriesMarker(execStart: string, marker: string): boolean {
  return execStart.includes(`OMO_TASK_OWNER=${marker}`)
    || execStart.includes(`OMO_TASK_OWNER='${marker}'`)
    || execStart.includes(`OMO_TASK_OWNER="${marker}"`)
}

/**
 * Synchronous shutdown prefix. The host can exit on SIGTERM/exit before an
 * awaited cleanup finishes; this stops a verified ai-job unit before any async
 * yield. The ai-job helper performs TERM -> bounded wait -> whole-cgroup KILL,
 * so the unit cannot outlive the controller even on an abrupt exit.
 */
export function stopAiJobScopeSync(
  scope: AiJobScope,
  opts?: { aiJobBin?: string; timeoutMs?: number },
): { ok: boolean; detail: string } {
  const aiJobBin = opts?.aiJobBin ?? DEFAULT_AI_JOB_BIN
  const timeout = opts?.timeoutMs ?? 6_000
  try {
    const loadState = execFileSync("systemctl", ["show", "-p", "LoadState", "--value", scope.unit], {
      encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    if (loadState === "not-found" || loadState.length === 0) return { ok: true, detail: "unit-absent" }
    const activeState = execFileSync("systemctl", ["show", "-p", "ActiveState", "--value", scope.unit], {
      encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    if (!ACTIVE_STATES.has(activeState)) return { ok: true, detail: `unit-${activeState || "inactive"}` }
    const slice = execFileSync("systemctl", ["show", "-p", "Slice", "--value", scope.unit], {
      encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    if (!ALLOWED_AI_JOB_SLICES.includes(slice)) return { ok: false, detail: `refused-slice:${slice || "unknown"}` }
    const execStart = execFileSync("systemctl", ["show", "-p", "ExecStart", scope.unit], {
      encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"],
    })
    if (!execStartCarriesMarker(execStart, scope.marker)) {
      return { ok: false, detail: "refused-ownership-marker-mismatch" }
    }
    execFileSync(aiJobBin, ["stop", scope.unit], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] })
    return { ok: true, detail: "stopped-sync" }
  } catch (error) {
    return {
      ok: false,
      detail: `sync-stop-failed:${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function showValue(system: OwnershipSystem, property: string, unit: string): Promise<string> {
  const result = await system.runCommand(["systemctl", "show", "-p", property, "--value", unit])
  if (result.code !== 0) return ""
  return result.stdout.trim()
}

async function stopUnit(system: OwnershipSystem, aiJobBin: string, unit: string): Promise<number | undefined> {
  const result = await system.runCommand([aiJobBin, "stop", unit], { timeoutMs: 20_000 })
  const match = /AI_JOB_STOP_REMAINING_PROCESSES=(\d+)/.exec(result.stdout)
  if (match) return Number.parseInt(match[1]!, 10)
  if (result.code === 0 && (await showValue(system, "ActiveState", unit)) === "inactive") return 0
  return undefined
}

export async function cleanupProcessGroupScope(
  scope: ProcessGroupScope,
  deps: ScopeCleanupDeps,
): Promise<ScopeCleanupOutcome> {
  const { system } = deps
  const signals: string[] = []
  const self = system.readIdentity(process.pid)
  if (
    !Number.isInteger(scope.pgid)
    || scope.pgid <= 1
    || scope.leaderPid <= 1
    || (self !== undefined && self.pgid === scope.pgid)
  ) {
    return { ok: false, signals, remainingPids: [], detail: "refused-unsafe-pgid" }
  }

  const observed = new Map<number, string>()
  for (const member of scope.members) observed.set(member.pid, member.startTime)

  const leader = system.readIdentity(scope.leaderPid)
  const leaderMatches = leader !== undefined
    && leader.startTime === scope.leaderStartTime
    && leader.pgid === scope.pgid
  if (leaderMatches) {
    for (const member of system.listGroupMembers(scope.pgid)) {
      if (!observed.has(member.pid)) observed.set(member.pid, member.startTime)
    }
  }

  const liveObserved = (): number[] => {
    const live: number[] = []
    for (const [pid, startTime] of observed) {
      const current = system.readIdentity(pid)
      if (current !== undefined && current.startTime === startTime && current.state !== "Z") {
        live.push(pid)
      }
    }
    return live
  }

  const initial = liveObserved()
  if (initial.length === 0) {
    return { ok: true, signals, remainingPids: [], detail: "group-absent" }
  }

  if (leaderMatches) {
    system.signal(-scope.pgid, "SIGTERM")
    signals.push("SIGTERM:group")
  } else {
    for (const pid of initial) {
      system.signal(pid, "SIGTERM")
      signals.push(`SIGTERM:${pid}`)
    }
  }

  const graceMs = deps.graceMs ?? DEFAULT_CLEANUP_GRACE_MS
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
  await system.sleep(graceMs)

  const leaderAfter = system.readIdentity(scope.leaderPid)
  const leaderStillMatches = leaderAfter !== undefined
    && leaderAfter.startTime === scope.leaderStartTime
    && leaderAfter.pgid === scope.pgid
    && leaderAfter.state !== "Z"
  if (leaderStillMatches) {
    system.signal(-scope.pgid, "SIGKILL")
    signals.push("SIGKILL:group")
  }

  for (const pid of liveObserved()) {
    system.signal(pid, "SIGKILL")
    signals.push(`SIGKILL:${pid}`)
  }
  await system.sleep(pollMs)

  const remainingPids = liveObserved()
  return {
    ok: remainingPids.length === 0,
    signals,
    remainingPids,
    detail: remainingPids.length === 0 ? "group-stopped" : "group-remaining",
  }
}
