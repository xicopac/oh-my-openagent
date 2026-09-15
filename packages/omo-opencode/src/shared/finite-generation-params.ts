/**
 * Preflight guard for the final chat-params request boundary. Numeric
 * generation fields must be finite before transport: a NaN/Infinity that slips
 * through is serialized as an invalid float and the provider rejects the whole
 * request with an opaque error. This strips non-finite numbers (so the field
 * falls back to its provider default) and reports the exact field path for a
 * local diagnostic, instead of sending a corrupted request.
 *
 * Only numbers are inspected — strings, booleans, null, and absent optional
 * fields pass through untouched.
 */

const TOP_LEVEL_NUMERIC_KEYS = ["temperature", "topP", "topK", "maxOutputTokens"] as const

export type GenerationParamViolation = {
  path: string
  value: string
}

export type MutableGenerationParams = {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  options?: Record<string, unknown>
}

function stripNonFinite(value: unknown, path: string, violations: GenerationParamViolation[]): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      violations.push({ path, value: String(value) })
    }
    return
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      stripNonFinite(value[index], `${path}[${index}]`, violations)
    }
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key]
      if (typeof child === "number" && !Number.isFinite(child)) {
        violations.push({ path: `${path}.${key}`, value: String(child) })
        delete (value as Record<string, unknown>)[key]
      } else {
        stripNonFinite(child, `${path}.${key}`, violations)
      }
    }
  }
}

export function sanitizeNonFiniteGenerationParams(
  params: MutableGenerationParams,
): GenerationParamViolation[] {
  const violations: GenerationParamViolation[] = []

  for (const key of TOP_LEVEL_NUMERIC_KEYS) {
    const value = params[key]
    if (typeof value === "number" && !Number.isFinite(value)) {
      delete params[key]
      violations.push({ path: key, value: String(value) })
    }
  }

  if (params.options !== undefined) {
    stripNonFinite(params.options, "options", violations)
  }

  return violations
}
