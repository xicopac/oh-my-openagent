import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"

import type { GovernanceAuditWriter } from "../../shared/governance-audit"
import { readSelfIdentity, isLiveIdentity } from "./identity"
import {
  appendAlert,
  listOwnerFilePaths,
  ownerFilePath,
  readOwnerFile,
  removeOwnerFile,
  resolveOwnershipRoot,
  writeOwnerFile,
} from "./registry"
import {
  ALLOWED_AI_JOB_SLICES,
  DEFAULT_AI_JOB_BIN,
  DEFAULT_CLEANUP_GRACE_MS,
  DEFAULT_HOLD_GRACE_MS,
  DEFAULT_POLL_MS,
  cleanupScope,
  createDefaultOwnershipSystem,
  stopAiJobScopeSync,
} from "./scope"
import type {
  AiJobScope,
  CommandRunner,
  OwnershipSystem,
  ProcessGroupScope,
  SignalSender,
  TaskCleanupSummary,
  TaskProcessCleanup,
  TaskProcessOwner,
  TaskProcessRecord,
  TaskProcessScope,
} from "./types"

export type AiJobBinding = {
  readonly unitName: string
  readonly marker: string
  readonly commandPrefix: string
}

export type AiJobRegistration = {
  readonly record: TaskProcessRecord
  readonly binding: AiJobBinding
}

export type RegisterAiJobInput = {
  readonly taskID: string
  readonly callID?: string
  readonly jobType: string
  readonly slice: string
  readonly timeoutSec: number
  readonly command: string
  readonly label?: string
}

export type RegisterProcessGroupInput = {
  readonly taskID: string
  readonly callID?: string
  readonly pid: number
  readonly command?: string
  readonly label?: string
}

export type TaskProcessOwnershipOptions = {
  readonly rootDir?: string
  readonly audit?: GovernanceAuditWriter
  readonly log?: (message: string, detail?: Record<string, unknown>) => void
  readonly now?: () => number
  readonly enabled?: boolean
  readonly owner?: Partial<TaskProcessOwner>
  readonly system?: Partial<OwnershipSystem>
  readonly aiJobBin?: string
  readonly graceMs?: number
  readonly holdGraceMs?: number
  readonly pollMs?: number
  /** Test/portability seam for the synchronous shutdown stop. */
  readonly stopAiJobSync?: (scope: AiJobScope, opts?: { aiJobBin?: string; timeoutMs?: number }) => { ok: boolean; detail: string }
}

export type TaskProcessOwnership = {
  readonly enabled: boolean
  readonly rootDir: string
  registerAiJob: (input: RegisterAiJobInput) => AiJobRegistration | undefined
  registerProcessGroup: (input: RegisterProcessGroupInput) => TaskProcessRecord | undefined
  finishCall: (taskID: string, callID: string) => Promise<void>
  cleanupTask: (taskID: string, reason: string) => Promise<TaskCleanupSummary>
  holdTask: (taskID: string, reason: string) => Promise<TaskCleanupSummary>
  recover: () => Promise<number>
  sweep: () => Promise<void>
  dispose: () => Promise<void>
  snapshot: () => TaskProcessRecord[]
}

const DISABLE_ENV = "OMO_DISABLE_TASK_PROCESS_CLEANUP"
const TERMINAL_STATES = new Set(["cleaned", "completed"])
const JOB_TYPES = new Set(["build", "test", "gradle", "heavy", "emulator"])

