import { describe, test, expect } from "bun:test"
import { BackgroundManager } from "./manager"
import { ResourceGovernorRejectedError } from "../../hooks/resource-governor"
import type { AuthorizeResult, DelegateEnforcementInput } from "../../hooks/resource-governor"

type Authorizer = (input: DelegateEnforcementInput) => AuthorizeResult
type Settler = (sessionID: string, escrowID: string, status: "completed" | "failed" | "exhausted") => void

function managerWithAuthorizer(authorize?: Authorizer, settle?: Settler): BackgroundManager {
  const client = {
    session: {
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
    },
  }
  return new BackgroundManager({
    pluginContext: { client, directory: "/tmp" } as never,
    authorizeChildDispatch: authorize,
    resourceGovernorDefaultChildTokens: 600_000,
    settleChildDispatch: settle,
  })
}

function launchInput() {
  return {
    description: "inspect auth flow",
    prompt: "trace the login path",
    agent: "explore",
    parentSessionId: "parent-session",
    parentMessageId: "parent-message",
    model: { providerID: "openai", modelID: "gpt-5.6-sol" },
    parentModel: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
  }
}

describe("BackgroundManager resource governor enforcement", () => {
  test("blocks a paid child when the governor returns BLOCK and never reaches session.create", async () => {
    // given a manager whose injected authorizer blocks
    let seen: DelegateEnforcementInput | undefined
    const manager = managerWithAuthorizer((input) => {
      seen = input
      return { verdict: "BLOCK", condition: "RESOURCE_BUDGET_EXHAUSTED", message: "[resource-governor] RESOURCE_BUDGET_EXHAUSTED: paid spend ceiling reached" }
    })

    // when a child is launched
    await expect(manager.launch(launchInput())).rejects.toBeInstanceOf(ResourceGovernorRejectedError)

    // then the resolved model and root model were passed to the governor
    expect(seen?.resolvedModelID).toBe("openai/gpt-5.6-sol")
    expect(seen?.rootModelID).toBe("deepseek/deepseek-v4-pro")
    expect(seen?.sessionID).toBe("parent-session")
  })

  test("treats REQUIRE_CONSENT as a blocking verdict (model cannot self-approve)", async () => {
    const manager = managerWithAuthorizer(() => ({
      verdict: "REQUIRE_CONSENT",
      reason: "paid_escalation_boundary",
      message: "[resource-governor] consent required",
    }))

    await expect(manager.launch(launchInput())).rejects.toBeInstanceOf(ResourceGovernorRejectedError)
  })

  test("does not authorize when no authorizer is injected (governor disabled)", async () => {
    // given a manager with no governor authorizer
    const manager = managerWithAuthorizer(undefined)

    // when launch is called with an unknown agent that fails upstream validation
    // then it does NOT throw ResourceGovernorRejectedError (no governor in the path)
    try {
      await manager.launch(launchInput())
    } catch (error) {
      expect(error).not.toBeInstanceOf(ResourceGovernorRejectedError)
    }
  })

  test("settles a child escrow exactly once (idempotent) when a task reaches a terminal status", () => {
    // given a manager whose authorizer allows and which records settlements
    const settled: Array<{ sessionID: string; escrowID: string; status: string }> = []
    const manager = managerWithAuthorizer(
      () => ({ verdict: "ALLOW", escrowID: "escrow-1" }),
      (sessionID, escrowID, status) => settled.push({ sessionID, escrowID, status }),
    )
    const escrowByTask = Reflect.get(manager, "escrowByTask") as Map<string, { sessionID: string; escrowID: string }>
    escrowByTask.set("task-1", { sessionID: "parent-session", escrowID: "escrow-1" })
    const settleTaskEscrow = Reflect.get(manager, "settleTaskEscrow") as (
      task: { id: string },
      status: "completed" | "failed" | "exhausted",
    ) => void

    // when settlement runs twice (e.g. completion + late error path)
    settleTaskEscrow.call(manager, { id: "task-1" }, "completed")
    settleTaskEscrow.call(manager, { id: "task-1" }, "failed")

    // then the escrow is settled exactly once with the first terminal status
    expect(settled).toEqual([{ sessionID: "parent-session", escrowID: "escrow-1", status: "completed" }])
    expect(escrowByTask.has("task-1")).toBe(false)
  })
})
