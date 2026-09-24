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
})
