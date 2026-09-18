/**
 * Cross-runtime persistence scenarios for the negative model-availability
 * quarantine. Instance 1 marks a model disabled through the REAL
 * `DelegationFirstRuntime`, writing to one shared temp persistent store;
 * Instance 2 is a COMPLETELY fresh runtime sharing only that file and must
 * remember the quarantine WITHOUT any new markUnavailable call (hydration
 * from disk at construction). A same-file variant then proves TTL expiry
 * restores eligibility: once the persisted `retryAfterAt` is in the past, a
 * fresh runtime no longer quarantines the model.
 *
 * No external model, no network, no paid call. Deterministic PASS/FAIL.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createGovernanceAuditWriter } from "../packages/omo-opencode/src/shared/governance-audit"
import {
  createDelegationFirstRuntime,
  type DelegationFirstRuntime,
} from "../packages/omo-opencode/src/features/delegation-first"
import {
  loadPersistentAvailability,
  savePersistentAvailability,
} from "../packages/omo-opencode/src/features/delegation-first/persistent-model-availability"
import {
  freeWorker,
  makeSink,
  startRun,
  type CheckResult,
  type Sink,
} from "./e2e-routing-scenarios"

const MODEL = "test/worker-disabled"
const REASON = "Model is disabled"

type FreshRun = {
  rt: DelegationFirstRuntime
  sink: Sink
  auditRoot: string
  flush: () => Promise<void>
  dispose: () => void
}

/** A brand-new runtime with its own audit writer + sink, sharing only `filePath`. */
function createFreshRuntime(filePath: string): FreshRun {
  const auditRoot = mkdtempSync(join(tmpdir(), "oma-e2e-rt-"))
  const audit = createGovernanceAuditWriter({ root: auditRoot })
  const rt = createDelegationFirstRuntime(audit, { modelAvailabilityFilePath: filePath })
  const sink = makeSink()
  rt.setRecoverySink({ cancel: sink.cancel, relaunch: sink.relaunch })
  return {
    rt,
    sink,
    auditRoot,
    flush: () => audit.flush(),
    dispose: () => {
      void audit.flush()
      rt.dispose()
    },
  }
}

function ok(name: string): CheckResult {
  return { name, passed: true, failures: [] }
}
function fail(name: string, failures: string[]): CheckResult {
  return { name, passed: false, failures }
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
}

