import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { OwnerFile, TaskProcessOwner, TaskProcessRecord } from "./types"

const REGISTRY_DIR_NAME = "process-ownership"
const REGISTRY_VERSION = 1 as const

export function resolveOwnershipRoot(rootDir?: string): string {
  return rootDir ?? join(homedir(), ".omo", REGISTRY_DIR_NAME)
}

export function ownerFilePath(rootDir: string, instanceID: string): string {
  const safe = instanceID.replace(/[^a-zA-Z0-9-]/g, "")
  if (safe.length === 0) throw new Error("invalid ownership instance id")
  return join(rootDir, `${safe}.json`)
}

export function alertsFilePath(rootDir: string): string {
  return join(rootDir, "alerts.jsonl")
}

export function writeOwnerFile(rootDir: string, owner: TaskProcessOwner, records: Iterable<TaskProcessRecord>): string {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  const byID: Record<string, TaskProcessRecord> = {}
  for (const record of records) byID[record.id] = record
  const file: OwnerFile = { version: REGISTRY_VERSION, owner, records: byID }
  const target = ownerFilePath(rootDir, owner.instanceID)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, target)
  return target
}

export function readOwnerFile(path: string): OwnerFile | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OwnerFile>
    if (parsed.version !== REGISTRY_VERSION) return undefined
    if (!parsed.owner || typeof parsed.owner.instanceID !== "string") return undefined
    if (typeof parsed.owner.pid !== "number" || typeof parsed.owner.startTime !== "string") return undefined
    if (!parsed.records || typeof parsed.records !== "object") return undefined
    const records: Record<string, TaskProcessRecord> = {}
    for (const [id, record] of Object.entries(parsed.records)) {
      if (isTaskProcessRecord(record) && record.id === id) records[id] = record
    }
    return {
      version: REGISTRY_VERSION,
      owner: parsed.owner,
      records,
    }
  } catch {
    return undefined
  }
}

function isTaskProcessRecord(value: unknown): value is TaskProcessRecord {
  if (!value || typeof value !== "object") return false
  const record = value as TaskProcessRecord
  if (typeof record.id !== "string" || typeof record.taskID !== "string") return false
  if (!record.scope || typeof record.scope !== "object") return false
  if (record.scope.kind === "ai-job") {
    return typeof record.scope.unit === "string"
      && typeof record.scope.slice === "string"
      && typeof record.scope.marker === "string"
  }
  if (record.scope.kind === "process-group") {
    return typeof record.scope.pgid === "number"
      && typeof record.scope.leaderPid === "number"
      && typeof record.scope.leaderStartTime === "string"
      && Array.isArray(record.scope.members)
  }
  return false
}

export function listOwnerFilePaths(rootDir: string): string[] {
  if (!existsSync(rootDir)) return []
  try {
    return readdirSync(rootDir)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"))
      .sort()
      .map((name) => join(rootDir, name))
  } catch {
    return []
  }
}

export function removeOwnerFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // best-effort runtime state; a later sweep retries
  }
}

export function appendAlert(rootDir: string, alert: Record<string, unknown>): void {
  try {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 })
    const path = alertsFilePath(rootDir)
    appendFileSync(path, `${JSON.stringify(alert)}\n`, { encoding: "utf8", mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    // alerting must never break cleanup
  }
}
