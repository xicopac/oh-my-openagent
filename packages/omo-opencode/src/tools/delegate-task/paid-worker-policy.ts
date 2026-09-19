import { isFreePricing, type PricingCatalog } from "../../hooks/resource-governor/pricing"
import { NO_ELIGIBLE_FREE_MODEL } from "@oh-my-opencode/delegate-core"

/**
 * COST-SAFETY final gate: verify a resolved child model is allowed under the
 * free-only policy. Fails closed: a model with unknown pricing is NOT treated
 * as free and is rejected for a free-only child.
 */
export function paidWorkerPolicyError(
  resolvedModelKey: string | null | undefined,
  allowPaidWorkers: boolean,
  pricing: PricingCatalog | undefined,
): string | null {
  if (allowPaidWorkers) return null
  if (!resolvedModelKey) return null
  const price = pricing?.[resolvedModelKey]
  if (price === undefined) {
    return `${NO_ELIGIBLE_FREE_MODEL}: model "${resolvedModelKey}" has unknown pricing and cannot be treated as free for an automatically spawned child. Set allow_paid_workers: true to permit paid children.`
  }
  if (isFreePricing(price)) return null
  return `${NO_ELIGIBLE_FREE_MODEL}: model "${resolvedModelKey}" is paid and automatically spawned children are free-only by default. Set allow_paid_workers: true to permit paid children.`
}
