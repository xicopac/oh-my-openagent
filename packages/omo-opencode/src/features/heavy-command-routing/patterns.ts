import type { ResourceClass } from "./classify"

type HeavyResourceClass = Exclude<ResourceClass, "light">

const BUILD_SCRIPT_RE = /typecheck|build|check|compile/i
const TEST_SCRIPT_RE = /test|e2e/i
const DIRECT_BUILD_TOOLS = new Set(["tsgo", "tsc", "tsc-esm"])
const MAKE_PROBES = new Set(["--version", "--help", "-v", "-n", "-q", "-h", "--dry-run", "--question"])
const MAKE_TESTS = new Set(["test", "check", "lint", "fmt", "verify"])
const LIGHT_ADB_ARGS = new Set(["devices", "version", "help", "--version", "kill-server", "reconnect"])

function isFlagsOnly(args: readonly string[]): boolean {
  return args.length === 0 || args.every((arg) => arg.startsWith("-"))
}

function hasExactArg(args: readonly string[], values: ReadonlySet<string>): boolean {
  return args.some((arg) => values.has(arg.toLowerCase()))
}

function classifyBunLike(args: readonly string[]): HeavyResourceClass | null {
  if (isFlagsOnly(args)) return null

  const first = args[0]?.toLowerCase() ?? ""
  const second = args[1] ?? ""
  if (DIRECT_BUILD_TOOLS.has(first)) return "build"
  if (first === "run") {
    if (BUILD_SCRIPT_RE.test(second)) return "build"
    if (TEST_SCRIPT_RE.test(second)) return "test"
    return "heavy"
  }
  if (first === "build") return "build"
  if (first === "test") return "test"
  if (new Set(["install", "add", "remove", "update", "x", "dlx", "link"]).has(first)) return "heavy"
  return "heavy"
}

function classifyNpmLike(args: readonly string[]): HeavyResourceClass | null {
  if (isFlagsOnly(args)) return null

  const first = args[0]?.toLowerCase() ?? ""
  const second = args[1] ?? ""
  if (first === "run") {
    if (BUILD_SCRIPT_RE.test(second)) return "build"
    if (/test|e2e|lint/i.test(second)) return "test"
    return "heavy"
  }
  if (first === "test") return "test"
  if (new Set(["build", "dist", "pack", "prepare"]).has(first)) return "build"
  if (new Set(["install", "ci", "add", "exec", "dlx", "start", "dev"]).has(first)) return "heavy"
  return null
}

function classifyTurbo(args: readonly string[]): HeavyResourceClass | null {
  const first = args[0]?.toLowerCase() ?? ""
  if (!first || first.startsWith("--")) return null
  if (first === "test") return "test"
  if (first === "run") {
    const script = args[1]?.toLowerCase() ?? ""
    if (/build|typecheck|check|dev|lint/.test(script)) return "build"
    if (script.includes("test")) return "test"
    return "build"
  }
  if (new Set(["build", "typecheck", "check", "dev", "lint"]).has(first)) return "build"
  return "build"
}

function classifyMakeLike(args: readonly string[]): HeavyResourceClass | null {
  if (hasExactArg(args, MAKE_PROBES)) return null
  if (hasExactArg(args, MAKE_TESTS)) return "test"
  return "build"
}

function classifyCargoGo(args: readonly string[]): HeavyResourceClass | null {
  if (isFlagsOnly(args)) return null
  const first = args[0]?.toLowerCase() ?? ""
  if (new Set(["test", "check", "fmt", "vet"]).has(first)) return "test"
  if (new Set(["build", "run", "install"]).has(first)) return "build"
  return "heavy"
}

function classifyMavenLike(args: readonly string[]): HeavyResourceClass | null {
  if (isFlagsOnly(args)) return null
  if (args.some((arg) => /test|tests|check|lint|fmt|verify/i.test(arg))) return "test"
  if (args.some((arg) => /build|compile|package|install|jar|war|--release/i.test(arg))) return "build"
  return "heavy"
}

function classifyEmulatorLike(args: readonly string[]): HeavyResourceClass | null {
  return isFlagsOnly(args) ? null : "emulator"
}

export function classifyToolSegment(tool: string, args: readonly string[]): HeavyResourceClass | null {
  const normalizedTool = (tool.startsWith("./") ? tool.slice(2) : tool).toLowerCase()
  if (DIRECT_BUILD_TOOLS.has(normalizedTool)) return "build"
  if (new Set(["bun", "bunx"]).has(normalizedTool)) return classifyBunLike(args)
  if (normalizedTool === "npx" && DIRECT_BUILD_TOOLS.has(args[0]?.toLowerCase() ?? "")) return "build"
  if (new Set(["npm", "npx", "pnpm", "yarn"]).has(normalizedTool)) return classifyNpmLike(args)
  if (normalizedTool === "turbo") return classifyTurbo(args)
  if (new Set(["gradle", "gradlew"]).has(normalizedTool)) return isFlagsOnly(args) ? null : "gradle"
  if (new Set(["make", "cmake", "ninja", "meson"]).has(normalizedTool)) return classifyMakeLike(args)
  if (new Set(["cargo", "go"]).has(normalizedTool)) return classifyCargoGo(args)
  if (new Set(["mvn", "mvnw", "ant", "sbt", "javac", "cc", "gcc", "g++", "clang", "clang++", "rustc"]).has(normalizedTool)) {
    return classifyMavenLike(args)
  }
  if (new Set(["jest", "vitest", "mocha", "ava", "pytest", "playwright"]).has(normalizedTool)) return "test"
  if (new Set(["next", "vite", "webpack"]).has(normalizedTool)) {
    return hasExactArg(args, new Set(["build"])) ? "build" : "heavy"
  }
  if (
    normalizedTool === "emulator"
    || normalizedTool.startsWith("qemu-system-")
    || new Set(["avdmanager", "sdkmanager"]).has(normalizedTool)
  ) {
    return classifyEmulatorLike(args)
  }
  if (normalizedTool === "adb") {
    return args.length === 0 || hasExactArg(args, LIGHT_ADB_ARGS) ? null : "emulator"
  }
  return null
}

export const PRIORITY: Record<HeavyResourceClass, number> = {
  gradle: 5,
  build: 4,
  test: 3,
  emulator: 2,
  heavy: 1,
}
