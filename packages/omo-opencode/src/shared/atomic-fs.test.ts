import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  readJsonTolerant,
  sweepStaleTemps,
  writeAtomicJson,
  writeAtomicText,
} from "./atomic-fs"

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omo-atomic-fs-"))
}

describe("writeAtomicText + readJsonTolerant roundtrip", () => {
  test("#given a valid JSON payload #when written+read #then the roundtrip preserves the object", () => {
    // given
    const dir = makeTmpDir()
    const file = join(dir, "roundtrip.json")
    try {
      // when
      writeAtomicJson(file, { a: 1, b: "hi" })
      const parsed = readJsonTolerant(file)

      // then
      expect(parsed).toEqual({ a: 1, b: "hi" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("readJsonTolerant tolerance", () => {
  test("#given a missing file #when read #then returns null", () => {
    // given
    const dir = makeTmpDir()
    try {
      // when
      const result = readJsonTolerant(join(dir, "does-not-exist.json"))

      // then
      expect(result).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("#given a corrupt/truncated JSON file #when read #then returns null (no throw)", () => {
    // given: simulate a mid-write crash - a truncated JSON body left on disk
    const dir = makeTmpDir()
    const file = join(dir, "corrupt.json")
    writeFileSync(file, '{"a": 1, "b": "hi', "utf-8")
    try {
      // when
      const result = readJsonTolerant(file)

      // then
      expect(result).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("#given valid JSON that is not an object (a bare number) #when read #then returns null", () => {
    // given
    const dir = makeTmpDir()
    const file = join(dir, "primitive.json")
    writeFileSync(file, "42", "utf-8")
    try {
      // when
      const result = readJsonTolerant(file)

      // then: primitive is rejected - store expects an object shape
      expect(result).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("writeAtomicText cleanup", () => {
  test("#given a successful atomic write #when directory is listed #then no .tmp-* files remain", () => {
    // given
    const dir = makeTmpDir()
    const file = join(dir, "clean.json")
    try {
      // when
      writeAtomicJson(file, { hello: "world" })

      // then
      const entries = readdirSync(dir)
      const stray = entries.filter((name) => name.includes(".tmp-"))
      expect(stray).toEqual([])
      expect(entries).toContain("clean.json")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("#given a missing parent directory #when writeAtomicText runs #then parents are created", () => {
    // given
    const dir = makeTmpDir()
    const nested = join(dir, "a", "b", "c")
    const file = join(nested, "deep.json")
    try {
      // when
      writeAtomicJson(file, { nested: true })

      // then
      expect(existsSync(file)).toBe(true)
      expect(readJsonTolerant(file)).toEqual({ nested: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("sweepStaleTemps", () => {
  test("#given tmp files with matching+non-matching prefixes #when swept #then only matching are removed and count returned", () => {
    // given
    const dir = makeTmpDir()
    const targetPrefix = "capsule.json"
    writeFileSync(join(dir, `${targetPrefix}.tmp-abc`), "leftover", "utf-8")
    writeFileSync(join(dir, `${targetPrefix}.tmp-def`), "leftover", "utf-8")
    writeFileSync(join(dir, "other.json.tmp-xyz"), "keep", "utf-8")
    writeFileSync(join(dir, "capsule.json"), "keep", "utf-8")
    try {
      // when
      const removed = sweepStaleTemps(dir, targetPrefix)

      // then
      expect(removed).toBe(2)
      const remaining = readdirSync(dir).sort()
      expect(remaining).toEqual(["capsule.json", "other.json.tmp-xyz"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("#given a missing directory #when swept #then returns 0 (no throw)", () => {
    // when
    const removed = sweepStaleTemps("/nonexistent/omo/fs/path", "any")

    // then
    expect(removed).toBe(0)
  })
})

describe("writeAtomicJson concurrent sequential writers", () => {
  test("#given many sequential writers #when finished #then file is always valid JSON and reflects the last write", () => {
    // given
    const dir = makeTmpDir()
    const file = join(dir, "seq.json")
    try {
      // when
      for (let i = 0; i < 25; i += 1) {
        writeAtomicJson(file, { i })
      }

      // then
      const raw = readFileSync(file, "utf-8")
      const parsed = JSON.parse(raw) as { i: number }
      expect(parsed.i).toBe(24)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("writeAtomicText produces the exact bytes given", () => {
  test("#given a text payload #when written+read #then bytes match", () => {
    // given
    const dir = makeTmpDir()
    const file = join(dir, "text.txt")
    try {
      // when
      writeAtomicText(file, "hello\nworld\n")
      const raw = readFileSync(file, "utf-8")

      // then
      expect(raw).toBe("hello\nworld\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
