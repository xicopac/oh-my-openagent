import { isProviderExhaustionFallbackEligible } from "@oh-my-opencode/model-core"

import { extractErrorMessage, extractErrorName, extractErrorStatusCode, isRecord } from "./error-classifier"
import type { BackgroundTask } from "./types"
import type { ProviderErrorSnapshot } from "./provider-error-types"

const QUOTA_MESSAGE_PATTERNS: readonly RegExp[] = [
  /free usage exceeded/i,
  /subscribe to go/i,
  /quota.?exceeded/i,
  /exceeded.*quota/i,
  /usage\s*quota/i,
  /insufficient_quota/i,
  /billing.*limit/i,
]

function extractErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  const direct = error["code"]
  if (typeof direct === "string") return direct
  if (typeof direct === "number") return String(direct)

  const data = error["data"]
  if (isRecord(data)) {
    const nested = data["code"]
    if (typeof nested === "string") return nested
    if (typeof nested === "number") return String(nested)
    const nestedError = data["error"]
    if (isRecord(nestedError)) {
      const nestedCode = nestedError["code"]
      if (typeof nestedCode === "string") return nestedCode
      if (typeof nestedCode === "number") return String(nestedCode)
    }
  }
  return undefined
}

function isQuotaEligible(error: unknown): boolean {
  try {
    return isProviderExhaustionFallbackEligible(error)
  } catch {
    return false
  }
}

export function buildProviderErrorSnapshot(
  task: BackgroundTask,
  errorInfo: { name?: string; message?: string; statusCode?: number },
  rawError?: unknown,
): ProviderErrorSnapshot | undefined {
  const message = errorInfo.message ?? extractErrorMessage(rawError)
  const name = errorInfo.name ?? extractErrorName(rawError)
  const statusCode = errorInfo.statusCode ?? extractErrorStatusCode(rawError)

  if (!message && !name && statusCode === undefined && !extractErrorCode(rawError)) return undefined

  const text = [name, message, statusCode === undefined ? undefined : String(statusCode)]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
  const quotaExhausted = isQuotaEligible(errorInfo)
    || (rawError !== undefined && isQuotaEligible(rawError))
    || QUOTA_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))
  // OpenCode's session.status retry envelope carries only the provider message.
  // Preserve a canonical machine-readable code so downstream wake consumers do
  // not lose the quota classification when the raw error body is unavailable.
  const code = extractErrorCode(rawError) ?? (quotaExhausted ? "insufficient_quota" : undefined)

  return {
    ...(task.model?.providerID ? { providerID: task.model.providerID } : {}),
    ...(task.model?.modelID ? { modelID: task.model.modelID } : {}),
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    message: message ?? "Provider request failed",
    retryable: !quotaExhausted,
    quotaExhausted,
  }
}

export function providerErrorModelLabel(error: ProviderErrorSnapshot): string | undefined {
  if (error.providerID && error.modelID) return `${error.providerID}/${error.modelID}`
  return error.modelID ?? error.providerID
}

export function formatProviderBlockedReason(error: ProviderErrorSnapshot): string {
  const model = providerErrorModelLabel(error)
  return `BLOCKED: provider quota exhausted: ${error.message}${model ? ` [${model}]` : ""}; retryable=${error.retryable ? "true" : "false"}; paid fallback requires explicit authorization`
}
