import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ALLOW_PAID_WORKERS,
  DEFAULT_MAX_CONCURRENT_PAID_WORKERS,
  resolveCostSafetyPolicy,
} from "./cost-safety-policy"

describe("cost-safety policy defaults", () => {
  test("paid permission defaults to false when absent", () => {
    const policy = resolveCostSafetyPolicy(undefined)
    expect(policy.allowPaidWorkers).toBe(false)
    expect(DEFAULT_ALLOW_PAID_WORKERS).toBe(false)
  })

  test("paid concurrency defaults to 1", () => {
    const policy = resolveCostSafetyPolicy(undefined)
    expect(policy.maxConcurrentPaidWorkers).toBe(1)
    expect(DEFAULT_MAX_CONCURRENT_PAID_WORKERS).toBe(1)
  })

  test("explicit opt-in flips allow_paid_workers", () => {
    expect(resolveCostSafetyPolicy({ allowPaidWorkers: true }).allowPaidWorkers).toBe(true)
  })

  test("invalid concurrency falls back to 1", () => {
    expect(resolveCostSafetyPolicy({ maxConcurrentPaidWorkers: 0 }).maxConcurrentPaidWorkers).toBe(1)
    expect(resolveCostSafetyPolicy({ maxConcurrentPaidWorkers: -3 }).maxConcurrentPaidWorkers).toBe(1)
  })
})
