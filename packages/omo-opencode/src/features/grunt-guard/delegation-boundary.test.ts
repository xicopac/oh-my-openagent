import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { classifyBoundaryRole, createPreGruntGate, decideDelegationFailure, evaluateRootToolBoundary } from "./gate"
import { classifyOperation } from "./classify"

import { createDelegationFirstRuntime, type DelegationFirstRuntime } from "../delegation-first"

const availabilityDirs: string[] = []
function tempAvailabilityFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "delegation-boundary-availability-"))
  availabilityDirs.push(dir)
  return join(dir, "model-availability.json")
}

afterAll(() => {
  for (const dir of availabilityDirs) rmSync(dir, { recursive: true, force: true })
})

function makeRuntime(): DelegationFirstRuntime {
  return createDelegationFirstRuntime(undefined, { modelAvailabilityFilePath: tempAvailabilityFile() })
}

describe("classifyBoundaryRole", () => {
  test("classifies root session when subagentSessions does not include sessionID", () => {
    expect(classifyBoundaryRole({ sessionID: "ses_root", subagentSessionIDs: new Set(["ses_worker"]) })).toBe("root")
  })

  test("classifies worker session when subagentSessions includes sessionID", () => {
    expect(classifyBoundaryRole({ sessionID: "ses_worker", subagentSessionIDs: new Set(["ses_worker"]) })).toBe("worker")
  })

  test("classifies a standalone session with no subagents as root", () => {
    expect(classifyBoundaryRole({ sessionID: "ses_standalone", subagentSessionIDs: new Set() })).toBe("root")
  })
})

describe("classifyOperation boundary classes", () => {
  test("interactive_bash is classified through shell semantics like bash", () => {
    expect(classifyOperation("interactive_bash", { command: "git status" })).toBe("metadata")
    expect(classifyOperation("interactive_bash", { command: "grep -R TODO ." })).toBe("broad")
    expect(classifyOperation("interactive_bash", { command: "bun test" })).toBe("test_build")
  })

  test("an interactive_bash with no command is conservatively broad", () => {
    expect(classifyOperation("interactive_bash", {})).toBe("broad")
  })

  test("MCP-prefixed tools are broad unless they alias a delegation tool", () => {
    expect(classifyOperation("mcp_foo", {})).toBe("broad")
    expect(classifyOperation("mcp_task", {})).toBe("delegation")
    expect(classifyOperation("mcp__task", {})).toBe("delegation")
  })

  test("session_list/session_info/look_at remain non-blocking control tools", () => {
    expect(classifyOperation("session_list", {})).toBe("control")
    expect(classifyOperation("session_info", {})).toBe("control")
    expect(classifyOperation("look_at", {})).toBe("control")
  })
})

describe("evaluateRootToolBoundary through a persistent gate", () => {
  test("worker role is always allowed with no steering", () => {
    const gate = createPreGruntGate()
    const result = evaluateRootToolBoundary(
      { role: "worker", tool: "grep", hint: { target: "src/auth" } },
      { gate, sessionID: "ses_worker" },
    )
    expect(result).toEqual({ allowed: true, delegation: false, blocked: false })
  })

  test("root selective read of a worker-reported anchor is allowed", () => {
    const gate = createPreGruntGate()
    const result = evaluateRootToolBoundary(
      { role: "root", tool: "read", hint: { target: "src/auth.ts", selective: true } },
      { gate, sessionID: "ses_root" },
    )
    expect(result.allowed).toBe(true)
  })

  test("rolling window accumulates across calls: broad reads eventually block", () => {
    // given: one persistent gate + one session (the live shape)
    const gate = createPreGruntGate()
    const options = { gate, sessionID: "ses_root" }
    const read = (target: string) =>
      evaluateRootToolBoundary({ role: "root", tool: "read", hint: { target } }, options)

    // when: broad non-selective reads accumulate, then
    expect(read("src/a.ts").allowed).toBe(true)
    expect(read("src/b.ts").allowed).toBe(true)
    expect(read("src/c.ts").allowed).toBe(true)
    const blocked = read("src/d.ts")

    // then: the persistent window crosses the threshold and blocks (no fresh gate)
    expect(blocked.allowed).toBe(false)
    expect(blocked.blocked).toBe(true)
    if (blocked.allowed === false) {
      expect(blocked.steering).toContain("Delegate this investigation")
    }
  })

  test("a fresh gate never accumulates (regression guard for the historical defect)", () => {
    // given: a NEW gate per call, as the WIP did
    const result = () => {
      const gate = createPreGruntGate()
      return evaluateRootToolBoundary(
        { role: "root", tool: "read", hint: { target: "src/x.ts" } },
        { gate, sessionID: "ses_root" },
      )
    }
    // when/then: never blocks, regardless of how many calls are made
    for (let i = 0; i < 10; i++) {
      expect(result().allowed).toBe(true)
    }
  })
})

