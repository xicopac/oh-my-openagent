export type ProviderErrorSnapshot = {
  providerID?: string
  modelID?: string
  name?: string
  code?: string
  message: string
  statusCode?: number
  retryable: boolean
  quotaExhausted: boolean
}

export type ProviderTerminalReasonCode = "provider_quota_exhausted"
