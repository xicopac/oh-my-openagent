/**
 * LIVE ACCEPTANCE — POST-EVIDENCE ROOT VERIFICATION
 *
 * Spawns a FRESH OpenCode process with the freshly-built `dist/index.js`
 * plugin, against the scripted mock provider. The scripted root model:
 *   1. attempts a broad bash read       -> BLOCKED (worker-first)
 *   2. delegates ONE explore child      -> FREE worker, no paid call
 *   3. consumes background_output       -> worker evidence registered
 *   4. reads the worker-anchored file   -> ALLOWED (anchored read)
 *   5. greps the worker-provided symbol -> ALLOWED (exact symbol)
 *   6. globs an unrelated pattern       -> BLOCKED (new broad investigation)
 *
 * Asserts on structured evidence only: the governance audit JSONL (phase
 * transitions + evidence anchors) and the mock request trace (models asked,
 * tools emitted). No paid authorization, no fan-out.
 *
 * Run: `bun script/live-post-evidence/run.ts`
 */
import { spawn } from "bun"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const MOCK_PATH = join(import.meta.dir, "mock-provider.mjs")
const DIST_PLUGIN = join(REPO_ROOT, "dist", "index.js")

type Check = { name: string; passed: boolean; failures: string[] }

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

function readJsonlLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  const out: Array<Record<string, unknown>> = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.length) continue
    try { out.push(JSON.parse(line)) } catch { /* ignore */ }
  }
  return out
}

