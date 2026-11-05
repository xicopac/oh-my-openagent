#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { createReadStream, existsSync, readFileSync } from "node:fs"
import { copyFile, mkdir, rename, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { assertCurrentBunVersion } from "./bun-toolchain.mjs"

export const TRACKED_GENERATED_ARTIFACTS = [
  "packages/omo-codex/scripts/install-dist/install-local.mjs",
  "packages/omo-native/bin/lib/service-auth.generated.js",
  "packages/omo-senpi/plugin/extensions/gateway-rules-extension.mjs",
  "packages/omo-senpi/plugin/extensions/gateway-store-worker.mjs",
  "packages/omo-senpi/plugin/extensions/memory-run-supervisor.mjs",
  "packages/omo-senpi/plugin/extensions/omo-computer-use.js",
  "packages/omo-senpi/plugin/extensions/omo-member.js",
  "packages/omo-senpi/plugin/extensions/omo-memory-doctor.js",
  "packages/omo-senpi/plugin/extensions/omo-memory-memfs.js",
  "packages/omo-senpi/plugin/extensions/omo-memory-palace.js",
  "packages/omo-senpi/plugin/extensions/omo-side-panel.js",
  "packages/omo-senpi/plugin/extensions/omo-task.js",
  "packages/omo-senpi/plugin/extensions/omo-thread-client.js",
  "packages/omo-senpi/plugin/extensions/omo.js",
  "packages/omo-senpi/plugin/runtime/agent-toolkit-sdk/sdk.js",
  "packages/omo-senpi/plugin/runtime/rollback-migrate.js",
  "packages/omo-senpi/plugin/runtime/thread-sdk/sdk.js",
] as const

type FileIdentity = {
  path: string
  sha256: string
  size: number
}

export type ReleaseCandidateManifest = {
  schemaVersion: 1
  package: { name: string; version: string }
  commit: string
  rollbackTarget: string
  toolchain: { bun: string; node: string }
  lockfile: FileIdentity
  artifact: FileIdentity
  trackedGeneratedArtifacts: FileIdentity[]
  evidence: FileIdentity[]
}

type CliOptions = {
  rollbackTarget: string
  outputDir: string
  evidencePaths: string[]
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))

