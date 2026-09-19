export type PaidWorkerGate = {
  tryAcquire(): boolean
  release(): void
  activeCount(): number
  setMaxConcurrent(max: number): void
  /** Reset all active slots (test/teardown seam; keeps the max). */
  reset(): void
}

export function createPaidWorkerGate(maxConcurrent = 1): PaidWorkerGate {
  let max = maxConcurrent >= 1 ? maxConcurrent : 1
  let active = 0
  return {
    tryAcquire() {
      if (active >= max) return false
      active += 1
      return true
    },
    release() {
      if (active >= 1) active -= 1
    },
    activeCount() {
      return active
    },
    setMaxConcurrent(next) {
      max = next >= 1 ? next : 1
    },
    reset() {
      active = 0
    },
  }
}

export const paidWorkerGate = createPaidWorkerGate(1)