export async function runPersistenceScenarios(): Promise<{ checks: CheckResult[]; traceDirs: string[] }> {
  const allChecks: CheckResult[] = []
  const traceDirs: string[] = []

  // One shared temp persistent availability file for both instances.
  const availabilityDir = mkdtempSync(join(tmpdir(), "oma-e2e-avail-"))
  const availabilityFile = join(availabilityDir, "model-availability.json")
  traceDirs.push(availabilityDir)

  // ---- Scenario 6: instance 1 marks X disabled, instance 2 (fresh, same
  //                   file) remembers X WITHOUT any new markUnavailable call.
  {
    const run1 = startRun([freeWorker(MODEL), freeWorker("test/worker-ok")], "job-persist", {
      modelAvailabilityFilePath: availabilityFile,
    })
    traceDirs.push(run1.auditRoot)

    run1.rt.recordModelUnavailable("child-1", MODEL, REASON)
    allChecks.push(
      run1.rt.unavailableModels().includes(MODEL)
        ? ok("Instance 1 marks model unavailable")
        : fail("Instance 1 marks model unavailable", [`unavailableModels=${run1.rt.unavailableModels().join(",")}`]),
    )
    allChecks.push(
      run1.rt.getAvailabilityFilePath() === availabilityFile
        ? ok("Instance 1 resolves the shared persistent availability file")
        : fail("Instance 1 resolves the shared persistent availability file", [
            `path=${run1.rt.getAvailabilityFilePath()}`,
          ]),
    )

    // Dispose instance 1 fully (flush audit); the quarantine was already
    // persisted to disk synchronously by recordModelUnavailable.
    await run1.flush()
    run1.dispose()

    // The persisted file carries the full entry
    // (provider/model/reason/classification/firstFailureAt/lastFailureAt/
    // retryAfterAt/consecutiveFailures).
    const persisted = loadPersistentAvailability(availabilityFile)
    const entry = persisted.entries[MODEL]
    const entryFields: Array<[string, unknown]> = entry
      ? [
          ["provider", entry.provider],
          ["model", entry.model],
          ["reason", entry.reason],
          ["classification", entry.classification],
          ["firstFailureAt", entry.firstFailureAt],
          ["lastFailureAt", entry.lastFailureAt],
          ["retryAfterAt", entry.retryAfterAt],
          ["consecutiveFailures", entry.consecutiveFailures],
        ]
      : []
    const entryOk =
      entry !== undefined &&
      entry.provider === "test" &&
      entry.model === "worker-disabled" &&
      entry.reason === REASON &&
      entry.classification === "disabled" &&
      isIsoTimestamp(entry.firstFailureAt) &&
      isIsoTimestamp(entry.lastFailureAt) &&
      isIsoTimestamp(entry.retryAfterAt) &&
      Date.parse(entry.retryAfterAt) > Date.parse(entry.firstFailureAt) &&
      entry.consecutiveFailures === 1
    allChecks.push(
      entryOk
        ? ok("Persisted file carries quarantine entry fields")
        : fail("Persisted file carries quarantine entry fields", [
            `entry=${JSON.stringify(entryFields.length ? Object.fromEntries(entryFields) : persisted.entries)}`,
          ]),
    )

    // Instance 2: COMPLETELY fresh runtime sharing only the same file. No
    // recordModelUnavailable call happens on this instance before the check.
    const run2 = startRun([freeWorker(MODEL), freeWorker("test/worker-ok")], "job-persist-2", {
      modelAvailabilityFilePath: availabilityFile,
    })
    traceDirs.push(run2.auditRoot)
    allChecks.push(
      run2.rt.unavailableModels().includes(MODEL)
        ? ok("Fresh instance 2 hydrates quarantine from disk (no new mark)")
        : fail("Fresh instance 2 hydrates quarantine from disk (no new mark)", [
            `unavailableModels=${run2.rt.unavailableModels().join(",")}`,
          ]),
    )

    // Optional: the candidate ladder skips the hydrated-disabled model and
    // dispatches the next eligible worker (worker-ok), never re-selecting X.
    run2.rt.recordModelUnavailable("child-1", MODEL, REASON)
    allChecks.push(
      run2.sink.relaunches.length === 1 && run2.sink.relaunches[0]?.worker === "test/worker-ok"
        ? ok("Candidate ladder skips hydrated disabled model")
        : fail("Candidate ladder skips hydrated disabled model", [
            `relaunches=${run2.sink.relaunches.length} worker=${run2.sink.relaunches[0]?.worker}`,
          ]),
    )
    await run2.flush()
    run2.dispose()

    // ---- Scenario 7: same file, TTL-expired entry -> eligibility restored.
    const ttlExpired = loadPersistentAvailability(availabilityFile)
    const expiredEntry = ttlExpired.entries[MODEL]
    if (expiredEntry) {
      expiredEntry.retryAfterAt = "2000-01-01T00:00:00.000Z"
      savePersistentAvailability(availabilityFile, ttlExpired)
    }

    const run3 = createFreshRuntime(availabilityFile)
    traceDirs.push(run3.auditRoot)
    allChecks.push(
      !run3.rt.unavailableModels().includes(MODEL)
        ? ok("TTL-expired quarantine restores eligibility in fresh instance")
        : fail("TTL-expired quarantine restores eligibility in fresh instance", [
            `unavailableModels=${run3.rt.unavailableModels().join(",")}`,
          ]),
    )
    await run3.flush()
    run3.dispose()
  }

  return { checks: allChecks, traceDirs }
}