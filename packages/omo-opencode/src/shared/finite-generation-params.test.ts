import { describe, expect, test } from "bun:test"
import { sanitizeNonFiniteGenerationParams } from "./finite-generation-params"

describe("sanitizeNonFiniteGenerationParams", () => {
  test("strips a top-level NaN temperature and reports its path", () => {
    //#given
    const params = { temperature: Number.NaN, topP: 0.9, maxOutputTokens: 4096, options: {} }

    //#when
    const violations = sanitizeNonFiniteGenerationParams(params)

    //#then
    expect(params.temperature).toBeUndefined()
    expect(params.topP).toBe(0.9)
    expect(violations).toEqual([{ path: "temperature", value: "NaN" }])
  })

  test("strips positive and negative infinity from numeric fields", () => {
    //#given
    const params = { topP: Number.POSITIVE_INFINITY, topK: Number.NEGATIVE_INFINITY, options: {} }

    //#when
    const violations = sanitizeNonFiniteGenerationParams(params)

    //#then
    expect(params.topP).toBeUndefined()
    expect(params.topK).toBeUndefined()
    expect(violations.map((v) => v.path).sort()).toEqual(["topK", "topP"])
  })

  test("strips a non-finite number nested inside options and reports the full path", () => {
    //#given
    const params = {
      options: { reasoning: { budgetTokens: Number.NaN }, seed: 42, thinking: { type: "enabled" } },
    }

    //#when
    const violations = sanitizeNonFiniteGenerationParams(params)

    //#then
    expect((params.options as Record<string, unknown>).reasoning).toEqual({})
    expect((params.options as Record<string, unknown>).seed).toBe(42)
    expect(violations).toEqual([{ path: "options.reasoning.budgetTokens", value: "NaN" }])
  })

  test("preserves valid numbers and non-numeric optional values untouched", () => {
    //#given
    const params = {
      temperature: 0.7,
      options: { top_p: 0.9, label: "high", enabled: true, nothing: null, effort: "max" },
    } as {
      temperature?: number
      options?: Record<string, unknown>
    }

    //#when
    const violations = sanitizeNonFiniteGenerationParams(params)

    //#then
    expect(violations).toEqual([])
    expect(params.temperature).toBe(0.7)
    expect(params.options).toEqual({ top_p: 0.9, label: "high", enabled: true, nothing: null, effort: "max" })
  })

  test("leaves absent optional fields absent", () => {
    //#given
    const params: { options: Record<string, unknown> } = { options: {} }

    //#when
    const violations = sanitizeNonFiniteGenerationParams(params)

    //#then
    expect(violations).toEqual([])
    expect("temperature" in params).toBe(false)
    expect("topP" in params).toBe(false)
  })
})
