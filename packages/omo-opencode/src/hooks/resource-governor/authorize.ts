/**
 * Single shared pre-dispatch enforcement API ("authorizeChildDispatch"). Every
 * child execution path in OMA — the delegate-task `task` tool (sync and
 * background), `call_omo_agent` (sync and background), the background-task
 * tool, team-mode member spawns, and unstable-agent spawns — must call this
 * exactly once, immediately before creating the child session / prompting it.
 *
 * The pure decision core owns the decision; this layer only normalizes the
 * core's DelegationDecision into a stable verdict enum (ALLOW / BLOCK /
 * REQUIRE_CONSENT / DUPLICATE / DECLINED) and packages the user-facing block
 * message. It deliberately reintroduces NO policy logic: all thresholds,
 * ceilings, routing, and consent rules live in governor.ts / budget.ts /
 * routing.ts.
 */

import { enforcementError, type DelegateEnforcementInput, type ResourceGovernorRuntime } from "./runtime"
import type { ChildLaunchAuthorization } from "./backstop"

/** Stable, path-agnostic pre-dispatch verdict consumed by every spawn path. */
export type AuthorizeResult =
  | { verdict: "ALLOW"; escrowID: string; authorization?: ChildLaunchAuthorization }
  | { verdict: "BLOCK"; condition: "RESOURCE_BUDGET_EXHAUSTED" | "TOKEN_BUDGET_EXHAUSTED"; message: string }
  | { verdict: "REQUIRE_CONSENT"; reason: string; message: string }
  | { verdict: "DUPLICATE"; message: string }
  | { verdict: "DECLINED"; reason: string; message: string }

/**
 * Authorize a fully-resolved child dispatch. Returns ALLOW when the child may
 * proceed; every other verdict blocks execution and carries a user-facing
 * message. `null` decision (no resolved model / governor disabled) is ALLOW.
 */
export function authorizeChildDispatch(
  runtime: ResourceGovernorRuntime,
  input: DelegateEnforcementInput,
  now?: number,
): AuthorizeResult {
  const decision = runtime.enforce(input, now)
  if (decision === null) {
    return {
      verdict: "ALLOW",
      escrowID: "",
      authorization: runtime.launchGuard.issue({
        sessionID: input.sessionID,
        workerIdentity: input.workerIdentity ?? input.role,
        resolvedModelID: input.resolvedModelID ?? "",
        escrowID: "",
      }),
    }
  }
  const message = enforcementError(decision)
  switch (decision.kind) {
    case "approved":
      return {
        verdict: "ALLOW",
        escrowID: decision.seed.escrow_id,
        authorization: runtime.launchGuard.issue({
          sessionID: input.sessionID,
          workerIdentity: input.workerIdentity ?? input.role,
          resolvedModelID: decision.seed.resolved_model,
          escrowID: decision.seed.escrow_id,
        }),
      }
    case "blocked":
      return { verdict: "BLOCK", condition: decision.condition, message: message ?? "blocked" }
    case "consent_required":
      return { verdict: "REQUIRE_CONSENT", reason: decision.reason, message: message ?? "consent required" }
    case "duplicate":
      return { verdict: "DUPLICATE", message: message ?? "duplicate work prevented" }
    case "declined":
      return { verdict: "DECLINED", reason: decision.reason, message: message ?? "delegation declined" }
  }
}

/**
 * Thrown by a spawn path (notably BackgroundManager.launch) when authorization
 * blocks the dispatch. Carries the exact user-facing message so callers that
 * already translate Errors to strings surface the governor's wording, not a
 * generic failure prefix.
 */
export class ResourceGovernorRejectedError extends Error {
  // @allow the message is intentionally the full user-facing block text.
  constructor(message: string) {
    super(message)
    this.name = "ResourceGovernorRejectedError"
  }
}

export function blockMessage(result: AuthorizeResult): string | null {
  return result.verdict === "ALLOW" ? null : result.message
}
