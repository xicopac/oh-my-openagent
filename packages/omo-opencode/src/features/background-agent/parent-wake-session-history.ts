import { isSyntheticOrInternalUserMessage, log } from "../../shared"
import {
  latestAssistantTurnBlocksInternalPrompt,
  latestAssistantTurnHasUnansweredQuestion,
} from "@oh-my-opencode/utils/prompt-async-gate/pending-tool-turn"
import {
  latestAssistantTurnHasFreshToolActivity,
  latestAssistantTurnHasStaleUnknownSubstantiveOutput,
  latestAssistantTurnHasToolBlock,
  latestAssistantTurnIsCompletedEmptyNoProgress,
} from "./parent-wake-history-state"
import type { PendingParentWake } from "./parent-wake-dedupe"
import { getParentWakeMessageCreatedAt } from "./parent-wake-message-activity"
import type { ParentWakeSessionMessage } from "./parent-wake-session-message"

export type ToolWaitDeferralDecision = {
  readonly defer: boolean
  readonly skipPromptGateToolStateCheck: boolean
  readonly reason:
    | "messages_unavailable"
    | "unanswered_question"
    | "stale_tool_turn"
    | "blocking_assistant_turn"
    | null
}

export function parentWakeUserMessageIsInProgress(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly windowMs: number
  readonly now?: number
}): boolean {
  if (input.windowMs <= 0) {
    return false
  }
  if (!input.messages) {
    return true
  }
  const now = input.now ?? Date.now()
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const message = input.messages[index]
    if (!message) {
      continue
    }
    const role = getParentWakeMessageRole(message)
    if (role === "user") {
      if (isSyntheticOrInternalUserMessage(message)) {
        continue
      }
      const createdAt = getParentWakeMessageCreatedAt(message)
      if (createdAt === undefined) {
        return false
      }
      return now - createdAt <= input.windowMs
    }
    if (role === "assistant" || role === "tool") {
      return false
    }
  }
  return false
}

export function getParentWakeSessionHistoryDeferralDecision(input: {
  readonly sessionID: string
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
  readonly toolCallDeferMaxMs: number
  readonly now?: number
}): ToolWaitDeferralDecision {
  if (!input.messages) {
    log("[background-agent] Deferred parent wake because parent messages could not be inspected:", {
      sessionID: input.sessionID,
    })
    return { defer: true, skipPromptGateToolStateCheck: false, reason: "messages_unavailable" }
  }
  const messages = [...input.messages]
  let strippedOwnAdmittedDeposit = false
  if (input.wake.noReplyAdmittedAt !== undefined) {
    while (messages.length > 0) {
      const last = messages[messages.length - 1]
      if (
        !last
        || getParentWakeMessageRole(last) !== "user"
        || !isSyntheticOrInternalUserMessage(last)
        || !parentWakeMessageContainsNotification(last, input.wake)
      ) {
        break
      }
      messages.pop()
      strippedOwnAdmittedDeposit = true
    }
  }
  const latestAssistantBlocksPrompt = latestAssistantTurnBlocksInternalPrompt(messages)
  const latestAssistantHasUnansweredQuestion = latestAssistantTurnHasUnansweredQuestion(messages)
  if (!latestAssistantBlocksPrompt) {
    delete input.wake.toolCallDeferralStartedAt
    delete input.wake.allowEmptyAssistantTurnRetry
    return { defer: false, skipPromptGateToolStateCheck: strippedOwnAdmittedDeposit, reason: null }
  }
  const now = input.now ?? Date.now()
  input.wake.toolCallDeferralStartedAt ??= now
  if (input.wake.allowEmptyAssistantTurnRetry && latestAssistantTurnIsCompletedEmptyNoProgress(messages)) {
    log("[background-agent] Retrying parent wake after completed empty assistant turn:", { sessionID: input.sessionID })
    return { defer: false, skipPromptGateToolStateCheck: true, reason: null }
  }
  if (latestAssistantHasUnansweredQuestion) {
    log("[background-agent] Deferred parent wake because latest assistant question awaits user response:", {
      sessionID: input.sessionID,
    })
    return { defer: true, skipPromptGateToolStateCheck: false, reason: "unanswered_question" }
  }
  if (
    now - input.wake.toolCallDeferralStartedAt >= input.toolCallDeferMaxMs
    && latestAssistantTurnHasToolBlock(messages)
    && !latestAssistantTurnHasFreshToolActivity(messages, now, input.toolCallDeferMaxMs)
  ) {
    // A reply dispatch here would fork a concurrent assistant turn: the turn is
    // still mid-flight, only its busy signals are quiet (silent tool, blind
    // instance-scoped status). Defer so the wake is admitted as noReply at most
    // and resumed by the idle/consumption machinery (ses_14a3ab27bffe incident).
    log("[background-agent] Holding parent wake during stale tool-call deferral:", { sessionID: input.sessionID })
    return { defer: true, skipPromptGateToolStateCheck: true, reason: "stale_tool_turn" }
  }
  if (
    now - input.wake.toolCallDeferralStartedAt >= input.toolCallDeferMaxMs
    && latestAssistantTurnHasStaleUnknownSubstantiveOutput(messages, now, input.toolCallDeferMaxMs)
  ) {
    log("[background-agent] Retrying parent wake after stale unknown-finish assistant output:", {
      sessionID: input.sessionID,
    })
    return { defer: false, skipPromptGateToolStateCheck: true, reason: null }
  }
  log("[background-agent] Deferred parent wake because latest assistant turn blocks internal prompts:", {
    sessionID: input.sessionID,
  })
  return { defer: true, skipPromptGateToolStateCheck: false, reason: "blocking_assistant_turn" }
}

