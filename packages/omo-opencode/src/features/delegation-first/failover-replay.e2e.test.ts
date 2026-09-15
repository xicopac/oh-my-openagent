import { describe, test, expect } from "bun:test"
import {
  authorizeChildDispatch,
  assertAuthorizedChildLaunch,
  ResourceGovernorRejectedError,
  createResourceGovernorRuntime,
  resolvedModelKey,
  type PricingCatalog,
  type ResourceGovernorRuntime,
} from "../../hooks/resource-governor"
import { ResourceGovernorConfigSchema } from "../../config/schema/resource-governor"
import { createDelegationFirstRuntime } from "./runtime"
import type { ReplayableAssignment } from "./replay"
import type { RelaunchOutcome } from "./runtime"
import type { GovernanceAuditWriter } from "../../shared/governance-audit"
import type { WorkerCandidate } from "../delegation-ladder"

type CapturedEvent = { sessionID: string; fields: Record<string, unknown> }

function captureAudit(): { writer: GovernanceAuditWriter; events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  const writer: GovernanceAuditWriter = {
    write: (sessionID, fields) => events.push({ sessionID, fields }),
    path: () => "/dev/null",
    flush: async () => {},
  }
  return { writer, events }
}

function names(events: CapturedEvent[]): string[] {
  return events.map((e) => String(e.fields.event))
}

const FREE_A = "openai/free-a"
const FREE_B = "anthropic/free-b"
const FREE_C = "meta/free-c"
const PAID_A = "openai/paid-a"

function free(id: string): WorkerCandidate {
  return { model_id: id, tier: "free", capability: 0.7, free: true }
}

function paid(id: string): WorkerCandidate {
  return { model_id: id, tier: "cheap_paid", capability: 1.0, free: false, cost_usd_per_1m_input: 1 }
}

function pricing(freeModels: string[]): PricingCatalog {
  const catalog: PricingCatalog = {}
  for (const id of freeModels) {
    catalog[id] = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
  }
  catalog[PAID_A] = { input: 3, output: 15, cache_read: 0, cache_write: 0 }
  return catalog
}

function config() {
  return ResourceGovernorConfigSchema.parse({})
}

function freeRuntime(): ResourceGovernorRuntime {
  return createResourceGovernorRuntime({ config: config(), pricing: pricing([FREE_A, FREE_B, FREE_C]) })
}

/** Exhausted governor: root spend already past the hard paid ceiling. */
function exhaustedRuntime(): ResourceGovernorRuntime {
  const runtime = createResourceGovernorRuntime({ config: config(), pricing: pricing([FREE_A, FREE_B, FREE_C]) })
  runtime.recordRootUsage("root", {
    model_id: "deepseek/deepseek-v4-pro",
    provider_id: "deepseek",
    tier: "master",
    free: false,
    input_tokens: 1_000_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: 3.5,
    cost_estimated: true,
    context_tokens: 1_000_000,
    retries: 0,
    status: "active",
    avoidable_tokens: 0,
  })
  return runtime
}

type LaunchRecord = {
  taskID: string
  sessionID: string
  parentSessionID: string
  resolvedModelID: string
}

/**
 * A relaunch sink that mirrors the real governed launch boundary: authorize
 * through the Resource Governor, then redeem the one-shot backstop proof at
 * the session.create boundary, exactly like BackgroundManager.launch.
 */