function git(repository: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, GIT_MASTER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

export function assertCleanCheckout(repository: string): void {
  const status = git(repository, ["status", "--porcelain", "--untracked-files=normal"])
  if (status !== "") {
    throw new Error(`release candidate requires a clean checkout; found:\n${status}`)
  }
}

export function parseReleaseCandidateArgs(args: readonly string[]): CliOptions {
  let rollbackTarget = ""
  let outputDir = ".omo/evidence/release-candidate"
  const evidencePaths: string[] = []

  for (const arg of args) {
    if (arg.startsWith("--rollback-target=")) rollbackTarget = arg.slice("--rollback-target=".length)
    else if (arg.startsWith("--output-dir=")) outputDir = arg.slice("--output-dir=".length)
    else if (arg.startsWith("--evidence=")) evidencePaths.push(arg.slice("--evidence=".length))
    else throw new Error(`unknown release-candidate argument: ${arg}`)
  }

  if (rollbackTarget.trim() === "") {
    throw new Error("--rollback-target=<commit> is required")
  }
  if (outputDir.trim() === "") throw new Error("--output-dir must not be empty")
  return { rollbackTarget, outputDir, evidencePaths }
}

export function versionedArtifactName(version: string, commit: string): string {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid package version: ${version}`)
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`invalid commit id: ${commit}`)
  return `oh-my-openagent-${version}-${commit.slice(0, 12)}.js`
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path)
    input.on("data", (chunk) => hash.update(chunk))
    input.on("end", resolvePromise)
    input.on("error", reject)
  })
  return hash.digest("hex")
}

function normalizedRelativePath(repository: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repository, path)
  const local = relative(repository, absolute)
  if (local === "" || local === ".." || local.startsWith("../") || local.startsWith("..\\") || isAbsolute(local)) {
    throw new Error(`path must stay inside the repository: ${path}`)
  }
  return local.replaceAll("\\", "/")
}

async function fileIdentity(repository: string, path: string): Promise<FileIdentity> {
  const local = normalizedRelativePath(repository, path)
  const absolute = join(repository, local)
  const metadata = await stat(absolute)
  if (!metadata.isFile()) throw new Error(`release input is not a file: ${local}`)
  return { path: local, sha256: await sha256(absolute), size: metadata.size }
}

export async function collectReleaseCandidateManifest(options: {
  repository: string
  packageName: string
  packageVersion: string
  commit: string
  rollbackTarget: string
  artifactPath: string
  evidencePaths?: readonly string[]
  bunVersion?: string
  nodeVersion?: string
}): Promise<ReleaseCandidateManifest> {
  const evidence = await Promise.all(
    [...(options.evidencePaths ?? [])].sort().map((path) => fileIdentity(options.repository, path)),
  )
  return {
    schemaVersion: 1,
    package: { name: options.packageName, version: options.packageVersion },
    commit: options.commit,
    rollbackTarget: options.rollbackTarget,
    toolchain: {
      bun: options.bunVersion ?? process.versions.bun ?? "not Bun",
      node: options.nodeVersion ?? process.versions.node,
    },
    lockfile: await fileIdentity(options.repository, "bun.lock"),
    artifact: await fileIdentity(options.repository, options.artifactPath),
    trackedGeneratedArtifacts: await Promise.all(
      TRACKED_GENERATED_ARTIFACTS.map((path) => fileIdentity(options.repository, path)),
    ),
    evidence,
  }
}

function runPinnedBuild(repository: string): void {
  const executableDirectory = dirname(process.execPath)
  const result = spawnSync(process.execPath, [join(repository, "script", "build.ts")], {
    cwd: repository,
    env: {
      ...process.env,
      PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      OMO_BUILD_JOBS: "1",
    },
    stdio: "inherit",
  })
  if (result.status !== 0) throw new Error(`release build failed with exit code ${result.status ?? "unknown"}`)
}

async function main(): Promise<void> {
  assertCurrentBunVersion("release candidate verifier")
  const options = parseReleaseCandidateArgs(process.argv.slice(2))
  const outputLocal = normalizedRelativePath(repositoryRoot, options.outputDir)
  if (outputLocal !== ".omo/evidence" && !outputLocal.startsWith(".omo/evidence/")) {
    throw new Error("release-candidate output must stay under .omo/evidence/")
  }
  for (const path of options.evidencePaths) {
    if (!existsSync(resolve(repositoryRoot, path))) throw new Error(`evidence file does not exist: ${path}`)
  }

  assertCleanCheckout(repositoryRoot)
  const commit = git(repositoryRoot, ["rev-parse", "HEAD"])
  const rollbackTarget = git(repositoryRoot, ["rev-parse", `${options.rollbackTarget}^{commit}`])
  if (commit === rollbackTarget) throw new Error("rollback target must differ from the release candidate commit")
  try {
    git(repositoryRoot, ["merge-base", "--is-ancestor", rollbackTarget, commit])
  } catch {
    throw new Error(`rollback target must be an ancestor of the release candidate: ${rollbackTarget}`)
  }
  runPinnedBuild(repositoryRoot)
  assertCleanCheckout(repositoryRoot)

  const packageManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    name?: unknown
    version?: unknown
  }
  if (typeof packageManifest.name !== "string" || typeof packageManifest.version !== "string") {
    throw new Error("package.json must contain string name and version fields")
  }

  const outputAbsolute = join(repositoryRoot, outputLocal)
  await mkdir(outputAbsolute, { recursive: true })
  const artifactName = versionedArtifactName(packageManifest.version, commit)
  const artifactLocal = `${outputLocal}/${artifactName}`
  const artifactAbsolute = join(repositoryRoot, artifactLocal)
  const artifactTemporary = `${artifactAbsolute}.tmp-${process.pid}`
  await copyFile(join(repositoryRoot, "dist", "index.js"), artifactTemporary)
  await rename(artifactTemporary, artifactAbsolute)

  const manifest = await collectReleaseCandidateManifest({
    repository: repositoryRoot,
    packageName: packageManifest.name,
    packageVersion: packageManifest.version,
    commit,
    rollbackTarget,
    artifactPath: artifactLocal,
    evidencePaths: options.evidencePaths,
  })
  const manifestName = `${basename(artifactName, ".js")}.manifest.json`
  const manifestAbsolute = join(outputAbsolute, manifestName)
  const manifestTemporary = `${manifestAbsolute}.tmp-${process.pid}`
  await writeFile(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  await rename(manifestTemporary, manifestAbsolute)
  assertCleanCheckout(repositoryRoot)
  process.stdout.write(`${manifestAbsolute}\n`)
}

if (import.meta.main) {
  await main()
}
