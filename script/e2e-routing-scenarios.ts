/**
 * Runtime-level E2E scenarios for disabled-model failover. These drive the REAL
 * `DelegationFirstRuntime` (the exact production object wired into `task`) with
 * a scripted, deterministic worker ladder and a governed recovery sink, and
 * assert on the SAME structured events (the governance audit journal) that a
 * live OpenCode process would write. This is the repo's established E2E
 * convention, applied to the disabled-model failover path via
 * `recordModelUnavailable`.
 *
 * No external model, no network, no paid call. Candidate order and model
 * behavior are fully scripted, which is exactly what a product-provider run
 * cannot guarantee.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { createGovernanceAuditWriter, type GovernanceAuditWriter } from "../packages/omo-opencode/src/shared/governance-audit"
import {
  createDelegationFirstRuntime,
  type DelegationFirstConfig,
  type DelegationFirstRuntime,
  type ReplayableAssignment,
} from "../packages/omo-opencode/src/features/delegation-first"
import { loadPersistentAvailability } from "../packages/omo-opencode/src/features/delegation-first/persistent-model-availability"
import type { WorkerCandidate } from "../packages/omo-opencode/src/features/delegation-ladder"
import {
  resolveModelBand,
  type ModelBandPricing,
  type ModelTier,
} from "../packages/delegate-core/src/model-band"
import { createPaidWorkerGate } from "../packages/omo-opencode/src/tools/delegate-task/paid-worker-gate"
import {
  PAID_WORKER_AUTHORITY_REJECTED,
  PAID_WORKER_CONSENT_DENIED,
  PAID_WORKER_CONSENT_UNAVAILABLE,
  PaidConsentRegistry,
  classifyPaidStatus,
  consumePaidApproval,
  createOpenCodePermissionConsentProvider,
  createStaticConsentProvider,
  enforcePaidWorkerLaunch,
  isRootSessionInfo,
  maxConcurrentPaidWorkers,
} from "../packages/omo-opencode/src/tools/delegate-task/paid-consent"

export type CheckResult = { name: string; passed: boolean; failures: string[] }

function freeWorker(id: string): WorkerCandidate {
  return { model_id: id, tier: "free", capability: 0.7, free: true }
}

function assignment(id: string, workers: WorkerCandidate[]): ReplayableAssignment {
  return {
    assignment_id: id,
    root_session_id: "root",
    parent_session_id: "root",
    parent_message_id: "msg-1",
    prompt: "inspect repo and report evidence",
    description: "e2e failover",
    agent: "explore",
    category: "explore",
    parent_model: { providerID: "test", modelID: "root" },
    workers,
  }
}

type AuditEvent = Record<string, unknown>

function readAuditEvents(root: string): AuditEvent[] {
  const events: AuditEvent[] = []
  for (const sessionDir of readdirSync(root)) {
    const journal = join(root, sessionDir, "events.jsonl")
    try {
      for (const line of readFileSync(journal, "utf8").split("\n")) {
        if (line.length === 0) continue
        try { events.push(JSON.parse(line)) } catch { /* ignore */ }
      }
    } catch { /* no journal */ }
  }
  return events
}

function eventNames(events: AuditEvent[]): string[] {
  return events.map((e) => String(e.event ?? "")).filter((s) => s.length > 0)
}

function countNamed(events: AuditEvent[], name: string): number {
  return events.filter((e) => e.event === name).length
}

type RelaunchRecord = { taskID: string; sessionID: string; worker: string }
type Sink = {
  relaunches: RelaunchRecord[]
  cancels: string[]
  relaunch: (assignment: ReplayableAssignment, action: { worker: WorkerCandidate }, prompt: string) => { kind: "launched"; taskID: string; sessionID: string }
  cancel: (sessionID: string, reason: string) => Promise<void>
}

function makeSink(): Sink {
  const sink: Sink = {
    relaunches: [],
    cancels: [],
    relaunch: (assignment, action) => {
      const record: RelaunchRecord = {
        taskID: `bg-${sink.relaunches.length + 1}`,
        sessionID: `child-${sink.relaunches.length + 2}`,
        worker: action.worker.model_id,
      }
      sink.relaunches.push(record)
      return { kind: "launched", taskID: record.taskID, sessionID: record.sessionID }
    },
    cancel: async (sessionID) => {
      sink.cancels.push(sessionID)
    },
  }
  return sink
}

