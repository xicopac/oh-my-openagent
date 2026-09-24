import {
  deriveHumanAuthorizationsFromUserMessage,
} from "./human-explicit-authorization"
import type { DelegationFirstRuntime } from "./runtime"

/**
 * Trusted helper: derive human authorizations from an ACTUAL user-role message
 * and register them on the master session only.
 *
 * - Skips child/subagent sessions (via runtime.isChildSession)
 * - Only derives from role === "user" (conservative — assistant/tool/subagent grants nothing)
 * - Idempotent and cheap: no grants when derivation is empty
 */
export function handleUserMessageHumanAuthorization(
  runtime: DelegationFirstRuntime,
  sessionID: string,
  message: { role: string; content: string },
): void {
  if (runtime.isChildSession(sessionID)) return
  if (message.role !== "user") return
  const grants = deriveHumanAuthorizationsFromUserMessage(message)
  if (grants.length === 0) return
  for (const auth of grants) {
    runtime.grantHumanAuthorization(sessionID, auth)
  }
}
