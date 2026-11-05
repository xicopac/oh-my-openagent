import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  assertBunExecutableVersion,
  assertBunVersion,
  expectedBunVersion,
  parseBunPackageManager,
} from "./bun-toolchain.mjs"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))

describe("release Bun toolchain", () => {
  test("#given package metadata #when the expected toolchain is resolved #then it pins Bun exactly", () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      packageManager?: unknown
    }

    expect(manifest.packageManager).toBe("bun@1.4.3")
    expect(parseBunPackageManager(manifest.packageManager)).toBe("1.4.3")
    expect(expectedBunVersion()).toBe("1.4.3")
  })

  test("#given an invalid packageManager #when parsed #then the release toolchain fails closed", () => {
    for (const value of [undefined, "bun", "bun@latest", "npm@11.0.0", "bun@1.4.3 || true"]) {
      expect(() => parseBunPackageManager(value)).toThrow("exact Bun packageManager")
    }
  })

  test("#given a mismatched Bun runtime #when a tracked generator starts #then it fails before building", () => {
    expect(() => assertBunVersion("1.3.14", "1.4.3", "Codex installer generator"))
      .toThrow("Codex installer generator requires Bun 1.4.3; current Bun is 1.3.14")
    expect(assertBunVersion("1.4.3", "1.4.3", "Codex installer generator")).toBe("1.4.3")
  })

  test("#given a spawned Bun executable #when its version is checked #then the same exact pin is enforced", () => {
    const matchingSpawn = () => ({ status: 0, stdout: "1.4.3\n", stderr: "" })
    const staleSpawn = () => ({ status: 0, stdout: "1.3.14\n", stderr: "" })

    expect(assertBunExecutableVersion("bun", "1.4.3", "Senpi generator", matchingSpawn)).toBe("1.4.3")
    expect(() => assertBunExecutableVersion("bun", "1.4.3", "Senpi generator", staleSpawn))
      .toThrow("Senpi generator requires Bun 1.4.3; current Bun is 1.3.14")
  })

  test("#given every tracked generator #when wiring is inspected #then each enforces the shared pin", () => {
    const expectedCalls = new Map([
      ["script/build.ts", "assertCurrentBunVersion"],
      ["script/build-codex-install.ts", "assertCurrentBunVersion"],
      ["script/build-service-auth.ts", "assertCurrentBunVersion"],
      ["packages/omo-senpi/plugin/scripts/build-extension-core.mjs", "assertBunExecutableVersion"],
    ])

    for (const [relativePath, call] of expectedCalls) {
      expect(readFileSync(join(repositoryRoot, relativePath), "utf8"), relativePath).toContain(call)
    }
  })
})
