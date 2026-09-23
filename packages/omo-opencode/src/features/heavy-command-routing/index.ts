export type { ResourceClass, NormalizedCommand } from "./classify"
export { classifyResourceCommand, normalizeShellCommand } from "./classify"

export {
  AI_EMULATOR_SLICE,
  AI_JOB_BIN,
  AI_WORK_SLICE,
  DEFAULT_TIMEOUT_SEC,
  buildAiJobCommand,
  decideHeavyCommandRouting,
  resolveTimeoutSec,
  shellSingleQuote,
} from "./router"
export type { JobType, RoutingDecision, RoutingDeps } from "./router"

export {
  AI_CONTROL_SLICE_MARKER,
  __resetOwnCgroupCacheForTests,
  isInsideControlSlice,
  readOwnCgroup,
} from "./cgroup"
