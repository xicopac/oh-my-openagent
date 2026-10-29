export {
  ALLOWED_AI_JOB_SLICES,
  DEFAULT_AI_JOB_BIN,
  DEFAULT_CLEANUP_GRACE_MS,
  DEFAULT_HOLD_GRACE_MS,
  cleanupAiJobScope,
  cleanupProcessGroupScope,
  cleanupScope,
  createDefaultOwnershipSystem,
} from "./scope"

export {
  createTaskProcessOwnership,
} from "./ownership"
export type {
  AiJobBinding,
  AiJobRegistration,
  RegisterAiJobInput,
  RegisterProcessGroupInput,
  TaskProcessOwnership,
  TaskProcessOwnershipOptions,
} from "./ownership"

export {
  alertsFilePath,
  listOwnerFilePaths,
  ownerFilePath,
  readOwnerFile,
  resolveOwnershipRoot,
  writeOwnerFile,
} from "./registry"

export {
  identityMatches,
  isLiveIdentity,
  listProcessGroupMembers,
  parseProcessStat,
  readProcessIdentity,
  readSelfIdentity,
} from "./identity"

export type {
  AiJobScope,
  CommandRunner,
  CommandResult,
  OwnerFile,
  OwnershipSystem,
  ProcessGroupMember,
  ProcessGroupScope,
  ProcessIdentity,
  ScopeCleanupOutcome,
  SignalSender,
  TaskCleanupSummary,
  TaskProcessCleanup,
  TaskProcessOwner,
  TaskProcessRecord,
  TaskProcessRecordState,
  TaskProcessScope,
} from "./types"
