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
  WorkerTerminalTransition,
  WorkerTerminalTransitionResult,
  WorkerTerminalOutcome,
  WorkerWakeState,
} from "./worker-record-types"

export type {
  WorkerRecord,
  WorkerRecordModel,
  WorkerRecordPatch,
  WorkerRecordState,
  WorkerRecordStore,
  WorkerRecordStoreOptions,
  WorkerTerminalTransition,
  WorkerTerminalTransitionResult,
  WorkerTerminalOutcome,
  WorkerWakeState,
} from "./worker-record-types"

const DEFAULT_MAX_RESULT_CHARS = 64_000
const RECORD_SUFFIX = ".json"
const DISABLED_ENV = "OMO_DISABLE_WORKER_RECORDS"
const TERMINAL_RECORD_FIELDS = new Set<keyof WorkerRecord>([
  "state",
  "terminalAt",
  "terminalOutcome",
  "terminalEventID",
  "terminalAttemptID",
  "terminalReason",
  "result",
  "resultTruncated",
  "attempts",
  "recoveryEpisodeID",
])
const WAKE_STATE_RANK: Record<WorkerWakeState, number> = {
  pending: 0,
  dispatched: 1,
  acknowledged: 2,
}

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
  const createEventID = options.createEventID
    ?? (() => `wake_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`)

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
    const safePatch = existing.terminalAt ? omitTerminalFields(patch) : patch
    const next: WorkerRecord = {
      ...existing,
      ...safePatch,
      updatedAt: (safePatch.updatedAt ?? now().toISOString()),
    }
    return save(next) ? read(workerID) : undefined
  }

  function terminalize(
    workerID: string,
    transition: WorkerTerminalTransition,
  ): WorkerTerminalTransitionResult | undefined {
    const existing = read(workerID)
    if (!existing) return undefined
    if (existing.terminalAt) return { record: existing, committed: false }

    const terminalEventID = createEventID()
    const next: WorkerRecord = {
      ...existing,
      ...transition,
      terminalEventID,
      wakeEventID: terminalEventID,
      wakeState: "pending",
      wakePendingAt: transition.terminalAt,
      updatedAt: transition.terminalAt,
    }
    if (!save(next)) return undefined
    const committed = read(workerID)
    return committed ? { record: committed, committed: true } : undefined
  }

  function transitionWake(workerID: string, target: WorkerWakeState, at?: Date): WorkerRecord | undefined {
    const existing = read(workerID)
    if (!existing?.terminalAt) return existing
    const legacyAcknowledged = existing.wakeState === undefined && existing.notificationDeliveredAt !== undefined
    const current: WorkerWakeState = legacyAcknowledged ? "acknowledged" : (existing.wakeState ?? "pending")
    if (WAKE_STATE_RANK[target] < WAKE_STATE_RANK[current]) return existing

    const timestamp = (at ?? now()).toISOString()
    const eventID = existing.terminalEventID ?? existing.wakeEventID ?? createEventID()
    const patch: WorkerRecordPatch = {
      terminalEventID: eventID,
      wakeEventID: eventID,
      wakeState: target,
      wakePendingAt: existing.wakePendingAt ?? existing.terminalAt,
      ...(target === "dispatched" && existing.wakeDispatchedAt === undefined
        ? { wakeDispatchedAt: timestamp }
        : {}),
      ...(target === "acknowledged" && existing.wakeAcknowledgedAt === undefined
        ? { wakeAcknowledgedAt: timestamp, notificationDeliveredAt: timestamp }
        : {}),
      updatedAt: timestamp,
    }
    const next = { ...existing, ...patch }
    return save(next) ? read(workerID) : undefined
  }

  return {
    rootDir,
    save,
    update,
    terminalize,
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
      const timestamp = (at ?? now()).toISOString()
      transitionWake(workerID, "pending", at)
      update(workerID, { notificationQueuedAt: timestamp, updatedAt: timestamp })
    },
    markWakeDispatched(workerID, at) {
      transitionWake(workerID, "dispatched", at)
    },
    markWakeAcknowledged(workerID, at) {
      transitionWake(workerID, "acknowledged", at)
    },
    markNotificationDelivered(workerID, at) {
      transitionWake(workerID, "acknowledged", at)
    },
    prune(maxAgeMs, at) {
      const cutoff = (at ?? now()).getTime() - maxAgeMs
      let removed = 0
      for (const record of this.list()) {
        const terminalAt = Date.parse(record.terminalAt ?? record.updatedAt)
        if (!Number.isFinite(terminalAt) || terminalAt > cutoff) continue
        const acknowledged = record.wakeState === "acknowledged"
          || (record.wakeState === undefined && record.notificationDeliveredAt !== undefined)
        if (!acknowledged) continue
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

function omitTerminalFields(patch: WorkerRecordPatch): WorkerRecordPatch {
  const safe = { ...patch } as Record<string, unknown>
  for (const field of TERMINAL_RECORD_FIELDS) delete safe[field]
  return safe as WorkerRecordPatch
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
