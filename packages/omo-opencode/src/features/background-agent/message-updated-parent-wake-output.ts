import { isEmptyNoProgressAssistantTurnInfo } from "./empty-assistant-turn"
import type { PendingParentWake } from "./parent-wake-dedupe"

export function parentWakeOutputIsCausallyNewer(
  messageID: string | undefined,
  wake: PendingParentWake | undefined,
): boolean {
  if (!wake?.preDispatchAssistantMessageID) return true
  return messageID !== undefined && messageID !== wake.preDispatchAssistantMessageID
}

export function messageUpdatedInfoHasParentWakeOutput(
  info: Record<string, unknown>,
  role: unknown,
  wake?: PendingParentWake,
): boolean {
  const messageID = typeof info.id === "string"
    ? info.id
    : typeof info.messageID === "string"
      ? info.messageID
      : undefined
  if (!parentWakeOutputIsCausallyNewer(messageID, wake)) {
    return false
  }
  if (role === "tool") {
    return true
  }
  if (role !== "assistant") {
    return false
  }
  if (info.error) {
    return false
  }
  if (isEmptyNoProgressAssistantTurnInfo(info)) {
    return false
  }
  const tokens = typeof info.tokens === "object" && info.tokens !== null
    ? info.tokens as Record<string, unknown>
    : undefined
  const output = typeof tokens?.output === "number" ? tokens.output : 0
  const reasoning = typeof tokens?.reasoning === "number" ? tokens.reasoning : 0
  return output > 0 || reasoning > 0
}
