import {
  classifyRuntimeFallbackError,
  isTerminalQuotaError,
} from "@oh-my-opencode/model-core"
import type { AutoRetryHelpers } from "./auto-retry"
import type { HookDeps } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { subagentSessions } from "../../features/claude-code-session-state"

export const TERMINAL_QUOTA_OUTCOME = "BLOCKED_QUOTA" as const

export type RuntimeFallbackTerminalOutcome = typeof TERMINAL_QUOTA_OUTCOME

export type TerminalQuotaBegin = RuntimeFallbackTerminalOutcome | "DUPLICATE" | undefined

/**
 * A quota the provider cannot recover from inside this session: either the
 * provider marks it terminal, or it classifies as quota exhaustion. The caller
 * pairs this outcome with a single terminal wake and no further retries.
 */
export function classifyTerminalQuotaOutcome(
  error: unknown,
): RuntimeFallbackTerminalOutcome | undefined {
  if (isTerminalQuotaError(error)) return TERMINAL_QUOTA_OUTCOME
  return classifyRuntimeFallbackError(error) === "quota_exceeded"
    ? TERMINAL_QUOTA_OUTCOME
    : undefined
}

export function createTerminalQuotaGuard(deps: HookDeps, helpers: AutoRetryHelpers) {
  const terminalSessions = deps.terminalQuotaSessions ?? new Set<string>()

  const deliver = async (sessionID: string, abortSource: string | undefined): Promise<void> => {
    const alreadyDelivered = terminalSessions.has(sessionID)
    terminalSessions.add(sessionID)
    helpers.clearSessionFallbackTimeout(sessionID)
    if (abortSource && !alreadyDelivered) {
      await helpers.abortSessionRequest(sessionID, abortSource)
    }
    log(`[${HOOK_NAME}] ${TERMINAL_QUOTA_OUTCOME} recorded`, {
      sessionID,
      abortSource: abortSource ?? null,
      alreadyDelivered,
    })
  }

  return {
    begin(error: unknown, sessionID: string): TerminalQuotaBegin {
      const outcome = classifyTerminalQuotaOutcome(error)
      if (!outcome) return undefined
      if (terminalSessions.has(sessionID)) {
        log(`[${HOOK_NAME}] ${outcome} already delivered; suppressing duplicate terminal quota event`, {
          sessionID,
        })
        return "DUPLICATE"
      }
      helpers.clearSessionFallbackTimeout(sessionID)
      log(`[${HOOK_NAME}] ${outcome} detected; cancelled scheduled retry timer`, { sessionID })
      return outcome
    },
    deliver,
    async deliverNoFallback(sessionID: string, model: string | undefined): Promise<void> {
      const isSubagent = subagentSessions.has(sessionID)
      if (isSubagent) {
        log(`[${HOOK_NAME}] Aborting subagent on unrecoverable quota error (no fallback configured)`, {
          sessionID,
          model,
        })
      }
      await deliver(sessionID, isSubagent ? "message.updated.subagent-quota-no-fallback" : undefined)
    },
    async deliverIfChainExhausted(
      sessionID: string,
      attemptsBefore: number,
      attemptsAfter: number,
    ): Promise<void> {
      if (attemptsAfter !== attemptsBefore) return
      await deliver(sessionID, undefined)
    },
    async abortForFallback(sessionID: string): Promise<void> {
      await helpers.abortSessionRequest(sessionID, "message.updated.quota-fallback")
      deps.sessionRetryInFlight.delete(sessionID)
    },
  }
}
