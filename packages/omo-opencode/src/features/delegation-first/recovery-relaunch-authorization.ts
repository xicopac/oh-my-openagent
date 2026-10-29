import type { ModelRoutingConfig } from "../../config/schema"
import { isFreePricing, type PricingCatalog } from "../../hooks/resource-governor/pricing"
import { readPaidModelApprovals, type PaidModelApprovalsSnapshot } from "../../shared/paid-model-approvals"
import type { FallbackEntry } from "../../shared/model-requirements"

export const RECOVERY_RELAUNCH_DENIED_PREFIX = "RECOVERY_RELAUNCH_DENIED"

export type RecoveryRelaunchDenyCode =
  | "MODEL_UNRESOLVED"
  | "MODEL_UNKNOWN_COST"
  | "MODEL_PAID"
  | "PAID_POLICY_DISABLED"
  | "PAID_AUTHORITY_REJECTED"
  | "PAID_APPROVAL_MISSING"
  | "PAID_APPROVAL_INVALID"

export type RecoveryRelaunchAuthorization =
  | { allowed: true; kind: "free"; model: string }
  | { allowed: true; kind: "approved_paid"; model: string; approvedBy: string; approvedAt: string }
  | { allowed: false; code: RecoveryRelaunchDenyCode; message: string }

export type AuthorizeRecoveryRelaunchInput = {
  model: string | null | undefined
  /**
   * True only when the retained candidate was verified free against live
   * provider pricing when its ladder was built. Used as pricing evidence when
   * the static catalog has no entry for a locally configured free model.
   */
  verifiedFree?: boolean
  pricing?: PricingCatalog
  modelRouting?: ModelRoutingConfig
  rootSessionID?: string
  requestingSessionID?: string
  approvals?: PaidModelApprovalsSnapshot
  approvalsPath?: string
}

function denied(code: RecoveryRelaunchDenyCode, detail: string): RecoveryRelaunchAuthorization {
  return {
    allowed: false,
    code,
    message: `${RECOVERY_RELAUNCH_DENIED_PREFIX}:${code}: ${detail}`,
  }
}

function paidPolicyAllows(modelRouting: ModelRoutingConfig | undefined): boolean {
  const policy = modelRouting?.paid_workers?.policy ?? "master_with_operator_consent"
  return policy === "master_with_operator_consent"
}

function isRootAuthority(rootSessionID: string | undefined, requestingSessionID: string | undefined): boolean {
  if (!rootSessionID || !requestingSessionID) return false
  return rootSessionID === requestingSessionID
}

export function authorizeRecoveryRelaunch(
  input: AuthorizeRecoveryRelaunchInput,
): RecoveryRelaunchAuthorization {
  const model = typeof input.model === "string" ? input.model.trim() : ""
  if (model.length === 0) {
    return denied("MODEL_UNRESOLVED", "recovery relaunch has no resolved model")
  }

  const price = input.pricing?.[model]
  if (price !== undefined) {
    if (isFreePricing(price)) {
      return { allowed: true, kind: "free", model }
    }
    return authorizePaid(input, model)
  }

  if (input.verifiedFree === true) {
    return { allowed: true, kind: "free", model }
  }

  return denied(
    "MODEL_UNKNOWN_COST",
    `model "${model}" has no verified pricing evidence; unknown cost is never treated as free`,
  )
}

function authorizePaid(
  input: AuthorizeRecoveryRelaunchInput,
  model: string,
): RecoveryRelaunchAuthorization {
  if (!paidPolicyAllows(input.modelRouting)) {
    return denied(
      "PAID_POLICY_DISABLED",
      `paid workers are disabled by policy; refusing paid recovery relaunch for "${model}"`,
    )
  }

  if (!isRootAuthority(input.rootSessionID, input.requestingSessionID)) {
    return denied(
      "PAID_AUTHORITY_REJECTED",
      `only the master/root session may authorize a paid recovery relaunch for "${model}"`,
    )
  }

  const snapshot =
    input.approvals ??
    readPaidModelApprovals(input.approvalsPath)

  if (snapshot.status === "missing") {
    return denied(
      "PAID_APPROVAL_MISSING",
      `paid recovery relaunch for "${model}" requires an explicit approval; no approval file at ${snapshot.path}`,
    )
  }
  if (snapshot.status === "invalid") {
    return denied(
      "PAID_APPROVAL_INVALID",
      `paid recovery relaunch for "${model}" requires an explicit approval; approval file is invalid: ${snapshot.error}`,
    )
  }

  const approval = snapshot.approvals.find((entry) => entry.model === model)
  if (!approval) {
    return denied(
      "PAID_APPROVAL_MISSING",
      `paid recovery relaunch for "${model}" requires an exact approval entry in ${snapshot.path}`,
    )
  }

  return {
    allowed: true,
    kind: "approved_paid",
    model,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
  }
}

export function filterFreeRecoveryFallbackChain(
  chain: FallbackEntry[] | undefined,
  input: {
    pricing?: PricingCatalog
    verifiedFreeModels?: ReadonlySet<string>
  },
): FallbackEntry[] | undefined {
  if (!chain || chain.length === 0) return chain

  const kept = chain.filter((entry) => {
    const model = typeof entry.model === "string" ? entry.model.trim() : ""
    if (model.length === 0) return false
    const providers = entry.providers.length > 0 ? entry.providers : [""]
    return providers.every((provider) => {
      const key = provider.length > 0 ? `${provider}/${model}` : model
      const price = input.pricing?.[key]
      if (price !== undefined) return isFreePricing(price)
      return input.verifiedFreeModels?.has(key) === true
    })
  })

  return kept.length > 0 ? kept : undefined
}
