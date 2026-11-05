import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  TRACKED_GENERATED_ARTIFACTS,
  collectReleaseCandidateManifest,
  parseReleaseCandidateArgs,
  versionedArtifactName,
} from "./release-candidate"

describe("release candidate manifest", () => {
  test("#given CLI inputs #when parsed #then rollback is explicit and evidence order is retained", () => {
    expect(parseReleaseCandidateArgs([
      "--rollback-target=abc123",
      "--output-dir=.omo/evidence/rc",
      "--evidence=.omo/evidence/a.txt",
    ])).toEqual({
      rollbackTarget: "abc123",
      outputDir: ".omo/evidence/rc",
      evidencePaths: [".omo/evidence/a.txt"],
    })
    expect(() => parseReleaseCandidateArgs([])).toThrow("--rollback-target=<commit> is required")
    expect(() => parseReleaseCandidateArgs(["--rollback-target=x", "--unknown=y"])).toThrow("unknown")
  })

  test("#given release identity #when named #then the artifact is versioned by package and commit", () => {
    const commit = "a".repeat(40)
    expect(versionedArtifactName("5.1.38", commit)).toBe("oh-my-openagent-5.1.38-aaaaaaaaaaaa.js")
    expect(() => versionedArtifactName("latest", commit)).toThrow("invalid package version")
    expect(() => versionedArtifactName("5.1.38", "abc")).toThrow("invalid commit id")
  })

  test("#given identical files #when manifests are collected twice #then output identity is deterministic", async () => {
    const repository = await mkdtemp(join(tmpdir(), "omo-release-candidate-"))
    try {
      await writeFile(join(repository, "bun.lock"), "lock\n")
      await mkdir(join(repository, "dist"), { recursive: true })
      await writeFile(join(repository, "dist", "index.js"), "export default 1\n")
      await mkdir(join(repository, ".omo", "evidence"), { recursive: true })
      await writeFile(join(repository, ".omo", "evidence", "runtime.txt"), "PASS\n")
      for (const path of TRACKED_GENERATED_ARTIFACTS) {
        await mkdir(join(repository, path, ".."), { recursive: true })
        await writeFile(join(repository, path), `${path}\n`)
      }

      const input = {
        repository,
        packageName: "oh-my-opencode",
        packageVersion: "5.1.38",
        commit: "a".repeat(40),
        rollbackTarget: "b".repeat(40),
        artifactPath: "dist/index.js",
        evidencePaths: [".omo/evidence/runtime.txt"],
        bunVersion: "1.4.3",
        nodeVersion: "24.11.0",
      }
      const first = await collectReleaseCandidateManifest(input)
      const second = await collectReleaseCandidateManifest(input)

      expect(second).toEqual(first)
      expect(first.commit).toBe("a".repeat(40))
      expect(first.rollbackTarget).toBe("b".repeat(40))
      expect(first.toolchain).toEqual({ bun: "1.4.3", node: "24.11.0" })
      expect(first.artifact.path).toBe("dist/index.js")
      expect(first.evidence[0]?.path).toBe(".omo/evidence/runtime.txt")
      expect(first.trackedGeneratedArtifacts).toHaveLength(TRACKED_GENERATED_ARTIFACTS.length)
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })
})
