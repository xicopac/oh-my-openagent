export type WorkerRecordState =
  | "dispatched"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stalled"
  | "cancelled"
  | "blocked"

export type WorkerTerminalOutcome = "completed" | "failed" | "stalled" | "cancelled" | "blocked"
export type WorkerWakeState = "pending" | "dispatched" | "acknowledged"

export type WorkerRecordModel = {
  providerID: string
  modelID: string
  variant?: string
}

export type WorkerRecord = {
  schemaVersion: 1
  workerID: string
  sessionID?: string
  parentSessionID: string
  parentMessageID?: string
  rootSessionID?: string
  agent: string
  description: string
  model?: WorkerRecordModel
  state: WorkerRecordState
  createdAt: string
  dispatchedAt?: string
  startedAt?: string
  updatedAt: string
  terminalAt?: string
  terminalOutcome?: WorkerTerminalOutcome
  terminalEventID?: string
  terminalAttemptID?: string
  terminalReason?: string
  result?: string
  resultTruncated?: boolean
  attempts?: number
  recoveryEpisodeID?: string
  wakeEventID?: string
  wakeState?: WorkerWakeState
  wakePendingAt?: string
  wakeDispatchedAt?: string
  wakeAcknowledgedAt?: string
  /** Legacy compatibility: actual in-memory queue insertion time. */
  notificationQueuedAt?: string
  /** Legacy compatibility: now written only when parent output acknowledges the wake. */
  notificationDeliveredAt?: string
}

export type WorkerRecordPatch = Partial<Omit<WorkerRecord, "schemaVersion" | "workerID" | "createdAt">>

export type WorkerTerminalTransition = {
  state: Extract<WorkerRecordState, "completed" | "failed" | "stalled" | "cancelled" | "blocked">
  terminalOutcome: WorkerTerminalOutcome
  terminalAt: string
  terminalAttemptID?: string
  terminalReason?: string
  result?: string
  attempts?: number
  recoveryEpisodeID?: string
}

export type WorkerTerminalTransitionResult = {
  record: WorkerRecord
  committed: boolean
}

export type WorkerRecordStore = {
  readonly rootDir: string
  save(record: WorkerRecord): boolean
  update(workerID: string, patch: WorkerRecordPatch): WorkerRecord | undefined
  terminalize(workerID: string, transition: WorkerTerminalTransition): WorkerTerminalTransitionResult | undefined
  get(workerID: string): WorkerRecord | undefined
  list(): WorkerRecord[]
  markNotificationQueued(workerID: string, at?: Date): void
  markWakeDispatched(workerID: string, at?: Date): void
  markWakeAcknowledged(workerID: string, at?: Date): void
  /** @deprecated Use markWakeAcknowledged; retained for older callers. */
  markNotificationDelivered(workerID: string, at?: Date): void
  prune(maxAgeMs: number, now?: Date): number
}

export type WorkerRecordStoreOptions = {
  rootDir?: string
  now?: () => Date
  maxResultChars?: number
  createEventID?: () => string
}

