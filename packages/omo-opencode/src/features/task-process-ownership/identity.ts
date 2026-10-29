import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import type { ProcessIdentity } from "./types"

/**
 * Linux /proc/<pid>/stat identity.
 *
 * `startTime` is field 22 (kernel clock ticks since boot). Together with the
 * pid and pgid it proves the process we are about to signal is the exact
 * process we recorded, not a recycled pid.
 */
export function readProcessIdentity(pid: number, procRoot = "/proc"): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  let raw: string
  try {
    raw = readFileSync(join(procRoot, String(pid), "stat"), "utf8")
  } catch {
    return undefined
  }
  return parseProcessStat(pid, raw)
}

export function parseProcessStat(pid: number, raw: string): ProcessIdentity | undefined {
  const open = raw.indexOf("(")
  const close = raw.lastIndexOf(")")
  if (open < 0 || close <= open) return undefined
  const comm = raw.slice(open + 1, close)
  const fields = raw.slice(close + 1).trim().split(/\s+/)
  if (fields.length < 20) return undefined
  const ppid = Number.parseInt(fields[1] ?? "", 10)
  const pgid = Number.parseInt(fields[2] ?? "", 10)
  const startTime = fields[19] ?? ""
  if (!Number.isFinite(ppid) || !Number.isFinite(pgid) || startTime.length === 0) return undefined
  return {
    pid,
    ppid,
    pgid,
    startTime,
    state: fields[0] ?? "",
    comm,
  }
}

export function readSelfIdentity(procRoot = "/proc"): ProcessIdentity | undefined {
  return readProcessIdentity(process.pid, procRoot)
}

export function listProcessGroupMembers(pgid: number, procRoot = "/proc"): ProcessIdentity[] {
  if (!Number.isInteger(pgid) || pgid <= 0) return []
  let entries: string[]
  try {
    entries = readdirSync(procRoot)
  } catch {
    return []
  }
  const members: ProcessIdentity[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const identity = readProcessIdentity(Number.parseInt(entry, 10), procRoot)
    if (identity && identity.pgid === pgid) members.push(identity)
  }
  return members
}

export function identityMatches(
  current: ProcessIdentity | undefined,
  expectedStartTime: string,
): current is ProcessIdentity {
  return current !== undefined && current.startTime === expectedStartTime
}

export function isLiveIdentity(identity: ProcessIdentity | undefined): identity is ProcessIdentity {
  return identity !== undefined && identity.state !== "Z"
}
