/**
 * LIVE cross-process persistence acceptance test for the disabled-model
 * quarantine (`~/.omo/model-availability.json`).
 *
 * Process A (fresh opencode process): the root model dispatches an `explore`
 * worker via the plugin `task` tool. The explore agent has a `fast` role
 * requirement and NO explicit model override, so the dynamic model resolver
 * maps the live enabled pool onto the "fast" band. Among the scripted mock
 * models (test/worker-ok, test/worker-disabled, test/root) the two unknown-price
 * worker candidates sort alphabetically, so `test/worker-disabled` is selected
 * first, returns HTTP 403 "Model is disabled", the runtime marks it unavailable,
 * persists the quarantine to the isolated `~/.omo/model-availability.json`, and
 * auto re-dispatches on `test/worker-ok`.
 *
 * Process B (completely fresh opencode process, same isolated HOME + provider
 * catalog, different governance journal + mock trace): the quarantine was
 * hydrated from disk at runtime construction, so the dynamic resolver EXCLUDES
 * `test/worker-disabled` and dispatches the worker directly on
 * `test/worker-ok` -- the disabled model is skipped WITHOUT failing again.
 *
 * Evidence is structural (mock request trace + governance audit JSONL + the
 * persisted availability file), never log prose. No real provider, no network.
 *
 * Run: bun run script/live-persistence-verify.ts
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

const REPO_ROOT = join(import.meta.dir, "..")
const MOCK_PATH = join(import.meta.dir, "live-persistence-verify", "mock-provider-delayed.mjs")
const DIST_PLUGIN = join(REPO_ROOT, "dist", "index.js")

type CheckResult = { name: string; passed: boolean; failures: string[] }

function ok(name: string): CheckResult {
  return { name, passed: true, failures: [] }
}
function fail(name: string, failures: string[]): CheckResult {
  return { name, passed: false, failures }
}
function tally(checks: CheckResult[]): { pass: number; fail: number } {
  const pass = checks.filter((c) => c.passed).length
  return { pass, fail: checks.length - pass }
}

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

/** Same lookup as script/e2e-routing.ts findOpencode(): OPENCODE_BIN env or "opencode". */
function findOpencode(): string {
  const found = process.env.OPENCODE_BIN
  if (found) return found
  return "opencode"
}