export function hasRecordedParentWakePromptMessage(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
  readonly acceptedMessageSkewMs: number
}): boolean {
  if (input.wake.dispatchedAt === undefined || !input.messages) {
    return false
  }
  const dispatchedAt = input.wake.dispatchedAt
  return input.messages.some((message) => {
    const createdAt = getParentWakeMessageCreatedAt(message)
    if (createdAt === undefined) {
      return false
    }
    if (
      createdAt >= dispatchedAt - input.acceptedMessageSkewMs
      && parentWakeMessageContainsNotification(message, input.wake)
    ) {
      return true
    }
    return false
  })
}

export function hasAssistantOutputAfterParentWakeAdmission(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
}): boolean {
  const admittedAt = input.wake.noReplyAdmittedAt
  if (admittedAt === undefined || !input.messages) {
    return false
  }
  return input.messages.some((message) => {
    if (getParentWakeMessageRole(message) !== "assistant") {
      return false
    }
    const createdAt = getParentWakeMessageCreatedAt(message)
    return createdAt !== undefined && createdAt >= admittedAt && parentWakeMessageHasOutput(message)
  })
}

export function hasAssistantOrToolOutputAfterParentWake(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
}): boolean {
  if (input.wake.dispatchedAt === undefined || !input.messages) {
    return false
  }
  const dispatchedAt = input.wake.dispatchedAt
  return input.messages.some((message) => {
    const createdAt = getParentWakeMessageCreatedAt(message)
    return createdAt !== undefined
      && createdAt >= dispatchedAt
      && parentWakeMessageIsCausallyNewer(message, input.wake)
      && parentWakeMessageHasOutput(message)
  })
}

function getParentWakeMessageRole(message: ParentWakeSessionMessage): string | undefined {
  return message.info?.role ?? message.role
}

function parentWakeMessageHasOutput(message: ParentWakeSessionMessage): boolean {
  const role = getParentWakeMessageRole(message)
  if (role !== "assistant" && role !== "tool") {
    return false
  }
  const finish = message.info?.finish ?? message.finish
  const error = message.info?.error ?? message.error
  if (role === "assistant" && (finish === "error" || error !== undefined)) {
    return false
  }
  if (!message.parts || message.parts.length === 0) {
    return false
  }
  return message.parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return typeof part.text === "string" && part.text.trim().length > 0
    }
    if (
      part.type === "tool"
      || part.type === "tool_use"
      || part.type === "tool-call"
      || part.type === "tool-invocation"
      || part.type === "tool_result"
      || part.type === "tool-result"
    ) {
      return true
    }
    if (part.content !== undefined) {
      if (typeof part.content === "string") {
        return part.content.trim().length > 0
      }
      if (Array.isArray(part.content)) {
        return part.content.length > 0
      }
      return true
    }
    return false
  })
}

function parentWakeMessageIsCausallyNewer(
  message: ParentWakeSessionMessage,
  wake: PendingParentWake,
): boolean {
  const baselineID = wake.preDispatchAssistantMessageID
  if (!baselineID) return true
  const messageID = message.info?.id ?? message.id
  return messageID !== undefined && messageID !== baselineID
}

function parentWakeMessageContainsNotification(message: ParentWakeSessionMessage, wake: PendingParentWake): boolean {
  if (getParentWakeMessageRole(message) !== "user") {
    return false
  }
  return message.parts?.some((part) =>
    typeof part.text === "string" && wake.notifications.some((notification) => part.text?.includes(notification))
  ) ?? false
}
