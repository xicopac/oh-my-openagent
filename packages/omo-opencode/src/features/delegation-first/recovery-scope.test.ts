import { describe, expect, test } from "bun:test"

import { evaluateRecoveryScope } from "./recovery-scope"

describe("delegation recovery scope", () => {
  test("allows control-plane inspection, repair, validation, and cleanup", () => {
    const cases = [
      ["read", { target: "packages/omo-opencode/src/features/delegation-first/runtime.ts" }],
      ["grep", { target: "packages/omo-opencode/src/features/background-agent" }],
      ["edit", { target: "packages/omo-opencode/src/features/worker-supervisor/watchdog.ts" }],
      ["write", { target: ".omo/omo.jsonc" }],
      ["bash", { command: "journalctl --user -u opencode.service -n 100" }],
      ["bash", { command: "systemctl --user restart opencode.service" }],
      ["bash", { command: "bun test packages/omo-opencode/src/features/delegation-first" }],
      ["background_output", {}],
      ["background_cancel", {}],
      ["session_info", {}],
      ["monitor_output", {}],
    ] as const

    for (const [tool, hint] of cases) {
      expect(evaluateRecoveryScope(tool, hint), `${tool} ${JSON.stringify(hint)}`).toMatchObject({ allowed: true })
    }
  })

  test("denies unrelated product work even while recovery is active", () => {
    const cases = [
      ["read", { target: "apps/storefront/src/cart.ts" }],
      ["edit", { target: "packages/web/src/app/page.tsx" }],
      ["write", { target: "src/features/new-dashboard.ts" }],
      ["bash", { command: "rg checkout packages/web" }],
      ["bash", { command: "npm install react" }],
      ["skill_mcp", {}],
      ["team_create", {}],
      ["task", { recoveryProbe: false }],
    ] as const

    for (const [tool, hint] of cases) {
      expect(evaluateRecoveryScope(tool, hint), `${tool} ${JSON.stringify(hint)}`).toMatchObject({ allowed: false })
    }
  })

  test("permits delegation only for the machine-consumed recovery probe", () => {
    expect(evaluateRecoveryScope("task", { recoveryProbe: true })).toMatchObject({
      allowed: true,
      category: "verification",
    })
    expect(evaluateRecoveryScope("call_omo_agent", { recoveryProbe: true })).toMatchObject({ allowed: false })
  })

  test("does not permit broad process mutation without an orchestration identity", () => {
    expect(evaluateRecoveryScope("bash", { command: "kill -9 1234" }).allowed).toBe(false)
    expect(evaluateRecoveryScope("bash", { command: "pkill -9 node" }).allowed).toBe(false)
    expect(evaluateRecoveryScope("bash", { command: "pkill -TERM -f oh-my-opencode" }).allowed).toBe(true)
  })

  test("allows bare recovery-scope directories without a trailing slash", () => {
    // given recovery-scope directories referenced as bare hints or absolute paths
    const cases = [
      ["read", { target: "packages/omo-opencode/src/plugin" }],
      ["read", { target: "/srv/dev/oh-my-openagent/packages/omo-opencode/src/plugin" }],
      ["grep", { target: "packages/omo-opencode/src/hooks" }],
      ["grep", { target: "/srv/dev/oh-my-openagent/packages/omo-opencode/src/hooks" }],
      ["read", { target: "packages/omo-opencode/src/tools" }],
      ["edit", { target: "packages/omo-opencode/src/plugin/tool-execute-before.ts" }],
    ] as const

    // when evaluated, then every directory path is allowed
    for (const [tool, hint] of cases) {
      expect(evaluateRecoveryScope(tool, hint), `${tool} ${JSON.stringify(hint)}`).toMatchObject({ allowed: true })
    }
  })

  test("denies paths outside the recovery scope", () => {
    // given a hint outside omo-opencode recovery markers
    // when evaluated, then it is denied
    expect(evaluateRecoveryScope("read", { target: "packages/web/src/app/page.tsx" })).toMatchObject({
      allowed: false,
    })
  })

  test("denies ordinary delegation but allows the recovery probe", () => {
    // given a task hint without the probe flag, when evaluated, then denied
    expect(evaluateRecoveryScope("task", {})).toMatchObject({ allowed: false })
    expect(evaluateRecoveryScope("task", { recoveryProbe: false })).toMatchObject({ allowed: false })
    // given the machine-consumed probe flag, when evaluated, then allowed
    expect(evaluateRecoveryScope("task", { recoveryProbe: true })).toMatchObject({ allowed: true })
  })

  test("allows git status but denies bash outside the scope", () => {
    // given a safe inspection command, when evaluated, then allowed
    expect(evaluateRecoveryScope("bash", { command: "git status" })).toMatchObject({ allowed: true })
    // given a command outside scope, when evaluated, then denied
    expect(evaluateRecoveryScope("bash", { command: "rg checkout packages/web" })).toMatchObject({
      allowed: false,
    })
  })
})