export function createTaskProcessOwnership(options: TaskProcessOwnershipOptions = {}): TaskProcessOwnership {
  const rootDir = resolveOwnershipRoot(options.rootDir)
  const now = options.now ?? Date.now
  const enabled = options.enabled ?? !isDisabledByEnv()
  const log = options.log ?? (() => {})
  const system = resolveSystem(options)
  const graceMs = options.graceMs ?? DEFAULT_CLEANUP_GRACE_MS
  const holdGraceMs = options.holdGraceMs ?? DEFAULT_HOLD_GRACE_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const aiJobBin = options.aiJobBin ?? DEFAULT_AI_JOB_BIN
  const stopAiJobSync = options.stopAiJobSync ?? stopAiJobScopeSync
  const owner = resolveOwner(options, now)
  const records = new Map<string, TaskProcessRecord>()
  const inFlight = new Map<string, Promise<TaskProcessCleanup>>()

  function emit(taskID: string, event: string, fields: Record<string, unknown> = {}): void {
    const detail = { session_id: taskID, ...fields }
    log(`[task-process-ownership] ${event}`, detail)
    options.audit?.write(taskID, { subsystem: "process_ownership", event, ...fields })
  }

  function persist(): void {
    if (!enabled) return
    writeOwnerFile(rootDir, owner, records.values())
  }

  function setRecord(record: TaskProcessRecord): void {
    records.set(record.id, record)
  }

  function finishCleanup(
    record: TaskProcessRecord,
    cleanup: TaskProcessCleanup,
    track = true,
  ): TaskProcessCleanup {
    if (track) {
      const updated: TaskProcessRecord = {
        ...record,
        state: cleanup.ok ? "cleaned" : "cleanup_failed",
        cleanup,
        updatedAtMs: now(),
      }
      setRecord(updated)
    }
    emit(record.taskID, cleanup.ok ? "task_process_cleanup_completed" : "task_process_cleanup_failed", {
      record_id: record.id,
      scope: scopeLabel(record.scope),
      reason: cleanup.reason,
      signals: cleanup.signals,
      remaining_pids: cleanup.remainingPids,
      detail: cleanup.detail ?? null,
    })
    if (!cleanup.ok) {
      appendAlert(rootDir, {
        timestamp: new Date(now()).toISOString(),
        event: "task_process_cleanup_failed",
        task_id: record.taskID,
        record_id: record.id,
        owner_pid: owner.pid,
        owner_instance: owner.instanceID,
        scope: scopeLabel(record.scope),
        reason: cleanup.reason,
        signals: cleanup.signals,
        remaining_pids: cleanup.remainingPids,
        detail: cleanup.detail ?? null,
      })
    }
    return cleanup
  }

  async function performCleanup(
    record: TaskProcessRecord,
    reason: string,
    cleanupGraceMs: number,
  ): Promise<TaskProcessCleanup> {
    emit(record.taskID, "task_process_cleanup_started", {
      record_id: record.id,
      scope: scopeLabel(record.scope),
      reason,
    })
    const startedAtMs = now()
    let outcome: Awaited<ReturnType<typeof cleanupScope>>
    try {
      outcome = await cleanupScope(record, { system, aiJobBin, graceMs: cleanupGraceMs, pollMs })
    } catch (error) {
      outcome = {
        ok: false,
        signals: [],
        remainingPids: [],
        detail: `cleanup-error:${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return {
      reason,
      startedAtMs,
      finishedAtMs: now(),
      ok: outcome.ok,
      signals: outcome.signals,
      remainingPids: outcome.remainingPids,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    }
  }

  async function cleanupRecord(record: TaskProcessRecord, reason: string, cleanupGraceMs: number): Promise<TaskProcessCleanup> {
    const existing = inFlight.get(record.id)
    if (existing) return existing
    const promise = (async () => {
      const cleanup = await performCleanup(record, reason, cleanupGraceMs)
      const finished = finishCleanup(record, cleanup)
      persist()
      return finished
    })().finally(() => {
      inFlight.delete(record.id)
    })
    inFlight.set(record.id, promise)
    return promise
  }

  async function runTaskCleanup(
    taskID: string,
    reason: string,
    cleanupGraceMs: number,
  ): Promise<TaskCleanupSummary> {
    if (!enabled) return emptySummary(taskID, reason)
    const targets = [...records.values()].filter(
      (record) => record.taskID === taskID && !TERMINAL_STATES.has(record.state),
    )
    const outcomes = await Promise.all(
      targets.map((record) => cleanupRecord(record, reason, cleanupGraceMs)),
    )
    persist()
    return {
      taskID,
      reason,
      attempted: targets.length,
      cleaned: outcomes.filter((outcome) => outcome.ok).length,
      failed: outcomes.filter((outcome) => !outcome.ok).length,
      outcomes,
    }
  }

  function registerAiJob(input: RegisterAiJobInput): AiJobRegistration | undefined {
    if (!enabled) return undefined
    if (input.taskID.length === 0) throw new Error("task-process-ownership: taskID is required")
    if (!JOB_TYPES.has(input.jobType)) {
      throw new Error(`task-process-ownership: unsupported job type ${input.jobType}`)
    }
    if (!ALLOWED_AI_JOB_SLICES.includes(input.slice)) {
      throw new Error(`task-process-ownership: unsupported slice ${input.slice}`)
    }
    const unit = `ai-${input.jobType}-${randomBytes(3).toString("hex")}.service`
    const marker = randomBytes(12).toString("hex")
    const scope: AiJobScope = { kind: "ai-job", unit, slice: input.slice, marker }
    const commandPrefix = [
      `export OMO_TASK_OWNER=${marker}`,
      `OMO_TASK_SESSION=${shellQuote(input.taskID)}`,
      `OMO_TASK_CALL=${shellQuote(input.callID ?? "")}; `,
    ].join(" ")
    const record = buildRecord({
      taskID: input.taskID,
      callID: input.callID,
      label: input.label,
      scope,
      command: input.command,
      timeoutSec: input.timeoutSec,
      nowMs: now(),
    })
    setRecord(record)
    persist()
    emit(input.taskID, "task_process_registered", {
      record_id: record.id,
      scope: scopeLabel(scope),
      timeout_sec: input.timeoutSec,
    })
    return { record, binding: { unitName: unit, marker, commandPrefix } }
  }

  function registerProcessGroup(input: RegisterProcessGroupInput): TaskProcessRecord | undefined {
    if (!enabled) return undefined
    const identity = system.readIdentity(input.pid)
    if (!isLiveIdentity(identity)) return undefined
    const self = system.readIdentity(process.pid)
    if (self !== undefined && self.pgid === identity.pgid) return undefined
    const scope: ProcessGroupScope = {
      kind: "process-group",
      pgid: identity.pgid,
      leaderPid: identity.pid,
      leaderStartTime: identity.startTime,
      members: system.listGroupMembers(identity.pgid).map((member) => ({
        pid: member.pid,
        startTime: member.startTime,
      })),
    }
    const record = buildRecord({
      taskID: input.taskID,
      callID: input.callID,
      label: input.label,
      scope,
      command: input.command ?? "",
      nowMs: now(),
    })
    setRecord(record)
    persist()
    emit(input.taskID, "task_process_registered", {
      record_id: record.id,
      scope: scopeLabel(scope),
    })
    return record
  }

  async function finishCall(taskID: string, callID: string): Promise<void> {
    if (!enabled || callID.length === 0) return
    const targets = [...records.values()].filter(
      (record) => record.taskID === taskID && record.callID === callID
        && record.scope.kind === "ai-job" && record.state === "registered",
    )
    for (const record of targets) {
      if (record.scope.kind !== "ai-job") continue
      const active = await showActiveState(system, record.scope.unit)
      if (active) {
        await cleanupRecord(record, "tool-finished-scope-active", graceMs)
        continue
      }
      const updated: TaskProcessRecord = { ...record, state: "completed", updatedAtMs: now() }
      setRecord(updated)
      emit(taskID, "task_process_scope_finished", {
        record_id: record.id,
        scope: scopeLabel(record.scope),
        reason: "observed-inactive",
      })
    }
    persist()
  }

  async function reconcileOwn(): Promise<boolean> {
    let changed = false
    const current = now()
    for (const record of [...records.values()]) {
      if (record.state === "registered" && record.scope.kind === "ai-job") {
        const active = await showActiveState(system, record.scope.unit)
        if (!active) {
          setRecord({ ...record, state: "completed", updatedAtMs: current })
          changed = true
        }
      }
      if (record.state === "registered" && record.scope.kind === "process-group") {
        if (groupLiveMembers(system, record.scope).length === 0) {
          setRecord({ ...record, state: "completed", updatedAtMs: current })
          changed = true
        }
      }
      if (TERMINAL_STATES.has(record.state) && current - record.updatedAtMs > 3_600_000) {
        records.delete(record.id)
        changed = true
      }
    }
    if (changed) persist()
    return changed
  }

  async function enforceTimeouts(): Promise<void> {
    const current = now()
    for (const record of [...records.values()]) {
      if (record.state !== "registered" || record.scope.kind !== "ai-job") continue
      const timeoutMs = Math.max(record.timeoutSec ?? 1800, 1) * 1000
      if (current - record.createdAtMs <= timeoutMs + 120_000) continue
      const active = await showActiveState(system, record.scope.unit)
      if (active) await cleanupRecord(record, "timeout", graceMs)
    }
  }

  async function recover(): Promise<number> {
    if (!enabled) return 0
    let recovered = 0
    for (const path of listOwnerFilePaths(rootDir)) {
      const file = readOwnerFile(path)
      if (!file) {
        removeOwnerFile(path)
        continue
      }
      if (file.owner.instanceID === owner.instanceID) continue
      const alive = system.readIdentity(file.owner.pid)
      if (alive !== undefined && alive.startTime === file.owner.startTime) continue
      const retained: TaskProcessRecord[] = []
      for (const record of Object.values(file.records)) {
        if (TERMINAL_STATES.has(record.state)) continue
        const cleanup = await performCleanup(record, "orphan-recovery", graceMs)
        finishCleanup(record, cleanup, false)
        emit(record.taskID, "task_process_orphan_recovered", {
          record_id: record.id,
          scope: scopeLabel(record.scope),
          owner_pid: file.owner.pid,
          owner_start_time: file.owner.startTime,
          cleaned: cleanup.ok,
          remaining_pids: cleanup.remainingPids,
          detail: cleanup.detail ?? null,
        })
        recovered += 1
        if (!cleanup.ok) {
          retained.push({
            ...record,
            state: "cleanup_failed",
            cleanup,
            updatedAtMs: now(),
          })
        }
      }
      if (retained.length === 0) removeOwnerFile(path)
      else writeOwnerFile(rootDir, file.owner, retained)
    }
    await reconcileOwn()
    return recovered
  }

  async function sweep(): Promise<void> {
    if (!enabled) return
    try {
      await recover()
      await enforceTimeouts()
      persist()
    } catch (error) {
      log("[task-process-ownership] sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function dispose(): Promise<void> {
    if (!enabled) return
    const targets = [...records.values()].filter((record) => !TERMINAL_STATES.has(record.state))

    // Synchronous prefix: the host may exit immediately after this call starts.
    // Verified ai-job stops happen before the first await; process-group TERM is
    // also synchronous, with the async pass providing the bounded KILL.
    const stoppedSync = new Set<string>()
    for (const record of targets) {
      if (record.scope.kind === "ai-job") {
        const sync = stopAiJobSync(record.scope, { aiJobBin })
        if (sync.ok) {
          stoppedSync.add(record.id)
          const cleanup: TaskProcessCleanup = {
            reason: "shutdown",
            startedAtMs: now(),
            finishedAtMs: now(),
            ok: true,
            signals: ["SIGTERM", "SIGKILL"],
            remainingPids: [],
            detail: sync.detail,
          }
          finishCleanup(record, cleanup)
        } else {
          log("[task-process-ownership] synchronous shutdown stop refused", {
            record_id: record.id,
            scope: scopeLabel(record.scope),
            detail: sync.detail,
          })
        }
      } else {
        const self = system.readIdentity(process.pid)
        if (self === undefined || self.pgid !== record.scope.pgid) {
          system.signal(-record.scope.pgid, "SIGTERM")
        }
      }
    }
    persist()

    await Promise.all(
      targets
        .filter((record) => !stoppedSync.has(record.id))
        .map((record) => cleanupRecord(record, "shutdown", Math.min(graceMs, 2_000))),
    )
    persist()
    if ([...records.values()].every((record) => TERMINAL_STATES.has(record.state))) {
      removeOwnerFile(ownerFilePath(rootDir, owner.instanceID))
    }
  }

  async function holdTask(taskID: string, reason: string): Promise<TaskCleanupSummary> {
    const summary = await runTaskCleanup(taskID, `hold:${reason}`, holdGraceMs)
    if (enabled) {
      emit(taskID, "task_process_quiesced_on_hold", {
        reason,
        attempted: summary.attempted,
        cleaned: summary.cleaned,
        failed: summary.failed,
      })
    }
    return summary
  }

  if (enabled) {
    try {
      if (!existsSync(rootDir)) {
        writeOwnerFile(rootDir, owner, [])
      }
    } catch (error) {
      log("[task-process-ownership] registry init failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    enabled,
    rootDir,
    registerAiJob,
    registerProcessGroup,
    finishCall,
    cleanupTask: (taskID, reason) => runTaskCleanup(taskID, reason, graceMs),
    holdTask,
    recover,
    sweep,
    dispose,
    snapshot: () => [...records.values()].map((record) => ({ ...record })),
  }
}

function resolveSystem(options: TaskProcessOwnershipOptions): OwnershipSystem {
  const base = createDefaultOwnershipSystem()
  const runCommand: CommandRunner = options.system?.runCommand ?? base.runCommand
  const signal: SignalSender = options.system?.signal ?? base.signal
  return {
    readIdentity: options.system?.readIdentity ?? base.readIdentity,
    listGroupMembers: options.system?.listGroupMembers ?? base.listGroupMembers,
    signal,
    runCommand,
    sleep: options.system?.sleep ?? base.sleep,
  }
}

function resolveOwner(options: TaskProcessOwnershipOptions, now: () => number): TaskProcessOwner {
  const pid = options.owner?.pid ?? process.pid
  const identity = readSelfIdentity()
  const startTime = options.owner?.startTime ?? (pid === process.pid ? identity?.startTime : undefined) ?? "0"
  return {
    instanceID: options.owner?.instanceID ?? randomBytes(12).toString("hex"),
    pid,
    startTime,
    startedAtMs: options.owner?.startedAtMs ?? now(),
  }
}

function buildRecord(input: {
  taskID: string
  callID?: string
  label?: string
  scope: TaskProcessScope
  command: string
  timeoutSec?: number
  nowMs: number
}): TaskProcessRecord {
  const key = input.scope.kind === "ai-job" ? input.scope.unit : String(input.scope.pgid)
  return {
    id: `${input.taskID}:${input.callID ?? "-"}:${input.scope.kind}:${key}`,
    taskID: input.taskID,
    ...(input.callID === undefined ? {} : { callID: input.callID }),
    ...(input.label === undefined ? {} : { label: input.label }),
    scope: input.scope,
    commandFingerprint: fingerprint(input.command),
    ...(input.timeoutSec === undefined ? {} : { timeoutSec: input.timeoutSec }),
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    state: "registered",
  }
}

function fingerprint(command: string): string {
  if (command.length === 0) return "unknown"
  return createHash("sha256").update(command).digest("hex").slice(0, 16)
}

function scopeLabel(scope: TaskProcessScope): string {
  return scope.kind === "ai-job" ? scope.unit : `pgid:${scope.pgid}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function showActiveState(system: OwnershipSystem, unit: string): Promise<boolean> {
  const result = await system.runCommand(["systemctl", "show", "-p", "ActiveState", "--value", unit])
  if (result.code !== 0) return false
  const state = result.stdout.trim()
  return state === "active" || state === "activating" || state === "deactivating" || state === "reloading"
}

function groupLiveMembers(system: OwnershipSystem, scope: ProcessGroupScope): number[] {
  const live: number[] = []
  for (const member of scope.members) {
    const current = system.readIdentity(member.pid)
    if (current !== undefined && current.startTime === member.startTime && current.state !== "Z") {
      live.push(member.pid)
    }
  }
  return live
}

function emptySummary(taskID: string, reason: string): TaskCleanupSummary {
  return { taskID, reason, attempted: 0, cleaned: 0, failed: 0, outcomes: [] }
}

function isDisabledByEnv(): boolean {
  const raw = process.env[DISABLE_ENV]
  if (!raw) return false
  return new Set(["1", "true", "yes", "on"]).has(raw.trim().toLowerCase())
}
