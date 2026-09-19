import { describe, expect, test } from "bun:test"
import { createPaidWorkerGate } from "./paid-worker-gate"

describe("paid worker concurrency gate", () => {
  test("maximum 1 concurrent paid child by default", () => {
    const gate = createPaidWorkerGate()
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(false)
    expect(gate.activeCount()).toBe(1)
  })

  test("release frees the slot for the next paid child", () => {
    const gate = createPaidWorkerGate()
    expect(gate.tryAcquire()).toBe(true)
    gate.release()
    expect(gate.tryAcquire()).toBe(true)
  })

  test("release never goes below zero", () => {
    const gate = createPaidWorkerGate()
    gate.release()
    gate.release()
    expect(gate.activeCount()).toBe(0)
  })

  test("maxConcurrent configurable upward", () => {
    const gate = createPaidWorkerGate(3)
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(false)
  })

  test("setMaxConcurrent shrinks the cap", () => {
    const gate = createPaidWorkerGate(3)
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(true)
    gate.setMaxConcurrent(1)
    expect(gate.tryAcquire()).toBe(false)
  })
})
