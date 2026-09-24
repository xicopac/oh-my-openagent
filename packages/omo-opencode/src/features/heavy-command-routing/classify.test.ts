import { describe, expect, test } from "bun:test"
import { classifyResourceCommand, normalizeShellCommand } from "./classify"

describe("classifyResourceCommand", () => {
  test.each(["git status", "git diff", "git log"])("%s stays light", (command) => {
    // given
    const input = command

    // when
    const result = classifyResourceCommand(input)

    // then
    expect(result).toBe("light")
  })

  test.each(["grep foo src", "rg foo"])("%s classifies as heavy", (command) => {
    // given
    const input = command

    // when
    const result = classifyResourceCommand(input)

    // then
    expect(result).toBe("heavy")
  })

  test("bunx tsgo is a build", () => {
    // given
    const command = "bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json"

    // when
    const result = classifyResourceCommand(command)

    // then
    expect(result).toBe("build")
  })

  test("leading GNU timeout is removed and converted", () => {
    // given
    const command = "timeout -v 120 bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json"

    // when
    const normalized = normalizeShellCommand(command)
    const result = classifyResourceCommand(command)

    // then
    expect(normalized).toEqual({
      command: "bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json",
      timeoutSec: 120,
    })
    expect(result).toBe("build")
  })

  test("quoted bash -c inner command is classified", () => {
    // given
    const command = "bash -c 'bunx tsgo --noEmit'"

    // when
    const result = classifyResourceCommand(command)

    // then
    expect(result).toBe("build")
  })

  test.each([
    "cd repo && bun run typecheck",
    "cd /srv/dev/oh-my-openagent && bun run typecheck",
  ])("cd prefix is transparent: %s", (command) => {
    // given
    const input = command

    // when
    const result = classifyResourceCommand(input)

    // then
    expect(result).toBe("build")
  })

  test.each(["gradle build", "./gradlew test"])("%s routes to gradle", (command) => {
    // given
    const input = command

    // when
    const result = classifyResourceCommand(input)

    // then
    expect(result).toBe("gradle")
  })

  test("emulator and adb install route to emulator while adb devices stays heavy", () => {
    // given
    const emulatorCommand = "emulator -avd Pixel_2"
    const adbInstallCommand = "adb install app.apk"
    const adbDevicesCommand = "adb devices"

    // when
    const results = [emulatorCommand, adbInstallCommand, adbDevicesCommand].map(classifyResourceCommand)

    // then
    expect(results).toEqual(["emulator", "emulator", "heavy"])
  })

  test.each([
    ["npx tsgo --noEmit", "build"],
    ["npm tsgo", "heavy"],
    ["pnpm tsgo", "heavy"],
    ["npm run build", "build"],
    ["npm run test", "test"],
    ["yarn install", "heavy"],
  ])("%s classifies as %s", (command, expected) => {
    // given
    const input = command

    // when
    const result = classifyResourceCommand(input)

    // then
    expect(result).toBe(expected)
  })

  test("make jobs build and make --help classifies as heavy", () => {
    // given
    const buildCommand = "make -j8"
    const helpCommand = "make --help"

    // when
    const results = [buildCommand, helpCommand].map(classifyResourceCommand)

    // then
    expect(results).toEqual(["build", "heavy"])
  })

  test("env assignments are transparent", () => {
    // given
    const command = "env FOO=1 bun run typecheck"

    // when
    const result = classifyResourceCommand(command)

    // then
    expect(result).toBe("build")
  })

  test.each([
    "nice -n 10 bun run typecheck",
    "sudo -u xicopac bun run build",
    "nohup bun test",
    "time -p npm run build",
  ])("shell wrapper is transparent: %s", (command) => {
    // given
    const input = command

    // when
    const result = classifyResourceCommand(input)

    // then
    expect(["build", "test"]).toContain(result)
  })

  test("light fast path wins after timeout normalization", () => {
    // given
    const command = "timeout 90 git status"

    // when
    const result = classifyResourceCommand(command)

    // then
    expect(result).toBe("light")
  })

  test("a heavy segment wins in a multi-segment command", () => {
    // given
    const command = "git status && bun test"

    // when
    const result = classifyResourceCommand(command)

    // then
    expect(result).toBe("test")
  })

  test("resource priority prefers gradle over an earlier build", () => {
    // given
    const command = "bun run build && gradle test"

    // when
    const result = classifyResourceCommand(command)

    // then
    expect(result).toBe("gradle")
  })

  test("shell -c with a duration suffix and cd semicolon are normalized", () => {
    // given
    const timeoutCommand = "timeout 2m bunx tsgo --noEmit"
    const shCommand = "sh -c \"bunx tsgo --noEmit\""
    const cdCommand = "cd relative/path; bun run build"

    // when
    const timeoutNormalized = normalizeShellCommand(timeoutCommand)
    const results = [shCommand, cdCommand].map(classifyResourceCommand)

    // then
    expect(timeoutNormalized).toEqual({ command: "bunx tsgo --noEmit", timeoutSec: 120 })
    expect(results).toEqual(["build", "build"])
  })

  test("shell -c is not unwrapped when its quoted argument is not the entire rest", () => {
    // given
    const command = "bash -c 'bunx tsgo --noEmit' && echo done"

    // when
    const normalized = normalizeShellCommand(command)

    // then
    expect(normalized.command).toBe(command)
  })

  test("generic tools with no known classification classify as heavy", () => {
    // given
    const commands = ["node script.js", "bash script.sh", "./smoke-test.sh", "grep -r foo .", "find / -name '*.ts'"]

    // when
    const results = commands.map(classifyResourceCommand)

    // then
    expect(results).toEqual(["heavy", "heavy", "heavy", "heavy", "heavy"])
  })

  test("timeout wrapping a generic tool keeps it heavy", () => {
    // given
    const command = "timeout 60 node script.js"

    // when
    const result = classifyResourceCommand(command)

    // then
    expect(result).toBe("heavy")
  })

  test("control-plane tools stay light", () => {
    // given
    const commands = ["sleep 30", "ps aux", "date"]

    // when
    const results = commands.map(classifyResourceCommand)

    // then
    expect(results).toEqual(["light", "light", "light"])
  })

  test("control-plane segments joined with && stay light", () => {
    // given
    const command = "sleep 3 && ps aux"

    // when
    const result = classifyResourceCommand(command)

    // then
    expect(result).toBe("light")
  })

  test("mixed control-plane and non-control-plane segments classify as heavy", () => {
    // given
    const command = "sleep 3 && node script.js"

    // when
    const result = classifyResourceCommand(command)

    // then
    expect(result).toBe("heavy")
  })
})