describe("delegation boundary acceptance (live persistent gate via runtime.preGruntCheck)", () => {
  test("(i) root reading a file a worker reported is allowed as selective verification", () => {
    const rt = makeRuntime()
    try {
      rt.beginDelegation("job", "root", "map auth", [{ model_id: "a/free", tier: "free", capability: 0.7, free: true }])
      rt.attachChildSession("root", "child")
      rt.markRequestStarted("child")
      rt.noteChildEvidence("root", "the bug is in src/auth/refresh.ts:42-60")
      const anchored = rt.preGruntCheck("root", "read", { target: "src/auth/refresh.ts" })
      expect(anchored.block).toBe(false)
      const selective = rt.preGruntCheck("root", "read", { target: "src/auth/refresh.ts", selective: true })
      expect(selective.block).toBe(false)
      expect(selective.selectiveVerification).toBe(true)
    } finally {
      rt.dispose()
    }
  })

  test("(ii) a git/ls metadata batch is allowed", () => {
    const rt = makeRuntime()
    try {
      expect(rt.preGruntCheck("root", "bash", { command: "git status" }).block).toBe(false)
      expect(rt.preGruntCheck("root", "bash", { command: "git log --oneline -5" }).block).toBe(false)
      expect(rt.preGruntCheck("root", "bash", { command: "git rev-parse HEAD" }).block).toBe(false)
      expect(rt.preGruntCheck("root", "bash", { command: "ls -la" }).block).toBe(false)
      expect(rt.preGruntCheck("root", "bash", { command: "pwd" }).block).toBe(false)
      expect(rt.rootPhase("root")).toBe("bootstrap")
    } finally {
      rt.dispose()
    }
  })

  test("(iii) a broad multi-file crawl stays blocked", () => {
    const rt = makeRuntime()
    try {
      expect(rt.preGruntCheck("root", "bash", { command: "grep -R TODO ." }).block).toBe(true)
      expect(rt.rootPhase("root")).toBe("worker_required")
      expect(rt.preGruntCheck("root", "bash", { command: "find . -name '*.ts'" }).block).toBe(true)
      expect(rt.preGruntCheck("root", "glob", { target: "**/*.ts" }).block).toBe(true)
    } finally {
      rt.dispose()
    }
  })

  test("interactive_bash cannot bypass the gate with a recursive search", () => {
    const rt = makeRuntime()
    try {
      const decision = rt.preGruntCheck("root", "interactive_bash", { command: "grep -R secret ." })
      expect(decision.block).toBe(true)
      expect(rt.preGruntCheck("root", "interactive_bash", { command: "git status" }).block).toBe(false)
    } finally {
      rt.dispose()
    }
  })
})

describe("decideDelegationFailure", () => {
  test("recovery via orchestration when free workers + retries + approved interface", () => {
    const result = decideDelegationFailure({
      freeWorkersAvailable: true,
      retriesRemaining: 3,
      approvedOrchestrationAvailable: true,
    })
    expect(result.action).toBe("recover_via_orchestration")
    expect(result.blocked).toBe(false)
  })

  test("blocked when no free worker lane, no retries, or no approved interface", () => {
    const paths = [
      { freeWorkersAvailable: false, retriesRemaining: 3, approvedOrchestrationAvailable: true },
      { freeWorkersAvailable: true, retriesRemaining: 0, approvedOrchestrationAvailable: true },
      { freeWorkersAvailable: true, retriesRemaining: 3, approvedOrchestrationAvailable: false },
    ]
    for (const input of paths) {
      const result = decideDelegationFailure(input)
      expect(result.action).toBe("blocked")
      expect(result.blocked).toBe(true)
      expect(result.steering).toContain("ROOT_DELEGATION_BLOCKED")
    }
  })

  test("never returns an action permitting direct root execution", () => {
    const result = decideDelegationFailure({
      freeWorkersAvailable: true,
      retriesRemaining: 3,
      approvedOrchestrationAvailable: true,
    })
    expect(result.action).not.toBe("direct_execution")
  })
})
