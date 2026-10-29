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
  terminalReason?: string
  result?: string
  resultTruncated?: boolean
  attempts?: number
  recoveryEpisodeID?: string
  notificationQueuedAt?: string
  notificationDeliveredAt?: string
}

export type WorkerRecordPatch = Partial<Omit<WorkerRecord, "schemaVersion" | "workerID" | "createdAt">>

export type WorkerRecordStore = {
  readonly rootDir: string
  save(record: WorkerRecord): boolean
  update(workerID: string, patch: WorkerRecordPatch): WorkerRecord | undefined
  get(workerID: string): WorkerRecord | undefined
  list(): WorkerRecord[]
  markNotificationQueued(workerID: string, at?: Date): void
  markNotificationDelivered(workerID: string, at?: Date): void
  prune(maxAgeMs: number, now?: Date): number
}

export type WorkerRecordStoreOptions = {
  rootDir?: string
  now?: () => Date
  maxResultChars?: number
}

