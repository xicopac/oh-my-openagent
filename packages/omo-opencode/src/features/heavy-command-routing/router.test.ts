import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  AI_EMULATOR_SLICE,
  AI_WORK_SLICE,
  buildAiJobCommand,
  decideHeavyCommandRouting,
  resolveTimeoutSec,
  shellSingleQuote,
} from "./router"

describe("decideHeavyCommandRouting", () => {
  test("a heavy command outside ai-control.slice runs directly", () => {
    // given
    const command = "bunx tsgo --noEmit"

    // when
    const decision = decideHeavyCommandRouting(command, {
      inControlSlice: false,
      aiJobAvailable: true,
    })

    // then
    expect(decision).toEqual({ action: "direct", reason: "not-in-control-slice" })
  })

  test("a light command in ai-control.slice runs directly", () => {
    // given
    const command = "git status"

    // when
    const decision = decideHeavyCommandRouting(command, {
      inControlSlice: true,
      aiJobAvailable: true,
    })

    // then
    expect(decision).toEqual({ action: "direct", reason: "light" })
  })

  test("an available ai-job rewrites a build into ai-work.slice", () => {
    // given
    const command = "bunx tsgo --noEmit"

    // when
    const decision = decideHeavyCommandRouting(command, {
      inControlSlice: true,
      aiJobAvailable: true,
    })

    // then
    expect(decision.action).toBe("rewrite")
    if (decision.action !== "rewrite") return
    expect(decision.command).toContain(
      "/usr/local/bin/ai-job run build --timeout 1800 -- /bin/bash -lc 'bunx tsgo --noEmit'",
    )
    expect(decision.command).toContain(
      "printf '[ai-routing] class=%s type=%s slice=%s\\n' BUILD build ai-work.slice",
    )
    expect(decision.kind).toBe("build")
    expect(decision.type).toBe("build")
    expect(decision.slice).toBe(AI_WORK_SLICE)
  })

  test("GNU timeout becomes the systemd unit timeout and is removed from the inner command", () => {
    // given
    const command = "timeout 120 bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json"

    // when
    const decision = decideHeavyCommandRouting(command, {
      inControlSlice: true,
      aiJobAvailable: true,
    })

    // then
    expect(decision.action).toBe("rewrite")
    if (decision.action !== "rewrite") return
    expect(decision.command).toContain("--timeout 120")
    expect(decision.command).toContain(
      "/bin/bash -lc 'bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json'",
    )
    expect(decision.command).not.toContain("timeout 120 bunx")
    expect(decision.timeoutSec).toBe(120)
  })

  test("env / bash -c / cd prefixes are kept inside the routed unit", () => {
    // given
    const command = "cd /tmp/repo && env FOO=1 bash -c 'bun run typecheck'"

    // when
    const decision = decideHeavyCommandRouting(command, {
      inControlSlice: true,
      aiJobAvailable: true,
    })

    // then
    expect(decision.action).toBe("rewrite")
    if (decision.action !== "rewrite") return
    expect(decision.command).toContain("cd /tmp/repo && env FOO=1 bash -c")
    expect(decision.command).toContain("/bin/bash -lc ")
  })

  test("an emulator command uses the emulator slice with no runtime limit", () => {
    // given
    const command = "emulator -avd Pixel_2"

    // when
    const decision = decideHeavyCommandRouting(command, {
      inControlSlice: true,
      aiJobAvailable: true,
    })

    // then
    expect(decision.action).toBe("rewrite")
    if (decision.action !== "rewrite") return
    expect(decision.command).toContain("run emulator --timeout 0")
    expect(decision.kind).toBe("emulator")
    expect(decision.slice).toBe(AI_EMULATOR_SLICE)
  })

  test("a heavy command fails closed when ai-job is unavailable", () => {
    // given
    const command = "yarn install"

    // when
    const decision = decideHeavyCommandRouting(command, {
      inControlSlice: true,
      aiJobAvailable: false,
    })

    // then
    expect(decision).toEqual({
      action: "refuse",
      reason: "[routing] HEAVY command refused: ai-job unavailable; cannot route away from ai-control.slice",
    })
  })

  test("bash tool timeout is rounded up to seconds", () => {
    // given
    const command = "bunx tsgo --noEmit"

    // when
    const decision = decideHeavyCommandRouting(command, {
      inControlSlice: true,
      aiJobAvailable: true,
      bashToolTimeoutMs: 123_456,
    })

    // then
    expect(decision.action).toBe("rewrite")
    if (decision.action !== "rewrite") return
    expect(decision.timeoutSec).toBe(124)
    expect(decision.command).toContain("--timeout 124")
  })

  test("timeout rewrite never embeds the controller cgroup", () => {
    // given
    const command = "timeout 120 bunx tsgo --noEmit"

    // when
    const decision = decideHeavyCommandRouting(command, {
      inControlSlice: true,
      aiJobAvailable: true,
    })

    // then
    expect(decision.action).toBe("rewrite")
    if (decision.action !== "rewrite") return
    expect(decision.command).not.toContain("/ai.slice/ai-control.slice/")
  })

  test("normalized GNU timeout takes precedence over the bash tool timeout", () => {
    // given
    const normalizedTimeoutSec = 60
    const bashToolTimeoutMs = 999_999

    // when
    const timeoutSec = resolveTimeoutSec(normalizedTimeoutSec, bashToolTimeoutMs)

    // then
    expect(timeoutSec).toBe(60)
  })

  test("buildAiJobCommand includes the diagnostic and requested binary", () => {
    // given
    const command = "bun run build"
    const aiJobBin = "/opt/bin/ai-job"

    // when
    const result = buildAiJobCommand("build", command, 1800, { aiJobBin })

    // then
    expect(result).toContain(
      "printf '[ai-routing] class=%s type=%s slice=%s\\n' BUILD build ai-work.slice",
    )
    expect(result).toContain("/opt/bin/ai-job run build --timeout 1800 -- /bin/bash -lc")
  })
})

describe("shellSingleQuote", () => {
  test.each([
    "echo 'hello'",
    'echo "world"',
    "echo $(date)",
    "echo first && echo second",
    "echo `date`",
    "bunx tsgo -p 'packages/omo-opencode/tsconfig.json' | cat",
  ])("round-trips %s through bash", (command) => {
    // given
    const quoted = shellSingleQuote(command)

    // when
    const result = spawnSync("/bin/bash", ["-lc", `printf %s ${quoted}`], { encoding: "utf8" })

    // then
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(command)
  })
})
