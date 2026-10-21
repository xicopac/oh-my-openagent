/**
 * Deterministic E2E scenarios for watchdog liveness: dead/stalled-child
 * reclaim and child model-failure failover. These drive the REAL
 * `DelegationFirstRuntime` (the exact production object wired into `task`)
 * with a deterministic clock advance and injected recovery sinks, and assert
 * on the SAME structured events (the governance audit journal) that a live
 * OpenCode process would write.
 *
 * No external model, no network, no paid call. Deterministic PASS/FAIL.
 */
import {
  countNamed,
  eventNames,
  freeWorker,
  snapshot,
  startRun,
  type CheckResult,
} from "./e2e-routing-scenarios"

/** Clock advance past the 180s quiet/provider-response stall thresholds. */
const STALL_ADVANCE_MS = 200_000
/** Hard cap on redrive sweeps: proves bounded termination (no infinite loop). */
const MAX_SWEEPS = 5

function ok(name: string): CheckResult {
  return { name, passed: true, failures: [] }
}
function fail(name: string, failures: string[]): CheckResult {
  return { name, passed: false, failures }
}

export async function runWatchdogLivenessScenarios(): Promise<{ checks: CheckResult[]; traceDirs: string[] }> {
  const allChecks: CheckResult[] = []
  const traceDirs: string[] = []
  let totalDispatched = 0
  let totalReclaimed = 0
  let totalReplaced = 0

  // ---- Scenario A: DEAD/STALLED CHILD -------------------------------------
  // given: a registered child that stops producing progress (no watchdogActivity
  // after request start); the deterministic clock advances past the stall
  // threshold.
  {
    const run = startRun([freeWorker("test/wd-stall-a"), freeWorker("test/wd-stall-b")], "job-wd-stall")
    traceDirs.push(run.auditRoot)
    traceDirs.push(run.availabilityRoot)
    const t0 = Date.now()
    let dispatched = 1

    // when: the clock advances past the stall threshold
    const sweep = run.rt.checkAllWatchdogs(t0 + STALL_ADVANCE_MS)
    const suspect = sweep.find((entry) => entry.sessionID === "child-1")
    allChecks.push(
      suspect !== undefined && suspect.result.timedOut === true
        ? ok("Stall suspected after clock advance (timed out)")
        : fail("Stall suspected after clock advance (timed out)", [
            `timedOut=${String(suspect?.result.timedOut)} mode=${String(suspect?.result.stallMode)}`,
          ]),
    )
    let events = await snapshot(run)
    allChecks.push(
      eventNames(events).includes("watchdog_stall_suspected")
        ? ok("watchdog_stall_suspected emitted")
        : fail("watchdog_stall_suspected emitted", [`events=${eventNames(events).join(",")}`]),
    )

    // when: the stalled child is reclaimed
    run.rt.reclaimStalled("child-1", "test/wd-stall-a", t0 + STALL_ADVANCE_MS)
    events = await snapshot(run)
    const names = eventNames(events)
    allChecks.push(
      names.includes("watchdog_reclaimed") && names.includes("worker_reclaimed")
        ? ok("Stalled child reclaimed (watchdog_reclaimed + worker_reclaimed)")
        : fail("Stalled child reclaimed (watchdog_reclaimed + worker_reclaimed)", [
            `events=${names.join(",")}`,
          ]),
    )
    allChecks.push(
      run.sink.relaunches.length === 1 && run.sink.relaunches[0]?.worker === "test/wd-stall-b"
        ? ok("Replacement dispatched to alternate worker")
        : fail("Replacement dispatched to alternate worker", [
            `relaunches=${run.sink.relaunches.length} worker=${run.sink.relaunches[0]?.worker}`,
          ]),
    )
    allChecks.push(
      names.includes("replacement_child_created")
        ? ok("Replacement child created (stall path)")
        : fail("Replacement child created (stall path)", ["missing replacement_child_created"]),
    )

    // when: the replacement ALSO stalls in the same episode -> the shared
    // episode budget must exhaust instead of looping forever.
    run.rt.noteReplacementSession("job-wd-stall", "child-2")
    run.rt.attachChildSession("root", "child-2")
    run.rt.markRequestStarted("child-2")
    dispatched += 1
    run.rt.reclaimStalled("child-2", "test/wd-stall-b", t0 + STALL_ADVANCE_MS)
    events = await snapshot(run)
    const exhaustedNames = eventNames(events)
    const exhausted = events.filter((e) => e.event === "retry_chain_exhausted")
    const lastExhausted = exhausted[exhausted.length - 1]
    allChecks.push(
      String(lastExhausted?.reason ?? "") === "same_worker_reclaim_budget_exhausted"
        ? ok("Episode budget exhausted (same_worker_reclaim_budget_exhausted)")
        : fail("Episode budget exhausted (same_worker_reclaim_budget_exhausted)", [
            `reason=${String(lastExhausted?.reason ?? "none")}`,
          ]),
    )
    allChecks.push(
      run.sink.relaunches.length === 1
        ? ok("No second relaunch after budget exhaustion (bounded)")
        : fail("No second relaunch after budget exhaustion (bounded)", [
            `relaunches=${run.sink.relaunches.length}`,
          ]),
    )
    allChecks.push(
      exhaustedNames.includes("delegation_failure_recorded")
        ? ok("Parent failure recorded at exhaustion")
        : fail("Parent failure recorded at exhaustion", ["missing delegation_failure_recorded"]),
    )

    // when: bounded redrive sweeps look for further reclaimable children.
    // then: every previously reclaimed child is TERMINAL, so zero additional
    // reclaims happen and the loop exits on the first sweep (no infinite loop).
    let extraReclaims = 0
    let sweepsUsed = 0
    for (let sweepIndex = 0; sweepIndex < MAX_SWEEPS; sweepIndex += 1) {
      sweepsUsed += 1
      const results = run.rt.checkAllWatchdogs(t0 + STALL_ADVANCE_MS + sweepIndex * 1000)
      const reclaimable = results.filter(
        (entry) => entry.result.timedOut === true && run.rt.checkWatchdog(entry.sessionID).health !== "TERMINAL",
      )
      if (reclaimable.length === 0) break
      for (const entry of reclaimable) {
        run.rt.reclaimStalled(entry.sessionID, null, t0 + STALL_ADVANCE_MS + sweepIndex * 1000)
        extraReclaims += 1
      }
    }
    events = await snapshot(run)
    allChecks.push(
      extraReclaims === 0 && sweepsUsed === 1
        ? ok("Redrive sweep terminates (no infinite loop)")
        : fail("Redrive sweep terminates (no infinite loop)", [
            `extraReclaims=${extraReclaims} sweepsUsed=${sweepsUsed}`,
          ]),
    )
    allChecks.push(
      run.rt.checkWatchdog("child-1").health === "TERMINAL" &&
        run.rt.checkWatchdog("child-2").health === "TERMINAL"
        ? ok("Reclaimed children stay terminal")
        : fail("Reclaimed children stay terminal", [
            `child-1=${run.rt.checkWatchdog("child-1").health} child-2=${run.rt.checkWatchdog("child-2").health}`,
          ]),
    )

    const reclaimed = countNamed(events, "watchdog_reclaimed")
    const replaced = run.sink.relaunches.length
    totalDispatched += dispatched
    totalReclaimed += reclaimed
    totalReplaced += replaced
    console.log(
      `[watchdog-liveness] scenario A (dead-stalled child): dispatched=${dispatched} reclaimed=${reclaimed} replaced=${replaced} outcome=bounded-recovery`,
    )
    run.dispose()
  }

  // ---- Scenario B: CHILD LAUNCH/MODEL FAILURE ------------------------------
  // given: a two-candidate ladder where the first child's model is unavailable.
  {
    const run = startRun([freeWorker("test/wd-model-a"), freeWorker("test/wd-model-b")], "job-wd-model")
    traceDirs.push(run.auditRoot)
    traceDirs.push(run.availabilityRoot)

    // when: the first child's model is marked unavailable
    run.rt.recordModelUnavailable("child-1", "test/wd-model-a", "Model is disabled")
    let events = await snapshot(run)
    allChecks.push(
      eventNames(events).includes("worker_model_unavailable")
        ? ok("Model failure recorded (worker_model_unavailable)")
        : fail("Model failure recorded (worker_model_unavailable)", [
            `events=${eventNames(events).join(",")}`,
          ]),
    )
    allChecks.push(
      run.sink.relaunches.length === 1 && run.sink.relaunches[0]?.worker === "test/wd-model-b"
        ? ok("Alternate eligible worker dispatched")
        : fail("Alternate eligible worker dispatched", [
            `relaunches=${run.sink.relaunches.length} worker=${run.sink.relaunches[0]?.worker}`,
          ]),
    )
    allChecks.push(
      countNamed(events, "retry_chain_exhausted") === 0
        ? ok("No premature exhaustion while a candidate remains")
        : fail("No premature exhaustion while a candidate remains", ["retry_chain_exhausted emitted mid-failover"]),
    )

    // when: the last eligible model also fails (the sink's first relaunch
    // bound the replacement session to child-2, so it shares the episode).
    run.rt.recordModelUnavailable("child-2", "test/wd-model-b", "Model is disabled")
    events = await snapshot(run)
    const exhausted = events.filter((e) => e.event === "retry_chain_exhausted")
    const lastExhausted = exhausted[exhausted.length - 1]
    allChecks.push(
      exhausted.length === 1 && String(lastExhausted?.reason ?? "") === "no_eligible_worker"
        ? ok("Exhaustion with no_eligible_worker when no candidate remains")
        : fail("Exhaustion with no_eligible_worker when no candidate remains", [
            `retry_chain_exhausted=${exhausted.length} reason=${String(lastExhausted?.reason ?? "none")}`,
          ]),
    )
    allChecks.push(
      eventNames(events).includes("delegation_failure_recorded")
        ? ok("delegation_failure_recorded at model exhaustion")
        : fail("delegation_failure_recorded at model exhaustion", ["missing delegation_failure_recorded"]),
    )

    // when: bounded redrive attempts look for further eligible workers.
    // then: the ladder stays exhausted and zero additional relaunches happen
    // (no infinite failover loop).
    let extraRelaunches = 0
    for (let attempt = 0; attempt < MAX_SWEEPS; attempt += 1) {
      const before = run.sink.relaunches.length
      run.rt.recordModelUnavailable("child-2", "test/wd-model-b", "Model is disabled")
      if (run.sink.relaunches.length > before) extraRelaunches += run.sink.relaunches.length - before
    }
    events = await snapshot(run)
    allChecks.push(
      extraRelaunches === 0 && run.sink.relaunches.length === 1
        ? ok("Failover loop bounded (no infinite relaunch)")
        : fail("Failover loop bounded (no infinite relaunch)", [
            `extraRelaunches=${extraRelaunches} total=${run.sink.relaunches.length}`,
          ]),
    )

    const reclaimed = countNamed(events, "watchdog_reclaimed")
    const replaced = run.sink.relaunches.length
    totalDispatched += 1
    totalReclaimed += reclaimed
    totalReplaced += replaced
    console.log(
      `[watchdog-liveness] scenario B (model failure): dispatched=1 reclaimed=${reclaimed} replaced=${replaced} outcome=no-eligible-worker`,
    )
    run.dispose()
  }

  // ---- Scenario C: SUMMARY --------------------------------------------------
  console.log(
    `[watchdog-liveness] summary: children_dispatched=${totalDispatched} reclaimed=${totalReclaimed} replaced=${totalReplaced} control_returned_cleanly=yes`,
  )
  allChecks.push(ok("Control returned cleanly (bounded termination)"))

  return { checks: allChecks, traceDirs }
}
