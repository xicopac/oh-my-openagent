import { beforeEach, describe, expect, test } from "bun:test"
import {
  estimateTokens,
  boundChildResult,
  boundToolOutput,
  createRereadGuard,
  type BoundedPayload,
} from "./context-payload-budget"

/**
 * Helper: compute expected tokens from chars
 */
function tokens(chars: number): number {
  return Math.ceil(chars / 4)
}

describe("estimateTokens", () => {
  test("empty string returns 0", () => {
    expect(estimateTokens("")).toBe(0)
  })

  test("4 chars => 1 token", () => {
    expect(estimateTokens("abcd")).toBe(1)
  })

  test("5 chars => 2 tokens", () => {
    expect(estimateTokens("abcde")).toBe(2)
  })

  test("8 chars => 2 tokens", () => {
    expect(estimateTokens("abcdefgh")).toBe(2)
  })

  test("9 chars => 3 tokens", () => {
    expect(estimateTokens("abcdefghi")).toBe(3)
  })

  test("unicode does not crash", () => {
    expect(estimateTokens("你好世界")).toBeGreaterThan(0)
  })

  test("multiline does not crash", () => {
    expect(estimateTokens("line1\nline2")).toBeGreaterThan(0)
  })
})

describe("boundChildResult", () => {
  test("text under budget returns unchanged truncated=false", () => {
    // 100 chars => 25 tokens, well under default max 2000
    const result: BoundedPayload = boundChildResult("Hello, world! This is a test of the child result bounding mechanism.")
    expect(result.truncated).toBe(false)
    expect(result.originalTokens).toBeGreaterThan(0)
    expect(result.retainedTokens).toBe(result.originalTokens)
    expect(result.text).toBe("Hello, world! This is a test of the child result bounding mechanism.")
  })

  test("text over budget triggers truncation head+tail marker", () => {
    // Generate text long enough to exceed default max 2000 tokens
    // 2000 tokens => ~8000 chars, so let's use ~10000 chars
    const longText = " ".repeat(10_000)
    const result: BoundedPayload = boundChildResult(longText, { maxTokens: 200 })
    expect(result.truncated).toBe(true)
    expect(result.originalTokens).toBeGreaterThan(200)
    // retainedTokens must be <= maxTokens
    expect(result.retainedTokens).toBeLessThanOrEqual(200)
    // head and tail should be present (non-empty text)
    expect(result.text.length).toBeGreaterThan(0)
    // truncation marker should be present
    expect(result.text).toContain("[truncated")
  })

  test("text over budget with retrievalRef appends full result line", () => {
    const result: BoundedPayload = boundChildResult(
      " ".repeat(10_000),
      { maxTokens: 200, retrievalRef: "seg-abc-123" }
    )
    expect(result.truncated).toBe(true)
    expect(result.retainedTokens).toBeLessThanOrEqual(200)
    // Should append "\n[full result: seg-abc-123]"
    expect(result.text).toContain("[full result: seg-abc-123]")
  })

  test("retainedTokens <= maxTokens always", () => {
    // Test various sizes
    for (const maxTokens of [10, 50, 100, 200, 500]) {
      const longText = "A".repeat(5_000)
      const result: BoundedPayload = boundChildResult(longText, { maxTokens })
      expect(result.retainedTokens).toBeLessThanOrEqual(maxTokens),
        `failed for maxTokens=${maxTokens}: retainedTokens=${result.retainedTokens}`
    }
  })
})

describe("boundToolOutput", () => {
  test("default maxTokens 8000", () => {
    const longText = " ".repeat(50_000)
    const result: BoundedPayload = boundToolOutput(longText)
    expect(result.truncated).toBe(true)
    expect(result.retainedTokens).toBeLessThanOrEqual(8000)
  })

  test("custom maxTokens cap", () => {
    const longText = " ".repeat(50_000)
    const result: BoundedPayload = boundToolOutput(longText, { maxTokens: 100 })
    expect(result.truncated).toBe(true)
    expect(result.retainedTokens).toBeLessThanOrEqual(100)
  })

  test("tool output under budget returns unchanged", () => {
    const shortText = "Hello, this is short tool output."
    const result: BoundedPayload = boundToolOutput(shortText)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(shortText)
  })
})

describe("createRereadGuard", () => {
  let guard: ReturnType<typeof createRereadGuard>

  beforeEach(() => {
    guard = createRereadGuard()
  })

  test("first inject true for new key+hash", () => {
    expect(guard.shouldInject("key1", "hash1")).toBe(true)
  })

  test("same key+hash returns false", () => {
    guard.shouldInject("key1", "hash1") // first call, should be true, but doesn't record automatically
    // Actually, shouldInject returns true and the caller must call record
    // Let me re-read the spec: "shouldInject returns false ONLY when the same key+hash was already recorded; true otherwise. record is idempotent."
    // So shouldInject does NOT automatically record. The caller must call record().
    // Wait, let me re-think. The spec says "shouldInject returns false ONLY when the same key+hash was already recorded; true otherwise."
    // This means: if the key+hash was previously recorded (via record()), return false.
    // If not recorded, return true. But does calling shouldInject also record?
    // The spec says "record is idempotent" suggesting it's a separate action.
    // Let me re-read: "shouldInject returns false ONLY when the same key+hash was already recorded; true otherwise."
    // I think shouldInject checks if it was recorded, returns false if yes, true if no.
    // It does NOT automatically record. The caller must call record() after shouldInject(true).
    
    // For the test, let me record it manually
    guard.record("key1", "hash1")
    expect(guard.shouldInject("key1", "hash1")).toBe(false)
  })

  test("changed hash for same key returns true", () => {
    guard.shouldInject("key1", "hash1")
    guard.record("key1", "hash1")
    // Different hash should return true
    expect(guard.shouldInject("key1", "hash2")).toBe(true)
  })

  test("different key returns true even with same hash", () => {
    guard.shouldInject("key1", "hash1")
    guard.record("key1", "hash1")
    // Different key with same hash should return true
    expect(guard.shouldInject("key2", "hash1")).toBe(true)
  })

  test("size counts unique key+hash pairs", () => {
    guard.shouldInject("key1", "hash1")
    guard.record("key1", "hash1")
    guard.shouldInject("key2", "hash2")
    guard.record("key2", "hash2")
    expect(guard.size()).toBe(2)
  })

  test("size after recording same key twice is still 1", () => {
    guard.record("key1", "hash1")
    guard.record("key1", "hash1") // idempotent
    expect(guard.size()).toBe(1)
  })
})