function governedRelaunch(runtime: ResourceGovernorRuntime): {
  relaunch: (assignment: ReplayableAssignment, action: never, prompt: string) => RelaunchOutcome
  launches: LaunchRecord[]
} {
  const launches: LaunchRecord[] = []
  let counter = 0
  return {
    launches,
    relaunch: (assignment, action) => {
      const parsedModel = action.worker.model_id
      const model = parseModel(parsedModel)
      const resolvedModelID = model ? resolvedModelKey(model.providerID, model.modelID) : null
      const rootModelID = assignment.parent_model?.providerID
        ? `${assignment.parent_model.providerID}/${assignment.parent_model.modelID}`
        : null
      try {
        const result = authorizeChildDispatch(runtime, {
          sessionID: assignment.parent_session_id,
          role: assignment.agent,
          workerIdentity: assignment.agent,
          subtask: assignment.prompt,
          resolvedModelID,
          requestedTier: null,
          expectedTokens: 600_000,
          rootModelID,
        })
        if (result.verdict !== "ALLOW") {
          throw new ResourceGovernorRejectedError(result.message)
        }
        if (result.authorization) {
          assertAuthorizedChildLaunch(
            { guard: runtime.launchGuard, token: result.authorization.token },
            { sessionID: assignment.parent_session_id, workerIdentity: assignment.agent, resolvedModelID: result.authorization.resolvedModelID },
          )
        }
        counter += 1
        const sessionID = `child-replacement-${counter}`
        launches.push({ taskID: `bg-r${counter}`, sessionID, parentSessionID: assignment.parent_session_id, resolvedModelID: resolvedModelID ?? "" })
        return { kind: "launched", taskID: `bg-r${counter}`, sessionID }
      } catch (error) {
        return { kind: "blocked", reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function parseModel(modelID: string): { providerID: string; modelID: string; variant?: string } | undefined {
  const slash = modelID.indexOf("/")
  if (slash <= 0) return undefined
  return { providerID: modelID.slice(0, slash), modelID: modelID.slice(slash + 1) }
}

function assignmentId(id: string, workers: WorkerCandidate[]): ReplayableAssignment {
  return {
    assignment_id: id,
    root_session_id: "root",
    parent_session_id: "root",
    parent_message_id: "msg-root",
    prompt: "map auth middleware and token refresh flow",
    description: "map auth",
    agent: "explore",
    category: "explore",
    parent_model: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    workers,
  }
}

function dispatchAndStall(
  rt: ReturnType<typeof createDelegationFirstRuntime>,
  sessionID: string,
): void {
  rt.attachChildSession("root", sessionID)
  rt.markRequestStarted(sessionID)
  rt.checkAllWatchdogs(Date.now() + 200_000)
  rt.reclaimStalled(sessionID, "openai/free-a", Date.now() + 200_000)
}

describe("automatic child failover real-path E2E (deterministic, no paid call)", () => {
  test("Scenario A: provider-response stall -> alternate child auto-dispatched -> completes -> root receives result", () => {
    // given a governed relaunch over the real Resource Governor + backstop
    const { writer, events } = captureAudit()
    const runtime = freeRuntime()
    const rt = createDelegationFirstRuntime(writer, { pricing: pricing([FREE_A, FREE_B, FREE_C]) })
    const gov = governedRelaunch(runtime)
    rt.setRecoverySink({ cancel: async () => {}, relaunch: gov.relaunch as never })
    rt.retainAssignment(assignmentId("jobA", [free(FREE_A), free(FREE_B)]), "child1")

    // when: child 1 provider-response-stalls and is reclaimed
    dispatchAndStall(rt, "child1")

    // then: an alternate replacement was dispatched through the governor + backstop
    expect(gov.launches.length).toBe(1)
    expect(gov.launches[0].resolvedModelID).toBe(FREE_B)
    expect(gov.launches[0].parentSessionID).toBe("root")
    // the backstop proof was redeemed exactly once
    expect(runtime.launchGuard.consumedCount()).toBe(1)

    // when: the replacement session attaches and then completes
    const replacementSession = gov.launches[0].sessionID
    rt.noteReplacementSession("jobA", replacementSession)
    rt.attachChildSession("root", replacementSession)
    rt.watchdogActivity(replacementSession)
    rt.watchdogTerminal(replacementSession)
    rt.detachChildSession(replacementSession)

    // then: the replacement result path is the same logical assignment/root
    const allNames = names(events)
    expect(allNames).toContain("replacement_child_created")
    expect(allNames).toContain("replacement_child_completed")
    // the old child is terminal, the replacement is a distinct session
    expect(rt.checkWatchdog("child1").health).toBe("TERMINAL")
    // lineage advanced to a new worker
    expect(rt.lineage("jobA")?.attempt_number).toBe(2)
    expect(rt.lineage("jobA")?.current_worker).toBe(FREE_B)
  })

  test("Scenario B: three children on the same provider/model -> correlated, replacements do not all retry the same target", () => {
    // given
    const { writer, events } = captureAudit()
    const runtime = freeRuntime()
    const rt = createDelegationFirstRuntime(writer, { pricing: pricing([FREE_A, FREE_B, FREE_C]) })
    const gov = governedRelaunch(runtime)
    rt.setRecoverySink({ cancel: async () => {}, relaunch: gov.relaunch as never })
    const t0 = Date.now()
    const workers = [free(FREE_A), free(FREE_B), free(FREE_C)]
    // three parallel children on the same free model
    for (const [i, sid] of ["s1", "s2", "s3"].entries()) {
      rt.retainAssignment(assignmentId(`jobB-${i}`, workers), sid)
      rt.attachChildSession("root", sid)
      rt.markRequestStarted(sid)
    }
    // when: all three stall at the same provider model and are reclaimed
    for (const sid of ["s1", "s2", "s3"]) {
      rt.checkAllWatchdogs(t0 + 200_000)
      rt.reclaimStalled(sid, FREE_A, t0 + 200_000)
    }
    // then: correlated detection fired, and not every replacement landed on FREE_A
    const planned = events.filter((e) => e.fields.event === "worker_retry_planned")
    expect(planned.some((e) => e.fields.correlated === true)).toBe(true)
    const targets = gov.launches.map((l) => l.resolvedModelID)
    expect(targets.every((t) => t === FREE_A)).toBe(false)
  })

  test("Scenario C: a replacement past the hard budget is blocked truthfully with no silent bypass", () => {
    // given: an exhausted governor (paid ceiling already crossed) and a paid ladder
    const { writer, events } = captureAudit()
    const runtime = exhaustedRuntime()
    const rt = createDelegationFirstRuntime(writer, { pricing: pricing([FREE_A, FREE_B, FREE_C]) })
    const gov = governedRelaunch(runtime)
    rt.setRecoverySink({ cancel: async () => {}, relaunch: gov.relaunch as never })
    // workers are all paid -> the replacement requires paid spend, which is blocked
    rt.retainAssignment(assignmentId("jobC", [paid(PAID_A)]), "child1")

    // when
    dispatchAndStall(rt, "child1")

    // then: no child launched, the block is journaled truthfully
    expect(gov.launches.length).toBe(0)
    const allNames = names(events)
    expect(allNames).toContain("replacement_child_blocked")
    expect(allNames).toContain("retry_chain_exhausted")
    // the original child is terminal, never left running
    expect(rt.checkWatchdog("child1").health).toBe("TERMINAL")
  })
})
