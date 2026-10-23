import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDelegationFirstRuntime } from "./runtime"

const root = mkdtempSync(join(tmpdir(), "paid-child-concurrency-"))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function runtimeWithCap(maxConcurrentPaidWorkers: number) {
  return createDelegationFirstRuntime(undefined, {
    maxConcurrentPaidWorkers,
    modelAvailabilityFilePath: join(root, "model-availability.json"),
  })
}

describe("delegation-first paid-child concurrency follows the live cap", () => {
  test("setPaidChildConcurrency raises a cap-1 runtime without a restart", async () => {
    // given - a runtime built from STARTUP config with a cap of 1
    const rt = runtimeWithCap(1)
    try {
      expect(rt.paidChildConcurrencyMax()).toBe(1)
      expect(rt.tryAcquirePaidChild()).toBe(true)
      expect(rt.tryAcquirePaidChild()).toBe(false)

      // when - the live config raises the cap to 2
      rt.setPaidChildConcurrency(2)

      // then - the enforced cap follows and the extra slot is acquirable
      expect(rt.paidChildConcurrencyMax()).toBe(2)
      expect(rt.tryAcquirePaidChild()).toBe(true)
      expect(rt.tryAcquirePaidChild()).toBe(false)
    } finally {
      await rt.dispose()
    }
  })

  test("setPaidChildConcurrency clamps a non-positive limit to 1", async () => {
    const rt = runtimeWithCap(1)
    try {
      rt.setPaidChildConcurrency(0)
      expect(rt.paidChildConcurrencyMax()).toBe(1)
      rt.setPaidChildConcurrency(-5)
      expect(rt.paidChildConcurrencyMax()).toBe(1)
    } finally {
      await rt.dispose()
    }
  })
})