type FailoverRun = {
  rt: DelegationFirstRuntime
  sink: Sink
  audit: GovernanceAuditWriter
  auditRoot: string
  /** Persistent availability store backing this runtime (temp by default). */
  availabilityRoot: string
  flush: () => Promise<void>
  dispose: () => void
}

function startRun(workers: WorkerCandidate[], assignmentID = "job", cfg: DelegationFirstConfig = {}): FailoverRun {
  const auditRoot = mkdtempSync(join(tmpdir(), "oma-e2e-rt-"))
  const audit = createGovernanceAuditWriter({ root: auditRoot })
  // Isolate each scenario's quarantine store by default so quarantines never
  // leak between scenarios through the user's real `~/.omo` store; an explicit
  // `modelAvailabilityFilePath` (cross-runtime persistence) still wins.
  const availabilityFile =
    cfg.modelAvailabilityFilePath ?? join(mkdtempSync(join(tmpdir(), "oma-e2e-avail-")), "model-availability.json")
  const rt = createDelegationFirstRuntime(audit, { ...cfg, modelAvailabilityFilePath: availabilityFile })
  const sink = makeSink()
  rt.setRecoverySink({ cancel: sink.cancel, relaunch: sink.relaunch })
  rt.retainAssignment(assignment(assignmentID, workers), "child-1")
  rt.attachChildSession("root", "child-1")
  rt.markRequestStarted("child-1")
  return {
    rt,
    sink,
    audit,
    auditRoot,
    availabilityRoot: dirname(availabilityFile),
    flush: () => audit.flush(),
    dispose: () => {
      void audit.flush()
      rt.dispose()
    },
  }
}

async function snapshot(run: FailoverRun): Promise<AuditEvent[]> {
  await run.flush()
  return readAuditEvents(run.auditRoot)
}

function ok(name: string): CheckResult {
  return { name, passed: true, failures: [] }
}
function fail(name: string, failures: string[]): CheckResult {
  return { name, passed: false, failures }
}

