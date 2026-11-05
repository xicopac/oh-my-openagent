import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

const rootManifestUrl = new URL("../package.json", import.meta.url)

export function parseBunPackageManager(value) {
  if (typeof value !== "string") {
    throw new Error("package.json must declare an exact Bun packageManager such as bun@1.4.3")
  }
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(value)
  if (match?.[1] === undefined) {
    throw new Error("package.json must declare an exact Bun packageManager such as bun@1.4.3")
  }
  return match[1]
}

export function expectedBunVersion() {
  const manifest = JSON.parse(readFileSync(rootManifestUrl, "utf8"))
  return parseBunPackageManager(manifest.packageManager)
}

export function assertBunVersion(actual, expected = expectedBunVersion(), context = "tracked generator") {
  const observed = typeof actual === "string" && actual.length > 0 ? actual : "not Bun"
  if (observed !== expected) {
    throw new Error(`${context} requires Bun ${expected}; current Bun is ${observed}. Use the packageManager-pinned toolchain before building.`)
  }
  return observed
}

export function assertCurrentBunVersion(context = "tracked generator") {
  return assertBunVersion(process.versions.bun, expectedBunVersion(), context)
}

export function assertBunExecutableVersion(
  executable,
  expected = expectedBunVersion(),
  context = "tracked generator",
  spawn = spawnSync,
) {
  const result = spawn(executable, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error !== undefined) {
    throw new Error(`${context} could not execute ${executable}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = typeof result.stderr === "string" ? result.stderr.trim() : ""
    throw new Error(`${context} could not read ${executable} --version${detail === "" ? "" : `: ${detail}`}`)
  }
  const actual = typeof result.stdout === "string"
    ? result.stdout.trim()
    : Buffer.from(result.stdout ?? []).toString().trim()
  return assertBunVersion(actual, expected, context)
}
