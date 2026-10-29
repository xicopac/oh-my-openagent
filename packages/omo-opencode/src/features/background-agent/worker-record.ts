import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { log } from "../../shared"

import type {
  WorkerRecord,
  WorkerRecordPatch,
  WorkerRecordState,
  WorkerRecordStore,
  WorkerRecordStoreOptions,
  WorkerTerminalOutcome,
} from "./worker-record-types"

export type {
  WorkerRecord,
  WorkerRecordModel,
  WorkerRecordPatch,
  WorkerRecordState,
  WorkerRecordStore,
  WorkerRecordStoreOptions,
  WorkerTerminalOutcome,
} from "./worker-record-types"

const DEFAULT_MAX_RESULT_CHARS = 64_000
const RECORD_SUFFIX = ".json"
const DISABLED_ENV = "OMO_DISABLE_WORKER_RECORDS"

export function resolveWorkerRecordRoot(rootDir?: string): string {
  return rootDir ?? join(process.env.HOME || homedir(), ".omo", "workers")
}

export function sanitizeWorkerRecordID(workerID: string): string {
  return workerID.replace(/[^A-Za-z0-9._:-]/g, "_")
}

export function workerRecordPath(rootDir: string, workerID: string): string {
  const safe = sanitizeWorkerRecordID(workerID)
  if (safe.length === 0) throw new Error("invalid worker record id")
  return join(rootDir, `${safe}${RECORD_SUFFIX}`)
}

export function createWorkerRecordStore(options: WorkerRecordStoreOptions = {}): WorkerRecordStore {
  const rootDir = resolveWorkerRecordRoot(options.rootDir)
  const now = options.now ?? (() => new Date())
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS

  function read(workerID: string): WorkerRecord | undefined {
    try {
      const parsed = JSON.parse(readFileSync(workerRecordPath(rootDir, workerID), "utf8")) as Partial<WorkerRecord>
      return isWorkerRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  function save(record: WorkerRecord): boolean {
    if (process.env[DISABLED_ENV] === "1") return false
    const bounded = boundResult(record, maxResultChars)
    try {
      mkdirSync(rootDir, { recursive: true, mode: 0o700 })
      const target = workerRecordPath(rootDir, bounded.workerID)
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, `${JSON.stringify(bounded, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, target)
      return true
    } catch (error) {
      log("[worker-record] Failed to persist worker record:", {
        workerID: record.workerID,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  function update(workerID: string, patch: WorkerRecordPatch): WorkerRecord | undefined {
    const existing = read(workerID)
    if (!existing) return undefined
    const next: WorkerRecord = {
      ...existing,
      ...patch,
      updatedAt: (patch.updatedAt ?? now().toISOString()),
    }
    return save(next) ? next : undefined
  }

  return {
    rootDir,
    save,
    update,
    get: read,
    list() {
      if (process.env[DISABLED_ENV] === "1") return []
      let names: string[]
      try {
        names = readdirSync(rootDir)
      } catch {
        return []
      }
      const records: WorkerRecord[] = []
      for (const name of names) {
        if (!name.endsWith(RECORD_SUFFIX)) continue
        const record = read(name.slice(0, -RECORD_SUFFIX.length))
        if (record) records.push(record)
      }
      return records
    },
    markNotificationQueued(workerID, at) {
      update(workerID, {
        notificationQueuedAt: (at ?? now()).toISOString(),
        updatedAt: now().toISOString(),
      })
    },
    markNotificationDelivered(workerID, at) {
      update(workerID, {
        notificationDeliveredAt: (at ?? now()).toISOString(),
        updatedAt: now().toISOString(),
      })
    },
    prune(maxAgeMs, at) {
      const cutoff = (at ?? now()).getTime() - maxAgeMs
      let removed = 0
      for (const record of this.list()) {
        const terminalAt = Date.parse(record.terminalAt ?? record.updatedAt)
        if (!Number.isFinite(terminalAt) || terminalAt > cutoff) continue
        if (record.notificationDeliveredAt === undefined) continue
        try {
          rmSync(workerRecordPath(rootDir, record.workerID), { force: true })
          removed += 1
        } catch {
          continue
        }
      }
      return removed
    },
  }
}

export function terminalOutcomeForStatus(status: string): WorkerTerminalOutcome | undefined {
  switch (status) {
    case "completed":
      return "completed"
    case "error":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "interrupt":
      return "cancelled"
    case "blocked":
      return "blocked"
    default:
      return undefined
  }
}

export function workerStateForStatus(status: string): WorkerRecordState | undefined {
  switch (status) {
    case "pending":
    case "dispatched":
      return "dispatched"
    case "starting":
      return "starting"
    case "running":
      return "running"
    case "completed":
      return "completed"
    case "error":
      return "failed"
    case "cancelled":
    case "interrupt":
      return "cancelled"
    case "blocked":
      return "blocked"
    case "stalled":
      return "stalled"
    default:
      return undefined
  }
}

function boundResult(record: WorkerRecord, maxChars: number): WorkerRecord {
  if (record.result === undefined || record.result.length <= maxChars) return record
  return {
    ...record,
    result: record.result.slice(0, maxChars),
    resultTruncated: true,
  }
}

function isWorkerRecord(value: Partial<WorkerRecord>): value is WorkerRecord {
  return value.schemaVersion === 1
    && typeof value.workerID === "string"
    && value.workerID.length > 0
    && typeof value.parentSessionID === "string"
    && typeof value.agent === "string"
    && typeof value.description === "string"
    && typeof value.state === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
}