export async function runRuntimeScenarios(): Promise<{ checks: CheckResult[]; traceDirs: string[] }> {
  const allChecks: CheckResult[] = []
  const traceDirs: string[] = []

  // ---- Scenario 2: [disabled, ok] -> quarantine + single replacement ---------
  {
    const run = startRun([freeWorker("test/worker-disabled"), freeWorker("test/worker-ok")])
    traceDirs.push(run.auditRoot)
    traceDirs.push(run.availabilityRoot)

    run.rt.recordModelUnavailable("child-1", "test/worker-disabled", "Model is disabled")
    let events = await snapshot(run)
    const names = eventNames(events)

    allChecks.push(
      names.includes("worker_model_unavailable")
        ? ok("Disabled model quarantine")
        : fail("Disabled model quarantine", [`missing worker_model_unavailable; got ${names.join(",")}`]),
    )
    allChecks.push(
      run.rt.unavailableModels().includes("test/worker-disabled")
        ? ok("Disabled model marked unavailable")
        : fail("Disabled model marked unavailable", ["disabled model not in unavailableModels()"]),
    )
    allChecks.push(
      countNamed(events, "retry_chain_exhausted") === 0
        ? ok("No premature failure notification")
        : fail("No premature failure notification", ["retry_chain_exhausted emitted during failover"]),
    )

    allChecks.push(
      run.sink.relaunches.length === 1 && run.sink.relaunches[0].worker === "test/worker-ok"
        ? ok("Replacement attempt")
        : fail("Replacement attempt", [`relaunches=${run.sink.relaunches.length} worker=${run.sink.relaunches[0]?.worker}`]),
    )
    allChecks.push(
      names.includes("replacement_child_created")
        ? ok("Replacement child created")
        : fail("Replacement child created", ["missing replacement_child_created"]),
    )
    allChecks.push(
      run.rt.lineage("job")?.attempt_number === 2
        ? ok("Lineage advanced to attempt 2")
        : fail("Lineage advanced to attempt 2", [`attempt_number=${run.rt.lineage("job")?.attempt_number}`]),
    )

    run.rt.noteReplacementSession("job", "child-2")
    run.rt.attachChildSession("root", "child-2")
    run.rt.markRequestStarted("child-2")
    run.rt.detachChildSession("child-2")

    events = await snapshot(run)
    allChecks.push(
      countNamed(events, "replacement_child_completed") === 1
        ? ok("Completion exactly once")
        : fail("Completion exactly once", [`replacement_child_completed=${countNamed(events, "replacement_child_completed")}`]),
    )
    allChecks.push(
      run.sink.cancels.length === 0
        ? ok("No cancel on healthy failover")
        : fail("No cancel on healthy failover", [`cancels=${run.sink.cancels.join(",")}`]),
    )
    run.dispose()
  }

  // ---- Scenario 3: [disabled, disabled-2, ok] -> multiple failovers ----------
  {
    const run = startRun([freeWorker("test/worker-disabled"), freeWorker("test/worker-disabled-2"), freeWorker("test/worker-ok")])
    traceDirs.push(run.auditRoot)
    traceDirs.push(run.availabilityRoot)

    run.rt.recordModelUnavailable("child-1", "test/worker-disabled", "Model is disabled")
    let events = await snapshot(run)
    allChecks.push(
      countNamed(events, "retry_chain_exhausted") === 0
        ? ok("Logical task remains RUNNING (after A)")
        : fail("Logical task remains RUNNING (after A)", ["premature retry_chain_exhausted"]),
    )

    run.rt.recordModelUnavailable("child-2", "test/worker-disabled-2", "Model is disabled")
    events = await snapshot(run)
    allChecks.push(
      run.sink.relaunches.length === 2
        ? ok("Two replacements dispatched")
        : fail("Two replacements dispatched", [`relaunches=${run.sink.relaunches.length}`]),
    )
    allChecks.push(
      countNamed(events, "worker_model_unavailable") === 2
        ? ok("Both disabled models quarantined")
        : fail("Both disabled models quarantined", [`worker_model_unavailable=${countNamed(events, "worker_model_unavailable")}`]),
    )
    allChecks.push(
      countNamed(events, "retry_chain_exhausted") === 0
        ? ok("No premature allComplete / failure")
        : fail("No premature allComplete / failure", ["retry_chain_exhausted seen mid-failover"]),
    )

    run.rt.noteReplacementSession("job", "child-3")
    run.rt.attachChildSession("root", "child-3")
    run.rt.markRequestStarted("child-3")
    run.rt.detachChildSession("child-3")
    events = await snapshot(run)
    allChecks.push(
      countNamed(events, "replacement_child_completed") === 1
        ? ok("Completion exactly once (3-candidate)")
        : fail("Completion exactly once (3-candidate)", [`replacement_child_completed=${countNamed(events, "replacement_child_completed")}`]),
    )
    allChecks.push(
      run.rt.lineage("job")?.attempt_number === 3
        ? ok("Lineage advanced to attempt 3")
        : fail("Lineage advanced to attempt 3", [`attempt_number=${run.rt.lineage("job")?.attempt_number}`]),
    )
    run.dispose()
  }

  // ---- Scenario 4: true exhaustion -> single logical failure ----------------
  {
    const run = startRun([freeWorker("test/worker-disabled"), freeWorker("test/worker-disabled-2")])
    traceDirs.push(run.auditRoot)
    traceDirs.push(run.availabilityRoot)

    run.rt.recordModelUnavailable("child-1", "test/worker-disabled", "Model is disabled")
    run.rt.recordModelUnavailable("child-2", "test/worker-disabled-2", "Model is disabled")

    const events = await snapshot(run)
    allChecks.push(
      countNamed(events, "retry_chain_exhausted") === 1
        ? ok("Exhaustion exactly once")
        : fail("Exhaustion exactly once", [`retry_chain_exhausted=${countNamed(events, "retry_chain_exhausted")}`]),
    )
    allChecks.push(
      run.sink.cancels.length === 1
        ? ok("Single truthful cancel at exhaustion")
        : fail("Single truthful cancel at exhaustion", [`cancels=${run.sink.cancels.length}`]),
    )
    allChecks.push(
      countNamed(events, "worker_model_unavailable") === 2
        ? ok("Both disabled models recorded")
        : fail("Both disabled models recorded", [`worker_model_unavailable=${countNamed(events, "worker_model_unavailable")}`]),
    )
    run.dispose()
  }

  // ---- Scenario 5: attempt-level ERROR vs logical state ---------------------
  {
    const run = startRun([freeWorker("test/worker-disabled"), freeWorker("test/worker-ok")])
    traceDirs.push(run.auditRoot)
    traceDirs.push(run.availabilityRoot)

    run.rt.recordModelUnavailable("child-1", "test/worker-disabled", "Model is disabled")

    const lineage = run.rt.lineage("job")
    const events = await snapshot(run)
    const names = eventNames(events)

    allChecks.push(
      names.includes("worker_model_unavailable")
        ? ok("Attempt-level ERROR recorded (disabled model)")
        : fail("Attempt-level ERROR recorded (disabled model)", ["missing worker_model_unavailable"]),
    )
    allChecks.push(
      lineage !== undefined && countNamed(events, "retry_chain_exhausted") === 0
        ? ok("Logical state NOT terminal while candidate remains")
        : fail("Logical state NOT terminal while candidate remains", ["logical assignment terminal/lineage lost during failover"]),
    )
    allChecks.push(
      run.sink.relaunches.length === 1
        ? ok("Attempt failure does not stop the logical assignment")
        : fail("Attempt failure does not stop the logical assignment", [`relaunches=${run.sink.relaunches.length}`]),
    )
    run.dispose()
  }

  return { checks: allChecks, traceDirs }
}

