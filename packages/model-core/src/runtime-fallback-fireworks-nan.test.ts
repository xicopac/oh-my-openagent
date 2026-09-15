import { describe, expect, test } from "bun:test"
import { RUNTIME_FALLBACK_RETRYABLE_ERROR_PATTERNS } from "./runtime-fallback-retryable-patterns"

const MATCHES = (message: string): boolean =>
  RUNTIME_FALLBACK_RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message))

describe("runtime-fallback Fireworks generation NaN pattern", () => {
  test("matches the Fireworks mid-generation NaN 400 body", () => {
    //#given
    const message =
      "floating point nan (not-a-number) is detected in generation. it's likely a model issue leading to overflow."

    //#when
    const result = MATCHES(message)

    //#then
    expect(result).toBe(true)
  })

  test("does not match a genuine parameter-validation error", () => {
    //#given
    const message = "400 bad request: `temperature` is not a valid float for this model."

    //#when
    const result = MATCHES(message)

    //#then
    expect(result).toBe(false)
  })
})
