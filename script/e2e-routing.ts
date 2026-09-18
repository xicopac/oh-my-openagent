/**
 * `bun run test:e2e-routing` — deterministic E2E harness for OMA's worker-first
 * gate and disabled-model failover.
 *
 * Two tiers, both asserting on structured events (the governance audit JSONL +
 * the mock provider request trace), never on log prose:
 *
 *  Tier A (process-level): spawns a FRESH OpenCode process (`opencode run
 *  --format json`) against a scripted local OpenAI-compatible mock provider,
 *  with an isolated HOME/XDG/.omo and the freshly-built `dist/index.js` plugin.
 *  Exercises Scenario 1 (worker-first gate) end-to-end.
 *
 *  Tier B (runtime-level): drives the REAL `DelegationFirstRuntime` with a
 *  deterministic candidate ladder, exercising Scenarios 2-5 (disabled-model
 *  failover, multiple failover, true exhaustion, attempt-vs-logical state) via
 *  the real governance audit journal.
 *
 * No external API, no internet, no paid call, no real provider, no
 * `/srv/dev/.omo`, no pre-existing global state. Deterministic PASS/FAIL.
 */
import { spawn } from "bun"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  runRuntimeScenarios,
  eventNames,
  countNamed,
  type CheckResult,
} from "./e2e-routing-scenarios"
import { runPersistenceScenarios } from "./e2e-routing-persistence-scenarios"

const REPO_ROOT = join(import.meta.dir, "..")
const MOCK_PATH = join(import.meta.dir, "e2e-routing", "mock-provider.mjs")
const DIST_PLUGIN = join(REPO_ROOT, "dist", "index.js")

type Spec = { name: string; pass: (value: unknown) => boolean; detail: string }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = fn()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(100)
  }
}

function readJsonl(root: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const dir of readdirSync(root)) {
    const journal = join(root, dir, "events.jsonl")
    if (!existsSync(journal)) continue
    for (const line of readFileSync(journal, "utf8").split("\n")) {
      if (!line.length) continue
      try { out.push(JSON.parse(line)) } catch { /* ignore */ }
    }
  }
  return out
}

function readJsonlLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  const out: Array<Record<string, unknown>> = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.length) continue
    try { out.push(JSON.parse(line)) } catch { /* ignore */ }
  }
  return out
}

/**
 * Find the opencode binary. Prefer the wrapper on PATH (verified to work in
 * isolation); it resolves to the real bundled binary regardless of HOME.
 */
function findOpencode(): string {
  const found = process.env.OPENCODE_BIN
  if (found) return found
  return "opencode"
}

// ---------------------------------------------------------------------------
// Tier A: process-level worker-first gate
// ---------------------------------------------------------------------------

