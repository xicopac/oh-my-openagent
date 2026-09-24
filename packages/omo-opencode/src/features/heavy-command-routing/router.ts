import { classifyResourceCommand, normalizeShellCommand, stripGnuTimeout } from "./classify"
import type { ResourceClass } from "./classify"

export const AI_JOB_BIN = "/usr/local/bin/ai-job"
export const AI_WORK_SLICE = "ai-work.slice"
export const AI_EMULATOR_SLICE = "ai-emulator.slice"
export const DEFAULT_TIMEOUT_SEC = 1800

export type JobType = "build" | "test" | "gradle" | "heavy" | "emulator"

export type RoutingDecision =
  | { readonly action: "direct"; readonly reason: string }
  | {
    readonly action: "rewrite"
    readonly command: string
    readonly kind: ResourceClass
    readonly type: JobType
    readonly slice: string
    readonly timeoutSec: number
  }
  | { readonly action: "refuse"; readonly reason: string }

export interface RoutingDeps {
  readonly classify?: (command: string) => ResourceClass
  readonly aiJobAvailable?: boolean
  readonly inControlSlice?: boolean
  readonly bashToolTimeoutMs?: number
  readonly aiJobBin?: string
}

const RESOURCE_CLASS_TO_JOB_TYPE: Record<ResourceClass, JobType | "n/a"> = {
  light: "n/a",
  build: "build",
  test: "test",
  gradle: "gradle",
  emulator: "emulator",
  heavy: "heavy",
}

function jobTypeFor(kind: ResourceClass): JobType {
  const type = RESOURCE_CLASS_TO_JOB_TYPE[kind]
  if (type === "n/a") throw new Error(`[routing] ${kind} commands do not have an ai-job type`)
  return type
}

export function resolveTimeoutSec(
  normalizedTimeoutSec: number | undefined,
  bashToolTimeoutMs: number | undefined,
): number {
  if (normalizedTimeoutSec !== undefined) {
    return Math.min(normalizedTimeoutSec, 86400)
  }
  if (typeof bashToolTimeoutMs === "number" && bashToolTimeoutMs > 0) {
    return Math.min(Math.max(1, Math.ceil(bashToolTimeoutMs / 1000)), 86400)
  }
  return DEFAULT_TIMEOUT_SEC
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function buildAiJobCommand(
  kind: ResourceClass,
  command: string,
  timeoutSec: number,
  opts?: { readonly aiJobBin?: string },
): string {
  const type = jobTypeFor(kind)
  const slice = kind === "emulator" ? AI_EMULATOR_SLICE : AI_WORK_SLICE
  // Keep env/bash-c/cd prefixes; strip only the GNU timeout (RuntimeMaxSec is authoritative).
  const inner = stripGnuTimeout(command)
  const escaped = shellSingleQuote(inner)
  const bin = opts?.aiJobBin ?? AI_JOB_BIN
  const timeoutFlag = kind === "emulator" ? "--timeout 0" : `--timeout ${Math.round(timeoutSec)}`
  const diagnostic = `printf '[ai-routing] class=%s type=%s slice=%s\\n' ${kind.toUpperCase()} ${type} ${slice}`
  return `${diagnostic} && ${bin} run ${type} ${timeoutFlag} -- /bin/bash -lc ${escaped}`
}

export function decideHeavyCommandRouting(command: string, deps?: RoutingDeps): RoutingDecision {
  if (deps?.inControlSlice !== true) {
    return { action: "direct", reason: "not-in-control-slice" }
  }

  const kind = (deps?.classify ?? classifyResourceCommand)(command)
  if (kind === "light") return { action: "direct", reason: "light" }
  if (deps?.aiJobAvailable === false) {
    return { action: "direct", reason: "ai-job-unavailable-fallback" }
  }

  const normalized = normalizeShellCommand(command)
  const timeoutSec = resolveTimeoutSec(normalized.timeoutSec, deps?.bashToolTimeoutMs)
  const type = jobTypeFor(kind)
  const slice = kind === "emulator" ? AI_EMULATOR_SLICE : AI_WORK_SLICE
  return {
    action: "rewrite",
    command: buildAiJobCommand(kind, command, timeoutSec, { aiJobBin: deps?.aiJobBin }),
    kind,
    type,
    slice,
    timeoutSec,
  }
}
