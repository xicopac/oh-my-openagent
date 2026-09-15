import { describe, expect, test } from "bun:test"
import { isRetryableModelError, shouldRetryError } from "./model-error-classifier"

describe("model-error-classifier Fireworks generation NaN", () => {
  test("classifies the Fireworks mid-generation NaN 400 as retryable (transient)", () => {
    //#given
    const error = {
      name: "AI_APICallError",
      message:
        "Error from provider (Console): Upstream request failed: [invalid_request_error] Floating point NaN (not-a-number) is detected in generation. It's likely a model issue leading to overflow.",
    }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })

  test("matches by the 'detected in generation' body even without a provider prefix", () => {
    //#given
    const error = {
      message: 'Floating point NaN (not-a-number) is detected in generation. This is a model-side numerical error.',
    }

    //#when
    const result = isRetryableModelError(error)

    //#then
    expect(result).toBe(true)
  })

  test("keeps a genuine parameter-validation error terminal (no blanket NaN retry)", () => {
    //#given
    const error = {
      name: "AI_APICallError",
      message: "`temperature` must be a float between 0 and 2 for this model.",
    }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(false)
  })
})