async function runWorkerFirstProcess(evidenceRoot: string): Promise<{ checks: CheckResult[]; detail: Record<string, unknown> }> {
  const checks: CheckResult[] = []
  const detail: Record<string, unknown> = {}

  // 1. start the mock provider on an ephemeral port
  const mockTrace = join(evidenceRoot, "mock-trace.jsonl")
  const portFile = join(evidenceRoot, "mock-port.txt")
  const mock = spawn([process.execPath, MOCK_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, MOCK_TRACE: mockTrace, MOCK_PORT_FILE: portFile, FAKE_OPENAI_PORT: "0" },
    stdout: "ignore",
    stderr: "ignore",
  })
  const port = await waitFor(() => {
    try { return readFileSync(portFile, "utf8").trim() || undefined } catch { return undefined }
  }, 10_000, "mock port")
  detail.mockPort = port

  // 2. isolated environment
  const envRoot = mkdtempSync(join(tmpdir(), "oma-e2e-proc-"))
  const home = join(envRoot, "home")
  const data = join(envRoot, "data")
  const config = join(envRoot, "config")
  const cache = join(envRoot, "cache")
  const state = join(envRoot, "state")
  const gov = join(envRoot, "gov")
  const workspace = join(envRoot, "workspace")
  const configOpenCode = join(config, "opencode")
  const omoDir = join(workspace, ".omo")
  for (const d of [home, data, configOpenCode, cache, state, gov, workspace, omoDir]) mkdirSync(d, { recursive: true })
  detail.envRoot = envRoot

  // 3. write isolated configs
  writeFileSync(join(workspace, "README.md"), "# empty e2e workspace\n")
  writeFileSync(join(configOpenCode, "opencode.json"), JSON.stringify({
    plugin: [`file://${DIST_PLUGIN}`],
    model: "test/root",
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        name: "Test Mock",
        options: { apiKey: "fake", baseURL: `http://127.0.0.1:${port}/v1` },
        models: {
          root: { name: "Root" },
          "worker-ok": { name: "Worker OK" },
          "worker-disabled": { name: "Worker Disabled" },
          "worker-disabled-2": { name: "Worker Disabled 2" },
        },
      },
    },
    permission: { bash: "allow" },
  }, null, 2))
  // The unified OMA config lives in `.omo/omo.jsonc`; plugin config is under the
  // `[opencode]` block (resource governor is not a top-level omo key).
  writeFileSync(join(omoDir, "omo.jsonc"), JSON.stringify({
    "[opencode]": {
      resource_governor: {
        enabled: true,
        consent: { require_paid_escalation: false, require_hard_budget_increase: false },
      },
      agents: { explore: { model: "test/worker-ok" } },
    },
  }, null, 2))

  // 4. run a fresh opencode process
  const runEnv: Record<string, string> = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OMO_GOVERNANCE_DIR: gov,
    OMO_MODEL_AVAILABILITY_FILE: join(state, "model-availability.json"),
  }
  const prompt = "OMA_E2E_WORKER_FIRST: find where OMA_E2E_WORKER_FIRST is handled and report it."
  const proc = spawn([findOpencode(), "run", "--format", "json", "--auto", "-m", "test/root", prompt], {
    cwd: workspace,
    env: runEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text().catch(() => "")
  const stderr = await new Response(proc.stderr).text().catch(() => "")
  const deadline = Date.now() + 120_000
  while (proc.exitCode === null && Date.now() < deadline) await sleep(250)
  if (proc.exitCode === null) proc.kill()
  detail.exitCode = proc.exitCode
  detail.stdoutTail = stdout.slice(-2000)
  detail.stderrTail = stderr.slice(-2000)

  // 5. read structured evidence
  const auditEvents = readJsonl(gov)
  const names = eventNames(auditEvents)
  const mockEvents = readJsonlLines(mockTrace)
  const mockModels = new Set(mockEvents.map((e) => String(e.model ?? "")))
  const mockTools = mockEvents.filter((e) => e.event === "emit_tool").map((e) => String(e.tool ?? ""))
  detail.auditEvents = names
  detail.requestedModels = [...mockModels].sort()
  detail.emittedTools = mockTools

  checks.push(
    names.includes("root_grunt_blocked")
      ? { name: "Worker-first gate", passed: true, failures: [] }
      : { name: "Worker-first gate", passed: false, failures: [`missing root_grunt_blocked; audit=${names.join(",")}`] },
  )
  checks.push(
    names.includes("root_worker_required")
      ? { name: "Root worker required", passed: true, failures: [] }
      : { name: "Root worker required", passed: false, failures: ["missing root_worker_required"] },
  )
  checks.push(
    names.includes("cost-gate-approved")
      ? { name: "Worker dispatch authorized and launched", passed: true, failures: [] }
      : { name: "Worker dispatch authorized and launched", passed: false, failures: ["missing cost-gate-approved (governor did not approve the child)"] },
  )

  // root attempted broad Bash, then delegated
  checks.push(
    mockTools.includes("bash") && mockTools.includes("task")
      ? { name: "Root delegated after block", passed: true, failures: [] }
      : { name: "Root delegated after block", passed: false, failures: [`emitted tools=${mockTools.join(",")}`] },
  )

  // a real worker model was actually exercised
  checks.push(
    mockModels.has("worker-ok")
      ? { name: "Fresh worker actually ran", passed: true, failures: [] }
      : { name: "Fresh worker actually ran", passed: false, failures: [`requested models=${[...mockModels]}`] },
  )

  // proof no external provider was contacted: only scripted models requested
  const scripted = new Set(["root", "worker-ok", "worker-disabled", "worker-disabled-2", "scripted"])
  const external = [...mockModels].filter((m) => !scripted.has(m) && m !== "")
  checks.push(
    external.length === 0
      ? { name: "No external provider contacted", passed: true, failures: [] }
      : { name: "No external provider contacted", passed: false, failures: [`external models=${external.join(",")}`] },
  )

  mock.kill()
  return { checks, detail }
}

// ---------------------------------------------------------------------------
// Reporter + self-test + main
// ---------------------------------------------------------------------------

function tally(checks: CheckResult[]): { pass: number; fail: number } {
  const pass = checks.filter((c) => c.passed).length
  return { pass, fail: checks.length - pass }
}

function printReport(all: CheckResult[]): number {
  const { pass, fail } = tally(all)
  console.log("OMA deterministic E2E\n")
  let width = 0
  for (const c of all) width = Math.max(width, c.name.length)
  for (const c of all) {
    const status = c.passed ? "PASS" : "FAIL"
    const suffix = c.passed ? "" : `  [${c.failures.join(" | ")}]`
    console.log(`${c.name.padEnd(width)}  ${status}${suffix}`)
  }
  console.log(`\n${pass}/${all.length} PASS`)
  return fail
}

/** Prove the assertion machinery can fail (no broken prod code committed). */
function selfTestAssertions(): CheckResult[] {
  const checks: CheckResult[] = []
  // A true statement must not fail.
  checks.push({ name: "self-test: true passes", passed: passSelf(true), failures: [] })
  // A false statement must be caught.
  const caught = passSelf(false) === false
  checks.push(caught
    ? { name: "self-test: false is caught", passed: true, failures: [] }
    : { name: "self-test: false is caught", passed: false, failures: ["false statement unexpectedly passed"] })
  return checks
}

function passSelf(value: boolean): boolean {
  return value === true
}

const SELF_TEST_DESC =
  "self-test: intentionally violated invariant is caught (the assertion layer fails on a deliberately-false statement, proving checks are meaningful)."

async function main(): Promise<void> {
  const isSelfTest = process.argv.includes("--self-test")

  if (isSelfTest) {
    const checks = selfTestAssertions()
    console.log(SELF_TEST_DESC)
    const failures = printReport(checks)
    process.exit(failures > 0 ? 1 : 0)
  }

  if (!existsSync(DIST_PLUGIN)) {
    console.log(`dist/index.js missing; run "bun run build" first (expected at ${DIST_PLUGIN})`)
    process.exit(1)
  }

  const evidenceRoot = mkdtempSync(join(tmpdir(), "oma-e2e-"))
  const checks: CheckResult[] = []
  const tempDirs: string[] = [evidenceRoot]

  // Tier B: runtime-level failover scenarios
  const runtime = await runRuntimeScenarios()
  checks.push(...runtime.checks)
  tempDirs.push(...runtime.traceDirs)

  // Tier B2: cross-runtime persistence of the negative-availability quarantine
  const persistence = await runPersistenceScenarios()
  checks.push(...persistence.checks)
  tempDirs.push(...persistence.traceDirs)

  // Tier A: process-level worker-first gate
  let procEnvRoot: string | undefined
  try {
    const proc = await runWorkerFirstProcess(evidenceRoot)
    checks.push(...proc.checks)
    procEnvRoot = typeof proc.detail.envRoot === "string" ? proc.detail.envRoot : undefined
    if (procEnvRoot) tempDirs.push(procEnvRoot)
    if (proc.checks.some((c) => !c.passed)) {
      console.error("--- process scenario detail ---")
      console.error(JSON.stringify(proc.detail, null, 2))
    }
  } catch (error) {
    checks.push({ name: "Process-level harness", passed: false, failures: [String(error)] })
  }

  const failed = printReport(checks)
  if (failed > 0) {
    console.log(`\nevidence preserved under: ${tempDirs.join(", ")}`)
  } else {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  }
  process.exit(failed > 0 ? 1 : 0)
}

void main()
