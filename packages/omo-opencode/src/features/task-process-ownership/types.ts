/**
 * Durable task-owned process scope records.
 *
 * A record links one disposable OS scope (an ai-job systemd unit or a detached
 * process group) to the task that owns it. Records are written before the
 * scope is launched and are the only authority used by cleanup/recovery, so a
 * plugin crash or PID reuse cannot turn cleanup into a blind kill.
 */

export type TaskProcessOwner = {
  readonly instanceID: string
  readonly pid: number
  readonly startTime: string
  readonly startedAtMs: number
}

export type AiJobScope = {
  readonly kind: "ai-job"
  readonly unit: string
  readonly slice: string
  readonly marker: string
}

export type ProcessGroupMember = {
  readonly pid: number
  readonly startTime: string
}

export type ProcessGroupScope = {
  readonly kind: "process-group"
  readonly pgid: number
  readonly leaderPid: number
  readonly leaderStartTime: string
  readonly members: readonly ProcessGroupMember[]
}

export type TaskProcessScope = AiJobScope | ProcessGroupScope

export type TaskProcessRecordState =
  | "registered"
  | "cleanup_started"
  | "cleaned"
  | "cleanup_failed"
  | "completed"

export type TaskProcessCleanup = {
  readonly reason: string
  readonly startedAtMs: number
  readonly finishedAtMs: number
  readonly ok: boolean
  readonly signals: readonly string[]
  readonly remainingPids: readonly number[]
  readonly detail?: string
}

export type TaskProcessRecord = {
  readonly id: string
  readonly taskID: string
  readonly callID?: string
  readonly label?: string
  readonly scope: TaskProcessScope
  readonly commandFingerprint: string
  readonly timeoutSec?: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly state: TaskProcessRecordState
  readonly cleanup?: TaskProcessCleanup
}

export type OwnerFile = {
  readonly version: 1
  readonly owner: TaskProcessOwner
  readonly records: Record<string, TaskProcessRecord>
}

export type ProcessIdentity = {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly startTime: string
  readonly state: string
  readonly comm: string
}

export type CommandResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type CommandRunner = (
  argv: readonly string[],
  opts?: { readonly timeoutMs?: number },
) => Promise<CommandResult>

export type SignalSender = (pid: number, signal: NodeJS.Signals) => void

export type OwnershipSystem = {
  readonly readIdentity: (pid: number) => ProcessIdentity | undefined
  readonly listGroupMembers: (pgid: number) => ProcessIdentity[]
  readonly signal: SignalSender
  readonly runCommand: CommandRunner
  readonly sleep: (ms: number) => Promise<void>
}

export type ScopeCleanupOutcome = {
  readonly ok: boolean
  readonly signals: readonly string[]
  readonly remainingPids: readonly number[]
  readonly detail?: string
}

export type TaskCleanupSummary = {
  readonly taskID: string
  readonly reason: string
  readonly attempted: number
  readonly cleaned: number
  readonly failed: number
  readonly outcomes: readonly TaskProcessCleanup[]
}