/**
 * Routing cost policy scenario: free-first worker routing with the persistent
 * disabled-model quarantine. Asserts the root stays on paid Flash, ordinary
 * balanced workers resolve into the free pool (never Flash while a free model
 * remains), a disabled free model is durably quarantined and skipped by a
 * fresh runtime sharing only the persistence file, and paid Flash is consumed
 * only after the free pool is exhausted or strong routing is explicitly
 * requested. Deterministic PASS/FAIL; no external provider.
 */
export async function runRoutingCostPolicyScenario(): Promise<{ checks: CheckResult[]; traceDirs: string[] }> {
  const allChecks: CheckResult[] = []
  const traceDirs: string[] = []

  const FLASH = "test/deepseek-v4-flash"
  const MAIN = "test/main"
  const FREE_A = "test/free-a"
  const FREE_B = "test/free-b"
  const FREE_PRICE: ModelBandPricing = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
  const PRICING: Record<string, ModelBandPricing> = {
    [FLASH]: { input: 0.3, output: 0.9, cache_read: 0, cache_write: 0 },
    [MAIN]: { input: 10, output: 30, cache_read: 0, cache_write: 0 },
    [FREE_A]: FREE_PRICE,
    [FREE_B]: FREE_PRICE,
  }
  const resolveTier = (tier: ModelTier, mainModel: string, extraUnavailable?: Iterable<string>, allowPaidWorkers = false) =>
    resolveModelBand({
      requestedTier: tier,
      candidates: [
        { model: FREE_A, pricing: FREE_PRICE },
        { model: FREE_B, pricing: FREE_PRICE },
        { model: FLASH, pricing: PRICING[FLASH] },
      ],
      mainModel,
      mainPricing: PRICING[mainModel],
      unavailable: new Set(extraUnavailable ?? []),
      allowPaidWorkers,
    })

  // (1) the root stays on paid Flash only with explicit paid permission
  const root = resolveTier("strong", FLASH, undefined, true)
  allChecks.push(
    root !== undefined && root.model === FLASH
      ? ok("Root paid model allowed with explicit permission")
      : fail("Root paid model allowed with explicit permission", [root ? `model=${root.model} band=${root.band}` : "no-eligible-candidate"]),
  )
  const rootFreeOnly = resolveTier("strong", FLASH)
  allChecks.push(
    rootFreeOnly === undefined || rootFreeOnly.band === "free"
      ? ok("Child strong tier without paid permission stays free-only")
      : fail("Child strong tier without paid permission stays free-only", [
          rootFreeOnly ? `model=${rootFreeOnly.model} band=${rootFreeOnly.band}` : "no-eligible-candidate",
        ]),
  )

  // (2) an ordinary balanced worker resolves into the free pool, not Flash
  const ordinary = resolveTier("balanced", MAIN)
  allChecks.push(
    ordinary !== undefined &&
      ordinary.model !== FLASH &&
      ordinary.band === "free" &&
      (ordinary.model === FREE_A || ordinary.model === FREE_B)
      ? ok("Ordinary worker (balanced) resolves free, not Flash")
      : fail("Ordinary worker (balanced) resolves free, not Flash", [
          ordinary ? `model=${ordinary.model} band=${ordinary.band}` : "no-eligible-candidate",
        ]),
  )

  // shared persistence file for the quarantine scenarios
  const availabilityDir = mkdtempSync(join(tmpdir(), "oma-e2e-cost-"))
  const availabilityFile = join(availabilityDir, "model-availability.json")
  traceDirs.push(availabilityDir)

  const paidFlashWorker: WorkerCandidate = { model_id: FLASH, tier: "cheap_paid", capability: 0.9, free: false }
  const run = startRun([freeWorker(FREE_A), freeWorker(FREE_B), paidFlashWorker], "job-cost", {
    modelAvailabilityFilePath: availabilityFile,
  })
  traceDirs.push(run.auditRoot)

  // (3) a disabled free model is quarantined and the quarantine persists
  run.rt.recordModelUnavailable("child-1", FREE_A, "Model is disabled")
  let events = await snapshot(run)
  allChecks.push(
    eventNames(events).includes("worker_model_unavailable")
      ? ok("Disabled free model quarantine event")
      : fail("Disabled free model quarantine event", [`events=${eventNames(events).join(",")}`]),
  )
  allChecks.push(
    run.rt.unavailableModels().includes(FREE_A)
      ? ok("Disabled free model marked unavailable")
      : fail("Disabled free model marked unavailable", [`unavailable=${run.rt.unavailableModels().join(",")}`]),
  )
  const persisted = loadPersistentAvailability(availabilityFile)
  allChecks.push(
    persisted.entries[FREE_A]?.classification === "disabled"
      ? ok("Disabled free quarantine persisted to disk")
      : fail("Disabled free quarantine persisted to disk", [`entries=${JSON.stringify(persisted.entries)}`]),
  )

  // (4) the replacement worker stays in the free pool while free-b exists
  allChecks.push(
    run.sink.relaunches.length === 1 && run.sink.relaunches[0]?.worker === FREE_B
      ? ok("Replacement worker stays in free pool")
      : fail("Replacement worker stays in free pool", [
          `relaunches=${run.sink.relaunches.length} worker=${run.sink.relaunches[0]?.worker}`,
        ]),
  )
  const withQuarantine = resolveTier("balanced", MAIN, run.rt.unavailableModels())
  allChecks.push(
    withQuarantine !== undefined && withQuarantine.model !== FLASH && withQuarantine.model === FREE_B
      ? ok("Resolver routes to free-b, not Flash, while free-b remains")
      : fail("Resolver routes to free-b, not Flash, while free-b remains", [
          withQuarantine ? `model=${withQuarantine.model}` : "no-eligible-candidate",
        ]),
  )

  // (5) a fresh runtime sharing only the file remembers the quarantine
  const freshAuditRoot = mkdtempSync(join(tmpdir(), "oma-e2e-rt-"))
  traceDirs.push(freshAuditRoot)
  const freshAudit = createGovernanceAuditWriter({ root: freshAuditRoot })
  const freshRt = createDelegationFirstRuntime(freshAudit, { modelAvailabilityFilePath: availabilityFile })
  const freshSink = makeSink()
  freshRt.setRecoverySink({ cancel: freshSink.cancel, relaunch: freshSink.relaunch })
  allChecks.push(
    freshRt.unavailableModels().includes(FREE_A)
      ? ok("Fresh runtime hydrates quarantine without a new mark")
      : fail("Fresh runtime hydrates quarantine without a new mark", [
          `unavailable=${freshRt.unavailableModels().join(",")}`,
        ]),
  )
  allChecks.push(
    freshSink.relaunches.length === 0
      ? ok("Fresh runtime never re-attempts the disabled free model")
      : fail("Fresh runtime never re-attempts the disabled free model", [`relaunches=${freshSink.relaunches.length}`]),
  )
  const freshResolution = resolveTier("balanced", MAIN, freshRt.unavailableModels())
  allChecks.push(
    freshResolution !== undefined && freshResolution.model !== FREE_A && freshResolution.model === FREE_B
      ? ok("Fresh-runtime routing skips the disabled free model")
      : fail("Fresh-runtime routing skips the disabled free model", [
          freshResolution ? `model=${freshResolution.model}` : "no-eligible-candidate",
        ]),
  )
  await freshAudit.flush()
  freshRt.dispose()

  // (6) Flash is never consumed while a free model remains eligible
  allChecks.push(
    run.sink.relaunches.every((record) => record.worker !== FLASH)
      ? ok("Flash not consumed while a free model remains")
      : fail("Flash not consumed while a free model remains", [
          `relaunches=${run.sink.relaunches.map((record) => record.worker).join(",")}`,
        ]),
  )

  // (7) paid Flash is reached only by free-pool exhaustion or explicit strong routing
  run.rt.recordModelUnavailable("child-2", FREE_B, "Model is disabled")
  events = await snapshot(run)
  allChecks.push(
    run.sink.relaunches.length === 2 && run.sink.relaunches[1]?.worker === FLASH
      ? ok("Flash escalated only after free-pool exhaustion")
      : fail("Flash escalated only after free-pool exhaustion", [
          `relaunches=${run.sink.relaunches.map((record) => record.worker).join(",")}`,
        ]),
  )
  allChecks.push(
    countNamed(events, "worker_model_unavailable") === 2 && countNamed(events, "retry_chain_exhausted") === 0
      ? ok("Both free models quarantined without chain exhaustion")
      : fail("Both free models quarantined without chain exhaustion", [
          `worker_model_unavailable=${countNamed(events, "worker_model_unavailable")} retry_chain_exhausted=${countNamed(events, "retry_chain_exhausted")}`,
        ]),
  )
  const exhausted = resolveTier("balanced", MAIN, [FREE_A, FREE_B])
  allChecks.push(
    exhausted === undefined
      ? ok("Free exhaustion blocks paid escalation by default")
      : fail("Free exhaustion blocks paid escalation by default", [
          exhausted ? `model=${exhausted.model} band=${exhausted.band}` : "no-eligible-candidate",
        ]),
  )
  const exhaustedPaid = resolveTier("balanced", MAIN, [FREE_A, FREE_B], true)
  allChecks.push(
    exhaustedPaid !== undefined && exhaustedPaid.model === FLASH && exhaustedPaid.escalated
      ? ok("Free exhaustion escalates to Flash with explicit paid permission")
      : fail("Free exhaustion escalates to Flash with explicit paid permission", [
          exhaustedPaid ? `model=${exhaustedPaid.model} band=${exhaustedPaid.band}` : "no-eligible-candidate",
        ]),
  )
  const explicitStrong = resolveTier("strong", MAIN, undefined, true)
  allChecks.push(
    explicitStrong !== undefined && explicitStrong.model === FLASH && explicitStrong.band === "strong_paid"
      ? ok("Explicit strong routing resolves paid Flash with permission")
      : fail("Explicit strong routing resolves paid Flash with permission", [
          explicitStrong ? `model=${explicitStrong.model} band=${explicitStrong.band}` : "no-eligible-candidate",
        ]),
  )
  const masterFreeOnly = resolveTier("master", MAIN)
  allChecks.push(
    masterFreeOnly === undefined || masterFreeOnly.band === "free"
      ? ok("Master tier does not imply paid permission")
      : fail("Master tier does not imply paid permission", [
          masterFreeOnly ? `model=${masterFreeOnly.model} band=${masterFreeOnly.band}` : "no-eligible-candidate",
        ]),
  )
  const stillFree = resolveTier("balanced", MAIN)
  allChecks.push(
    stillFree !== undefined && stillFree.model !== FLASH && stillFree.band === "free"
      ? ok("No Flash escalation while the free pool remains")
      : fail("No Flash escalation while the free pool remains", [
          stillFree ? `model=${stillFree.model} band=${stillFree.band}` : "no-eligible-candidate",
        ]),
  )

  // (8) paid child concurrency is capped at 1 by default
  const gate = createPaidWorkerGate()
  const g1 = gate.tryAcquire()
  const g2 = gate.tryAcquire()
  gate.release()
  const g3 = gate.tryAcquire()
  allChecks.push(
    g1 === true && g2 === false && g3 === true
      ? ok("Paid child concurrency capped at 1")
      : fail("Paid child concurrency capped at 1", [`g1=${g1} g2=${g2} g3=${g3}`]),
  )

  run.dispose()
  return { checks: allChecks, traceDirs }
}

