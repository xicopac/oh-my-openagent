/**
 * Recovery-probe driver helpers for the delegation-first control plane.
 *
 * When a root session enters recovery_mode, the runtime auto-begins a single
 * recovery probe. The probe is a real `task` child: the root appends a nonce
 * directive to the child prompt, and the child echoes the nonce in its final
 * result. Consuming that result (sync return or background_output) verifies
 * delegation end-to-end and moves the root to recovery_verified.
 */

import type { DelegationFirstRuntime } from "../../features/delegation-first"

export const RECOVERY_PROBE_ECHO_PREFIX = "RECOVERY_PROBE_ECHO:"

/**
 * Append the machine-consumed recovery-probe directive (including the nonce
 * echo token) to a child prompt. The child must echo the token verbatim so the
 * root can prove a full dispatch -> response round trip.
 */
export function appendRecoveryProbeDirective(prompt: string, nonce: string): string {
  const directive = [
    "",
    "---",
    "RECOVERY PROBE DIRECTIVE: This delegation is a control-plane recovery probe.",
    "Do the requested work normally. When you finish, you MUST include this exact",
    "line verbatim at the end of your final response so the control plane can",
    `verify end-to-end delegation health: ${RECOVERY_PROBE_ECHO_PREFIX}${nonce}`,
  ].join("\n")
  return `${prompt}${directive}`
}

/**
 * Verify the active recovery probe when its result text is consumed. Returns
 * true only when the session is in recovery_mode, a probe is active, and the
 * result carries the probe nonce; on success the runtime moves the session to
 * recovery_verified.
 */
export function maybeVerifyRecoveryProbe(
  rt: DelegationFirstRuntime,
  sessionID: string,
  resultText: string,
): boolean {
  if (typeof resultText !== "string" || resultText.length === 0) return false
  const snapshot = rt.recoverySnapshot(sessionID)
  if (snapshot.phase !== "recovery_mode") return false
  const probe = snapshot.activeProbe
  if (!probe) return false
  if (!resultText.includes(probe.nonce)) return false
  return rt.markRecoveryVerified(sessionID, probe.probeID)
}