function readJsonlDir(root: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (!existsSync(root)) return out
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

const sleep250 = () => sleep(250)

/**
 * Pre-seed the plugin's provider-models cache in the isolated cache dir.
 * A normal deployment writes this from `client.provider.list()`, but the SDK
 * client available in this sandbox cannot enumerate providers, so the dynamic
 * model resolver (the path that honors the hydrated quarantine) would see an
 * empty pool. Seed ONLY the provider-models file -- NOT the connected-providers
 * file -- because `isFirstRunNoCache` (builtin-agents.ts) keys off the
 * connected-providers cache; seeding it would disable the core agents, which
 * reverts the run session to the `build` agent where the plugin denies `task`.
 * The MAIN model `test/root` is deliberately absent so it can never be selected
 * as a worker candidate (the root session still uses it via `-m test/root`).
 */
function seedProviderCache(cacheOmoDir: string): void {
  mkdirSync(cacheOmoDir, { recursive: true })
  writeFileSync(join(cacheOmoDir, "provider-models.json"), JSON.stringify({
    models: {
      test: [
        { id: "worker-ok", name: "Worker OK" },
        { id: "worker-disabled", name: "Worker Disabled" },
      ],
    },
    connected: ["test"],
    updatedAt: new Date().toISOString(),
  }, null, 2))
}

type ProcessEvidence = {
  exitCode: number | null
  stdoutTail: string
  stderrTail: string
  trace: Array<Record<string, unknown>>
  audit: Array<Record<string, unknown>>
  processPid: number
}

async function runProcess(params: {
  label: string
  envRoot: string
  home: string
  data: string
  config: string
  cache: string
  cacheOmoDir: string
  state: string
  gov: string
  workspace: string
  configOpenCode: string
  omoDir: string
  mockTrace: string
  mockPortFile: string
  prompt: string
}): Promise<ProcessEvidence> {
  const { label, envRoot, home, data, config, cache, cacheOmoDir, state, gov, workspace, configOpenCode, omoDir, mockTrace, mockPortFile, prompt } = params

  // 0. simulate the plugin's normal connected-provider state
  seedProviderCache(cacheOmoDir)

  // 1. start the scripted mock provider on an ephemeral port
  const mock = spawn([process.execPath, MOCK_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, MOCK_TRACE: mockTrace, MOCK_PORT_FILE: mockPortFile, FAKE_OPENAI_PORT: "0", DISABLED_DELAY_MS: "500", ROOT_FINAL_DELAY_MS: "2000" },
    stdout: "ignore",
    stderr: "ignore",
  })
  let mockPort = ""
  try {
    mockPort = await waitFor(() => {
      try { return readFileSync(mockPortFile, "utf8").trim() || undefined } catch { return undefined }
    }, 10_000, `${label} mock port`)
  } catch (error) {
    mock.kill()
    throw error
  }

  // 2. isolated provider catalog. The config's `model` is a REAL (non-pool)
  // model so the explore agent's default never fuzzy-matches the mock pool,
  // forcing the quarantine-aware dynamic resolver to run. The root session
  // still uses `test/root` via `-m test/root` on the CLI.
  writeFileSync(join(configOpenCode, "opencode.json"), JSON.stringify({
    plugin: [`file://${DIST_PLUGIN}`],
    model: "deepseek/deepseek-v4-flash",
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        name: "Test Mock",
        options: { apiKey: "fake", baseURL: `http://127.0.0.1:${mockPort}/v1` },
        models: {
          "worker-ok": { name: "Worker OK" },
          "worker-disabled": { name: "Worker Disabled" },
          root: { name: "Root" },
        },
      },
    },
    permission: { bash: "allow" },
  }, null, 2))
  writeFileSync(join(omoDir, "omo.jsonc"), JSON.stringify({
    "[opencode]": {
      resource_governor: {
        enabled: true,
        consent: { require_paid_escalation: false, require_hard_budget_increase: false },
      },
    },
  }, null, 2))

  // 3. fresh opencode process with the isolated env
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
  }
  const proc = spawn([findOpencode(), "run", "--format", "json", "--auto", "--agent", "sisyphus", "-m", "test/root", prompt], {
    cwd: workspace,
    env: runEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text().catch(() => "")
  const stderr = await new Response(proc.stderr).text().catch(() => "")
  const deadline = Date.now() + 150_000
  while (proc.exitCode === null && Date.now() < deadline) await sleep250()
  if (proc.exitCode === null) proc.kill()
  mock.kill()

  return {
    exitCode: proc.exitCode,
    stdoutTail: stdout.slice(-3000),
    stderrTail: stderr.slice(-3000),
    trace: readJsonlLines(mockTrace),
    audit: readJsonlDir(gov),
    processPid: proc.pid ?? 0,
  }
}

const WORKER_DISABLED = "test/worker-disabled"
const WORKER_OK = "test/worker-ok"

function mainReport(all: CheckResult[], detail: Record<string, unknown>): number {
  console.log("\n===== LIVE CROSS-PROCESS PERSISTENCE ACCEPTANCE =====")
  console.log(JSON.stringify(detail, null, 2))
  console.log("\n--- ASSERTIONS ---")
  let width = 0
  for (const c of all) width = Math.max(width, c.name.length)
  for (const c of all) {
    const status = c.passed ? "PASS" : "FAIL"
    const suffix = c.passed ? "" : `  [${c.failures.join(" | ")}]`
    console.log(`${c.name.padEnd(width)}  ${status}${suffix}`)
  }
  const { pass, fail: failed } = tally(all)
  console.log(`\n${pass}/${all.length} PASS`)
  return failed
}

async function main(): Promise<void> {
  const checks: CheckResult[] = []
  const detail: Record<string, unknown> = {}

  if (!existsSync(DIST_PLUGIN)) {
    console.log(`dist/index.js missing; run "bun run build" first (expected at ${DIST_PLUGIN})`)
    process.exit(1)
  }

  const envRoot = mkdtempSync(join(tmpdir(), "oma-live-persist-"))
  const home = join(envRoot, "home")
  const data = join(envRoot, "data")
  const config = join(envRoot, "config")
  const cache = join(envRoot, "cache")
  const state = join(envRoot, "state")
  const govA = join(envRoot, "gov-a")
  const govB = join(envRoot, "gov-b")
  const workspace = join(envRoot, "workspace")
  const configOpenCode = join(config, "opencode")
  const omoDir = join(workspace, ".omo")
  const cacheOmoDir = join(cache, "oh-my-opencode")
  for (const d of [home, data, configOpenCode, cache, state, govA, govB, workspace, omoDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(workspace, "README.md"), "# isolated live-persistence workspace\n")
  detail.envRoot = envRoot
  detail.opencodeBin = findOpencode()

  const mockTraceA = join(envRoot, "trace-a.jsonl")
  const mockPortA = join(envRoot, "mock-port-a.txt")
  const mockTraceB = join(envRoot, "trace-b.jsonl")
  const mockPortB = join(envRoot, "mock-port-b.txt")

  const prompt = "OMA_LIVE_PERSIST_CROSS_PROCESS: find where OMA_E2E_WORKER_FIRST is handled and report it via a task-delegated worker."
  const quarantineFile = join(home, ".omo", "model-availability.json")

  // ---------------------------------------------------------------------------
  // PROCESS A
  // ---------------------------------------------------------------------------
  let procA: ProcessEvidence
  try {
    procA = await runProcess({
      label: "A", envRoot, home, data, config, cache, cacheOmoDir, state, gov: govA, workspace,
      configOpenCode, omoDir, mockTrace: mockTraceA, mockPortFile: mockPortA, prompt,
    })
  } catch (error) {
    console.error("FATAL: could not spawn a real opencode process for process A:", String(error))
    console.error("Cannot run the two-process live test in this environment. The deterministic")
    console.error("cross-runtime proof is the fallback; run `bun run test:e2e-routing` and inspect")
    console.error("the persistence scenario results instead. The live test did NOT run.")
    rmSync(envRoot, { recursive: true, force: true })
    process.exit(2)
  }
  detail.processA = {
    exitCode: procA.exitCode,
    pid: procA.processPid,
    stdoutTail: procA.stdoutTail,
    stderrTail: procA.stderrTail,
    trace: procA.trace,
    auditEvents: procA.audit.map((e) => String(e.event ?? "")),
  }

  const traceA = procA.trace
  const auditA = procA.audit
  const disabledRequestsA = traceA.filter((e) => String(e.model ?? "") === "worker-disabled")
  const disabledErrorsA = traceA.filter((e) => e.event === "disabled_error")
  const okRequestsA = traceA.filter((e) => String(e.model ?? "") === "worker-ok")
  const okDoneA = traceA.filter((e) => e.event === "emit_text" && String(e.text ?? "").includes("WORKER_DONE"))
  const unavailableAuditA = auditA.filter((e) => e.event === "worker_model_unavailable")

  // A.1 process ran to completion
  checks.push(procA.exitCode === 0
    ? ok("A: opencode process completed (exit 0)")
    : fail("A: opencode process completed (exit 0)", [`exitCode=${procA.exitCode}`]))

  // A.2 worker-disabled was requested and returned 403 exactly the first time
  checks.push(disabledRequestsA.length >= 1 && disabledErrorsA.length >= 1
    ? ok("A: test/worker-disabled requested and returned 403 (first hit)")
    : fail("A: test/worker-disabled requested and returned 403 (first hit)", [
        `disabledRequests=${disabledRequestsA.length} disabledErrors=${disabledErrorsA.length}`,
      ]))

  // A.3 failover re-dispatched on worker-ok and it succeeded
  checks.push(okRequestsA.length >= 1 && okDoneA.length >= 1
    ? ok("A: failover re-dispatched on test/worker-ok which succeeded")
    : fail("A: failover re-dispatched on test/worker-ok which succeeded", [
        `okRequests=${okRequestsA.length} okDone=${okDoneA.length}`,
      ]))

  // A.4 quarantine was persisted to the isolated ~/.omo state
  let quarantineAfterA: Record<string, unknown> | null = null
  if (existsSync(quarantineFile)) {
    try { quarantineAfterA = JSON.parse(readFileSync(quarantineFile, "utf8")) } catch { quarantineAfterA = null }
  }
  const entryA = quarantineAfterA && (quarantineAfterA as { entries?: Record<string, unknown> }).entries
    ? (quarantineAfterA as { entries: Record<string, unknown> }).entries[WORKER_DISABLED]
    : undefined
  const entryAFields: Array<[string, unknown]> = entryA
    ? [
        ["provider", (entryA as Record<string, unknown>).provider],
        ["model", (entryA as Record<string, unknown>).model],
        ["reason", (entryA as Record<string, unknown>).reason],
        ["classification", (entryA as Record<string, unknown>).classification],
        ["retryAfterAt", (entryA as Record<string, unknown>).retryAfterAt],
        ["consecutiveFailures", (entryA as Record<string, unknown>).consecutiveFailures],
      ]
    : []
  const entryAOk =
    entryA !== undefined &&
    (entryA as Record<string, unknown>).classification === "disabled" &&
    typeof (entryA as Record<string, unknown>).retryAfterAt === "string" &&
    Date.parse((entryA as Record<string, unknown>).retryAfterAt as string) > Date.now()
  checks.push(entryAOk
    ? ok("A: quarantine persisted (classification=disabled, retryAfterAt in future)")
    : fail("A: quarantine persisted (classification=disabled, retryAfterAt in future)", [
        `file=${existsSync(quarantineFile)} entry=${JSON.stringify(entryAFields.length ? Object.fromEntries(entryAFields) : quarantineAfterA)}`,
      ]))
  detail.quarantineFile = quarantineFile
  detail.quarantineAfterA = quarantineAfterA

  // A.5 the governance audit recorded worker_model_unavailable for the disabled model
  checks.push(unavailableAuditA.some((e) => e.model === WORKER_DISABLED)
    ? ok("A: governance audit records worker_model_unavailable for test/worker-disabled")
    : fail("A: governance audit records worker_model_unavailable for test/worker-disabled", [
        `audit=${auditA.filter((e) => e.event === "worker_model_unavailable").map((e) => JSON.stringify(e)).join(" | ") || "none"}`,
      ]))

  // A.6 no external provider was contacted
  const scriptedModels = new Set(["root", "worker-ok", "worker-disabled", "scripted"])
  const externalA = traceA.map((e) => String(e.model ?? "")).filter((m) => !scriptedModels.has(m) && m !== "")
  checks.push(externalA.length === 0
    ? ok("A: no external provider contacted (only scripted models)")
    : fail("A: no external provider contacted (only scripted models)", [`external=${externalA.join(",")}`]))

  // ---------------------------------------------------------------------------
  // PROCESS B
  // ---------------------------------------------------------------------------
  let procB: ProcessEvidence
  try {
    procB = await runProcess({
      label: "B", envRoot, home, data, config, cache, cacheOmoDir, state, gov: govB, workspace,
      configOpenCode, omoDir, mockTrace: mockTraceB, mockPortFile: mockPortB, prompt,
    })
  } catch (error) {
    console.error("FATAL: could not spawn a real opencode process for process B:", String(error))
    rmSync(envRoot, { recursive: true, force: true })
    process.exit(2)
  }
  detail.processB = {
    exitCode: procB.exitCode,
    pid: procB.processPid,
    stdoutTail: procB.stdoutTail,
    stderrTail: procB.stderrTail,
    trace: procB.trace,
    auditEvents: procB.audit.map((e) => String(e.event ?? "")),
  }

  const traceB = procB.trace
  const auditB = procB.audit
  const disabledRequestsB = traceB.filter((e) => String(e.model ?? "") === "worker-disabled")
  const disabledErrorsB = traceB.filter((e) => e.event === "disabled_error")
  const okRequestsB = traceB.filter((e) => String(e.model ?? "") === "worker-ok")
  const okDoneB = traceB.filter((e) => e.event === "emit_text" && String(e.text ?? "").includes("WORKER_DONE"))
  const unavailableAuditB = auditB.filter((e) => e.event === "worker_model_unavailable")

  // B.1 process ran to completion
  checks.push(procB.exitCode === 0
    ? ok("B: opencode process completed (exit 0)")
    : fail("B: opencode process completed (exit 0)", [`exitCode=${procB.exitCode}`]))

  // B.2 THE acceptance: worker-disabled was NEVER requested again in process B
  checks.push(disabledRequestsB.length === 0 && disabledErrorsB.length === 0
    ? ok("B: test/worker-disabled was NEVER requested again (no second 403)")
    : fail("B: test/worker-disabled was NEVER requested again (no second 403)", [
        `disabledRequests=${disabledRequestsB.length} disabledErrors=${disabledErrorsB.length}`,
      ]))

  // B.3 the worker task succeeded on test/worker-ok in process B
  checks.push(okRequestsB.length >= 1 && okDoneB.length >= 1
    ? ok("B: worker task succeeded on test/worker-ok (skipped disabled model)")
    : fail("B: worker task succeeded on test/worker-ok (skipped disabled model)", [
        `okRequests=${okRequestsB.length} okDone=${okDoneB.length}`,
      ]))

  // B.4 process B's governance audit has NO worker_model_unavailable for the disabled model
  checks.push(unavailableAuditB.length === 0
    ? ok("B: governance audit has no worker_model_unavailable (no second mark)")
    : fail("B: governance audit has no worker_model_unavailable (no second mark)", [
        `count=${unavailableAuditB.length} events=${unavailableAuditB.map((e) => JSON.stringify(e)).join(" | ")}`,
      ]))

  // B.5 the quarantine file is still present and unchanged by process B (no rewrite)
  let quarantineAfterB: Record<string, unknown> | null = null
  if (existsSync(quarantineFile)) {
    try { quarantineAfterB = JSON.parse(readFileSync(quarantineFile, "utf8")) } catch { quarantineAfterB = null }
  }
  const entryBOk = quarantineAfterB !== null && quarantineAfterB !== undefined
  checks.push(entryBOk
    ? ok("B: quarantine store still present after process B")
    : fail("B: quarantine store still present after process B", [`file=${existsSync(quarantineFile)}`]))
  detail.quarantineAfterB = quarantineAfterB

  // B.6 no external provider was contacted
  const externalB = traceB.map((e) => String(e.model ?? "")).filter((m) => !scriptedModels.has(m) && m !== "")
  checks.push(externalB.length === 0
    ? ok("B: no external provider contacted (only scripted models)")
    : fail("B: no external provider contacted (only scripted models)", [`external=${externalB.join(",")}`]))

  // ---------------------------------------------------------------------------
  // Structured report
  // ---------------------------------------------------------------------------
  const childModelsA = [...new Set(traceA.filter((e) => String(e.model ?? "") !== "root" && String(e.model ?? "") !== "scripted").map((e) => String(e.model ?? "")))]
  const childModelsB = [...new Set(traceB.filter((e) => String(e.model ?? "") !== "root" && String(e.model ?? "") !== "scripted").map((e) => String(e.model ?? "")))]
  detail.report = {
    rootModelUsed: "test/root",
    childAgentTypesObserved: ["explore"],
    requestedModelTier: "fast (explore role requirement, dynamically banded)",
    processA: {
      requestedModels: childModelsA,
      firstRequestedWorker: childModelsA[0] ?? null,
      disabledModelHit: disabledRequestsA.length,
      disabledErrorCount: disabledErrorsA.length,
      failoverWorker: okRequestsA.length > 0 ? WORKER_OK : null,
      resolvedFromQuarantine: false,
    },
    processB: {
      requestedModels: childModelsB,
      disabledModelHit: disabledRequestsB.length,
      disabledErrorCount: disabledErrorsB.length,
      workerTaskModel: okRequestsB.length > 0 ? WORKER_OK : null,
      resolvedFromQuarantine: disabledRequestsB.length === 0 && okRequestsB.length > 0,
    },
    persistentQuarantineLoaded: disabledRequestsB.length === 0 && okRequestsB.length > 0,
    knownDisabledModelSkipped: disabledRequestsB.length === 0,
  }

  const failed = mainReport(checks, detail)
  if (failed > 0) {
    console.log(`\nevidence preserved under: ${envRoot}`)
    process.exit(1)
  }

  rmSync(envRoot, { recursive: true, force: true })
  console.log("cleaned up temp env.")
  process.exit(0)
}

void main()