export { startRun, snapshot, readAuditEvents, eventNames, countNamed, makeSink, freeWorker, assignment }
export type { FailoverRun, Sink, RelaunchRecord, AuditEvent }

/**
 * PAID CONSENT section: paid children require TRUE master/root authority plus a
 * fresh single-use operator approval for the exact launch. Drives the REAL
 * enforcePaidWorkerLaunch + PaidConsentRegistry with a deterministic fake
 * pricing catalog and deterministic consent providers. No real paid provider
 * call is ever made.
 */
export async function runPaidConsentScenarios(): Promise<{ checks: CheckResult[]; traceDirs: string[] }> {
  const allChecks: CheckResult[] = []
  const traceDirs: string[] = []
  const dir = mkdtempSync(join(tmpdir(), 'oma-paid-consent-'))
  traceDirs.push(dir)
  const audit = createGovernanceAuditWriter({ root: join(dir, 'gov') })

  const ROOT = 'ses_root'
  const TASK = 'paid-consent-e2e-task'
  const PAID = 'test/deepseek-v4-flash'
  const PAID_B = 'test/paid-b'
  const FREE_A = 'test/free-a'
  const PRICING: Record<string, ModelBandPricing> = {
    [FREE_A]: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    [PAID]: { input: 0.3, output: 0.9, cache_read: 0, cache_write: 0 },
    [PAID_B]: { input: 0.5, output: 1.5, cache_read: 0, cache_write: 0 },
  }

  const gateInput = (overrides: Record<string, unknown> = {}) => ({
    resolvedModelKey: PAID,
    pricing: PRICING,
    modelRouting: undefined,
    isRootSession: true,
    rootSessionID: ROOT,
    workerIdentity: 'general',
    capabilityTier: 'strong',
    task: TASK,
    taskID: TASK,
    reason: 'free worker pool exhausted',
    freeCandidatesExhausted: true,
    consentProvider: createStaticConsentProvider('approved'),
    registry: new PaidConsentRegistry(),
    audit,
    ...overrides,
  })

  // 1. Child free-only: a free model never reaches the consent gate.
  {
    let prompts = 0
    const spy = {
      async request(): Promise<'approved'> {
        prompts += 1
        return 'approved'
      },
    }
    const verdict = await enforcePaidWorkerLaunch(
      gateInput({ resolvedModelKey: FREE_A, consentProvider: spy }),
    )
    allChecks.push(
      verdict.action === 'allow_free' && prompts === 0 && classifyPaidStatus(FREE_A, PRICING) === 'free'
        ? ok('Child free-only')
        : fail('Child free-only', [JSON.stringify(verdict), `prompts=${prompts}`]),
    )
  }

  // 2. Child cannot authorize paid.
  {
    const verdict = await enforcePaidWorkerLaunch(gateInput({ isRootSession: false }))
    allChecks.push(
      verdict.action === 'block' && verdict.code === PAID_WORKER_AUTHORITY_REJECTED
        ? ok('Child cannot authorize paid')
        : fail('Child cannot authorize paid', [JSON.stringify(verdict)]),
    )
  }

  // 3. Master may request paid: approval prompt created and granted.
  {
    const verdict = await enforcePaidWorkerLaunch(gateInput({}))
    allChecks.push(
      verdict.action === 'allow_paid'
        ? ok('Master may request paid')
        : fail('Master may request paid', [JSON.stringify(verdict)]),
    )
  }

  // 4. Operator denial blocks launch: zero paid launches.
  {
    const verdict = await enforcePaidWorkerLaunch(
      gateInput({ consentProvider: createStaticConsentProvider('denied') }),
    )
    allChecks.push(
      verdict.action === 'block' && verdict.code === PAID_WORKER_CONSENT_DENIED
        ? ok('Operator denial blocks launch')
        : fail('Operator denial blocks launch', [JSON.stringify(verdict)]),
    )
  }

  // 5. Single-use approval: exactly one consume succeeds, then the nonce is spent.
  {
    const registry = new PaidConsentRegistry()
    const verdict = await enforcePaidWorkerLaunch(gateInput({ registry }))
    const identity = {
      rootSessionID: ROOT,
      workerIdentity: 'general',
      resolvedModelID: PAID,
      taskID: TASK,
    }
    const first = verdict.action === 'allow_paid'
      ? consumePaidApproval(registry, verdict.nonce, identity, audit)
      : null
    const second = verdict.action === 'allow_paid'
      ? consumePaidApproval(registry, verdict.nonce, identity, audit)
      : null
    allChecks.push(
      first !== null && second === null && registry.isConsumed(verdict.action === 'allow_paid' ? verdict.nonce : '')
        ? ok('Single-use approval')
        : fail('Single-use approval', [`first=${first !== null}`, `second=${second !== null}`]),
    )
  }

  // 6. Paid retry (model B after model A) requires a fresh approval.
  {
    const registry = new PaidConsentRegistry()
    const a = await enforcePaidWorkerLaunch(gateInput({ registry }))
    const identityA = {
      rootSessionID: ROOT,
      workerIdentity: 'general',
      resolvedModelID: PAID,
      taskID: TASK,
    }
    if (a.action === 'allow_paid') consumePaidApproval(registry, a.nonce, identityA, audit)
    const b = await enforcePaidWorkerLaunch(gateInput({ registry, resolvedModelKey: PAID_B }))
    const identityB = {
      rootSessionID: ROOT,
      workerIdentity: 'general',
      resolvedModelID: PAID_B,
      taskID: TASK,
    }
    const bConsumed = b.action === 'allow_paid'
      ? consumePaidApproval(registry, b.nonce, identityB, audit)
      : null
    allChecks.push(
      a.action === 'allow_paid' && b.action === 'allow_paid' && bConsumed !== null && b.nonce !== a.nonce
        ? ok('Paid retry requires new approval')
        : fail('Paid retry requires new approval', [JSON.stringify(a), JSON.stringify(b)]),
    )
  }

  // 7. Approval cannot be replayed across a different model or task.
  {
    const registry = new PaidConsentRegistry()
    const a = await enforcePaidWorkerLaunch(gateInput({ registry }))
    if (a.action === 'allow_paid') {
      const identityWrongModel = {
        rootSessionID: ROOT,
        workerIdentity: 'general',
        resolvedModelID: PAID_B,
        taskID: TASK,
      }
      const identityWrongTask = {
        rootSessionID: ROOT,
        workerIdentity: 'general',
        resolvedModelID: PAID,
        taskID: 'other-task',
      }
      const wrongModel = consumePaidApproval(registry, a.nonce, identityWrongModel, audit)
      const wrongTask = consumePaidApproval(registry, a.nonce, identityWrongTask, audit)
      allChecks.push(
        wrongModel === null && wrongTask === null
          ? ok('Approval cannot be replayed')
          : fail('Approval cannot be replayed', [`wrongModel=${wrongModel !== null}`, `wrongTask=${wrongTask !== null}`]),
      )
    } else {
      allChecks.push(fail('Approval cannot be replayed', ['gate did not approve']))
    }
  }

  // 8. Nested child cannot spoof master authority.
  {
    const nested = isRootSessionInfo({ parentID: 'ses_parent' })
    const verdict = await enforcePaidWorkerLaunch(gateInput({ isRootSession: false, rootSessionID: 'ses_child' }))
    allChecks.push(
      nested === false && verdict.action === 'block' && verdict.code === PAID_WORKER_AUTHORITY_REJECTED
        ? ok('Nested child cannot spoof master')
        : fail('Nested child cannot spoof master', [`nested=${nested}`, JSON.stringify(verdict)]),
    )
  }

  // 9. Non-interactive environment fails closed.
  {
    const provider = createOpenCodePermissionConsentProvider(undefined)
    const verdict = await enforcePaidWorkerLaunch(gateInput({ consentProvider: provider }))
    allChecks.push(
      verdict.action === 'block' && verdict.code === PAID_WORKER_CONSENT_UNAVAILABLE
        ? ok('Non-interactive fails closed')
        : fail('Non-interactive fails closed', [JSON.stringify(verdict)]),
    )
  }

  // 10. Paid concurrency never exceeds the configured limit (default 1).
  {
    const gate = createPaidWorkerGate(maxConcurrentPaidWorkers(undefined))
    const first = gate.tryAcquire()
    const second = gate.tryAcquire()
    allChecks.push(
      first === true && second === false && gate.activeCount() === 1
        ? ok('Paid concurrency <= 1')
        : fail('Paid concurrency <= 1', [`first=${first}`, `second=${second}`]),
    )
  }

  return { checks: allChecks, traceDirs }
}
