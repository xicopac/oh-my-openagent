import * as fs from "node:fs"

export const AI_CONTROL_SLICE_MARKER = "/ai.slice/ai-control.slice/"

let cachedCgroup: string | undefined

export function readOwnCgroup(): string {
  try {
    const data = fs.readFileSync("/proc/self/cgroup", "utf8")
    return data.trim()
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""
    throw error
  }
}

function getOwnCgroup(): string {
  if (cachedCgroup !== undefined) return cachedCgroup
  cachedCgroup = readOwnCgroup()
  return cachedCgroup
}

export function isInsideControlSlice(cgroupPath?: string): boolean {
  const text = cgroupPath !== undefined ? cgroupPath : getOwnCgroup()
  return text.includes(AI_CONTROL_SLICE_MARKER)
}

export function __resetOwnCgroupCacheForTests(): void {
  cachedCgroup = undefined
}
