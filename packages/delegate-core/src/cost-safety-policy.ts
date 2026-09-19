// Cost-safety: children free-only by default.
export const DEFAULT_ALLOW_PAID_WORKERS = false
export const DEFAULT_MAX_CONCURRENT_PAID_WORKERS = 1
export const NO_ELIGIBLE_FREE_MODEL = "no-eligible-free-model"
export type CostSafetyPolicy = { allowPaidWorkers: boolean; maxConcurrentPaidWorkers: number }
export const DEFAULT_COST_SAFETY_POLICY: CostSafetyPolicy = { allowPaidWorkers: false, maxConcurrentPaidWorkers: 1 }
export function resolveCostSafetyPolicy(input: { allowPaidWorkers?: boolean; maxConcurrentPaidWorkers?: number } | undefined): CostSafetyPolicy {
  const max =
    typeof input?.maxConcurrentPaidWorkers === "number" && input.maxConcurrentPaidWorkers >= 1
      ? input.maxConcurrentPaidWorkers
      : DEFAULT_MAX_CONCURRENT_PAID_WORKERS
  return { allowPaidWorkers: input?.allowPaidWorkers ?? DEFAULT_ALLOW_PAID_WORKERS, maxConcurrentPaidWorkers: max }
}