function readGovernance(root: string): Array<Record<string, unknown>> {
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

async function main(): Promise<number> {
  if (!existsSync(DIST_PLUGIN)) {
    console.error("dist/index.js missing; run `bun run build` first")
    return 1
  }

  const checks: Check[] = []
  const evidenceRoot = mkdtempSync(join(tmpdir(), "oma-live-post-evidence-"))
  const trace = join(evidenceRoot, "mock-trace.jsonl")
  const portFile = join(evidenceRoot, "mock-port.txt")

  // 1. start the scripted mock provider
  const mock = spawn([process.execPath, MOCK_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, MOCK_TRACE: trace, MOCK_PORT_FILE: portFile, FAKE_OPENAI_PORT: "0" },
    stdout: "ignore",
    stderr: "ignore",
  })
  const port = await waitFor(() => {
    try { return readFileSync(portFile, "utf8").trim() || undefined } catch { return undefined }
  }, 10_000, "mock port")

  // 2. isolated environment
  const envRoot = mkdtempSync(join(tmpdir(), "oma-live-env-"))
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

  // a concrete anchored file the root will verify against
  const barDir = join(workspace, "packages", "foo", "src")
  mkdirSync(barDir, { recursive: true })
  writeFileSync(join(barDir, "bar.ts"), [
    "// line 1",
    "export function resolveFoo(): void {}",
    "// line 120 marker OMA_LIVE_POST_EVIDENCE",
  ].join("\n"))
  writeFileSync(join(workspace, "README.md"), "# live acceptance workspace\n")

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
      agents: { explore: { model: "test/worker-ok" } },
    },
  }, null, 2))

  // 3. run a fresh opencode process
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
  const prompt = "OMA_LIVE_POST_EVIDENCE: verify where OMA_LIVE_POST_EVIDENCE is handled."
  const proc = spawn(["opencode", "run", "--format", "json", "--auto", "-m", "test/root", prompt], {
    cwd: workspace,
    env: runEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text().catch(() => "")
  const stderr = await new Response(proc.stderr).text().catch(() => "")
  const deadline = Date.now() + 180_000
  while (proc.exitCode === null && Date.now() < deadline) await sleep(250)
  if (proc.exitCode === null) proc.kill()

  // 4. read structured evidence
  const auditEvents = readGovernance(gov)
  const auditNames = auditEvents.map((e) => String(e.event ?? "")).filter((s) => s.length > 0)
  const mockEvents = readJsonlLines(trace)
  const mockModels = new Set(mockEvents.map((e) => String(e.model ?? "")).filter((s) => s !== "scripted"))
  const mockTools = mockEvents.filter((e) => e.event === "emit_tool").map((e) => String(e.tool ?? ""))
  const paidEvents = mockEvents.filter((e) => String(e.model ?? "") !== "worker-ok")

  console.log("=== audit events ===")
  console.log(auditNames.join("\n"))
  console.log("=== root tools emitted ===")
  console.log(mockTools.join(", "))
  console.log("=== non-worker models requested ===")
  console.log([...mockModels].join(", "))

  const push = (name: string, passed: boolean, failures: string[]): void => {
    checks.push({ name, passed, failures })
  }

  // Assertions
  const hadBlocked = auditNames.includes("root_grunt_blocked")
  push("Pre-evidence broad discovery blocked (root_grunt_blocked)", hadBlocked, [`audit=${auditNames.join(",")}`])

  const hadEvidence = auditNames.includes("worker_evidence_available")
  push("Worker evidence registered (worker_evidence_available)", hadEvidence, [`audit=${auditNames.join(",")}`])

  // The scripted root emitted read + grep (verification ops). Proof they were
  // ALLOWED after evidence: the audit logged selective_root_verification (the
  // anchored-verification audit event) twice, and the final unrelated glob was
  // blocked with additional-delegation semantics (a SECOND root_grunt_blocked).
  // ROOT_DELEGATION_REQUIRED in stdout is expected from the PRE-evidence block.
  const readEmitted = mockTools.includes("read")
  const grepEmitted = mockTools.includes("grep")
  const selectiveVerificationAudits = auditNames.filter((n) => n === "selective_root_verification").length
  push("Anchored read tool emitted", readEmitted, [`tools=${mockTools.join(",")}`])
  push("Anchored symbol grep tool emitted", grepEmitted, [`tools=${mockTools.join(",")}`])
  push(
    "Root verification reads allowed after evidence (selective_root_verification)",
    selectiveVerificationAudits >= 2,
    [`selective_root_verification=${selectiveVerificationAudits}`],
  )

  const globEmitted = mockTools.includes("glob")
  const additionalBlocked = auditNames.includes("root_additional_delegation_required")
  push("Unrelated broad discovery emitted", globEmitted, [`tools=${mockTools.join(",")}`])
  push(
    "Unrelated broad discovery blocked (additional-delegation semantics)",
    additionalBlocked,
    [`audit=${auditNames.join(",")}`],
  )

  // Paid-slot safety: only the scripted free worker-ok was requested.
  const external = [...mockModels].filter((m) => m !== "root" && m !== "worker-ok" && m !== "")
  push("Child stayed FREE (only worker-ok requested)", mockModels.has("worker-ok") && external.length === 0, [`models=${[...mockModels]}`])
  const consentEvents = paidEvents.filter((e) => String(e.event ?? "").includes("paid_worker") || String(e.event ?? "").includes("approval"))
  push("No paid consent requests", consentEvents.length === 0, [`events=${paidEvents.map((e) => e.event).join(",")}`])

  mock.kill()

  // report
  let width = 0
  for (const c of checks) width = Math.max(width, c.name.length)
  console.log("\nLIVE ACCEPTANCE — POST-EVIDENCE ROOT VERIFICATION\n")
  let pass = 0
  for (const c of checks) {
    const status = c.passed ? "PASS" : "FAIL"
    const suffix = c.passed ? "" : `  [${c.failures.join(" | ")}]`
    console.log(`${c.name.padEnd(width)}  ${status}${suffix}`)
    if (c.passed) pass += 1
  }
  console.log(`\n${pass}/${checks.length} PASS`)
  console.log(`\nstdout tail:\n${stdout.slice(-1500)}`)
  if (stderr.length > 0) console.log(`\nstderr tail:\n${stderr.slice(-500)}`)

  rmSync(envRoot, { recursive: true, force: true })
  rmSync(evidenceRoot, { recursive: true, force: true })
  return pass === checks.length ? 0 : 1
}

process.exit(await main())