/**
 * PAID-WORKER CONSENT GATE.
 *
 * A paid child launch requires BOTH:
 *   1. true MASTER/ROOT session authority (a session with no parentID in the
 *      OpenCode session hierarchy), and
 *   2. fresh explicit human/operator consent for that exact launch.
 *
 * Consent is enforced host-side through OpenCode's permission mechanism
 * (ToolContext.ask) — never through model reasoning, never via an LLM prompt.
 * Approvals are SINGLE-USE and bound to the root session id, worker/agent
 * identity, exact provider/model, and logical task. The approval is consumed at
 * launch; a second paid launch (even the same model) requires a fresh approval.
 * Paid failover to a different model/task requires a new approval. Free
 * failover is automatic and never prompts.
 *
 * Unknown-cost models are treated as paid for this boundary (fail closed).
 * When no interactive operator can be reached the gate returns unavailable
 * and the launch is blocked (fail closed). The old global allow_paid_workers
 * boolean is deprecated and can never bypass this gate.
 */

import type { PricingCatalog } from '../../hooks/resource-governor'
import { isFreePricing } from '../../hooks/resource-governor/pricing'
import type { ModelRoutingConfig } from '../../config/schema'
import type { GovernanceAuditWriter } from '../../shared/governance-audit'

export const PAID_ESCALATION_REQUIRED = 'PAID_ESCALATION_REQUIRED'
export const PAID_WORKER_AUTHORITY_REJECTED = 'PAID_WORKER_AUTHORITY_REJECTED'
export const PAID_WORKER_CONSENT_DENIED = 'PAID_WORKER_CONSENT_DENIED'
export const PAID_WORKER_CONSENT_UNAVAILABLE = 'PAID_WORKER_CONSENT_UNAVAILABLE'
export const PAID_WORKER_POLICY_DISABLED = 'PAID_WORKER_POLICY_DISABLED'
export const PAID_WORKER_CONSENT_CONSUMED = 'PAID_WORKER_CONSENT_CONSUMED'

export type PaidWorkerBlockCode =
  | typeof PAID_WORKER_AUTHORITY_REJECTED
  | typeof PAID_WORKER_CONSENT_DENIED
  | typeof PAID_WORKER_CONSENT_UNAVAILABLE
  | typeof PAID_WORKER_POLICY_DISABLED
  | typeof PAID_WORKER_CONSENT_CONSUMED

export const PAID_CONSENT_AUDIT_EVENTS = [
  'paid_worker_requested',
  'approval_requested',
  'approval_granted',
  'approval_denied',
  'approval_consumed',
  'paid_worker_launched',
  'paid_worker_blocked',
  'paid_escalation_required',
] as const

export type PaidConsentAuditEvent = (typeof PAID_CONSENT_AUDIT_EVENTS)[number]

export type PaidModelStatus = 'free' | 'paid' | 'unknown'

export function classifyPaidStatus(modelKey: string, pricing: PricingCatalog | undefined): PaidModelStatus {
  const price = pricing?.[modelKey]
  if (price === undefined) return 'unknown'
  return isFreePricing(price) ? 'free' : 'paid'
}

export function isPaidOrUnknown(status: PaidModelStatus): boolean {
  return status !== 'free'
}

export const DEFAULT_PAID_WORKER_POLICY = 'master_with_operator_consent' as const

export function paidBandAllowed(modelRouting: ModelRoutingConfig | undefined, isRootSession: boolean): boolean {
  const policy = modelRouting?.paid_workers?.policy ?? DEFAULT_PAID_WORKER_POLICY
  if (policy !== 'master_with_operator_consent') return false
  return isRootSession
}

export function maxConcurrentPaidWorkers(modelRouting: ModelRoutingConfig | undefined): number {
  const next = modelRouting?.paid_workers?.max_concurrent
  if (typeof next === 'number' && next >= 1) return next
  const legacy = modelRouting?.max_concurrent_paid_workers
  if (typeof legacy === 'number' && legacy >= 1) return legacy
  return 1
}

export type PaidWorkerConsentRequest = {
  rootSessionID: string
  childAgentType: string
  capabilityTier: string | null
  model: string
  provider: string
  billable: boolean
  reason: string
  freeCandidatesExhausted: boolean
  task: string
  taskID: string
}

export type PaidConsentOutcome = 'approved' | 'denied' | 'unavailable'

export type PaidWorkerApproval = {
  nonce: string
  request: PaidWorkerConsentRequest
  verdict: PaidConsentOutcome
  decidedAt: number
}

export interface PaidConsentProvider {
  request(request: PaidWorkerConsentRequest): Promise<PaidConsentOutcome>
}

export function createStaticConsentProvider(outcome: PaidConsentOutcome): PaidConsentProvider {
  return {
    async request() {
      return outcome
    },
  }
}

export type AskPermissionFn = (input: {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}) => Promise<void>

export function createOpenCodePermissionConsentProvider(
  ask: AskPermissionFn | undefined,
  opts: { nonInteractive?: boolean } = {},
): PaidConsentProvider {
  return {
    async request(request) {
      if (!ask || opts.nonInteractive === true) return 'unavailable'
      try {
        const nonce = crypto.randomUUID()
        await ask({
          permission: 'paid_worker_launch',
          patterns: [],
          always: [],
          metadata: {
            request_id: nonce,
            root_session_id: request.rootSessionID,
            agent: request.childAgentType,
            tier: request.capabilityTier ?? 'default',
            model: request.model,
            provider: request.provider,
            billable: request.billable,
            reason: request.reason,
            free_candidates_exhausted: request.freeCandidatesExhausted,
            task: request.task,
            task_id: request.taskID,
          },
        })
        return 'approved'
      } catch {
        return 'denied'
      }
    },
  }
}

export type PaidLaunchIdentity = {
  rootSessionID: string
  workerIdentity: string
  resolvedModelID: string
  taskID: string
}

export class PaidConsentRegistry {
  private readonly approvals = new Map<string, PaidWorkerApproval>()
  private readonly consumed = new Set<string>()

  request(request: PaidWorkerConsentRequest, now = Date.now()): { nonce: string } {
    const nonce = crypto.randomUUID()
    this.approvals.set(nonce, { nonce, request, verdict: 'unavailable', decidedAt: now })
    return { nonce }
  }

  decide(nonce: string, outcome: PaidConsentOutcome, now = Date.now()): PaidWorkerApproval | undefined {
    const approval = this.approvals.get(nonce)
    if (!approval) return undefined
    approval.verdict = outcome
    approval.decidedAt = now
    return approval
  }

  get(nonce: string): PaidWorkerApproval | undefined {
    return this.approvals.get(nonce)
  }

  consumeAndVerify(nonce: string | undefined, identity: PaidLaunchIdentity): PaidWorkerApproval | null {
    if (!nonce) return null
    if (this.consumed.has(nonce)) return null
    const approval = this.approvals.get(nonce)
    if (!approval) return null
    if (approval.verdict !== 'approved') return null
    if (approval.request.rootSessionID !== identity.rootSessionID) return null
    if (approval.request.childAgentType !== identity.workerIdentity) return null
    if (approval.request.model !== identity.resolvedModelID) return null
    if (approval.request.taskID !== identity.taskID) return null
    this.consumed.add(nonce)
    return approval
  }

  isConsumed(nonce: string): boolean {
    return this.consumed.has(nonce)
  }

  pendingCount(): number {
    let count = 0
    for (const approval of this.approvals.values()) {
      if (approval.verdict === 'approved' && !this.consumed.has(approval.nonce)) count += 1
    }
    return count
  }
}

export type EnforcePaidWorkerLaunchInput = {
  resolvedModelKey: string | null
  pricing: PricingCatalog | undefined
  modelRouting: ModelRoutingConfig | undefined
  isRootSession: boolean
  rootSessionID: string
  workerIdentity: string
  capabilityTier: string | null
  task: string
  taskID: string
  reason?: string
  freeCandidatesExhausted: boolean
  consentProvider: PaidConsentProvider
  registry: PaidConsentRegistry
  audit?: GovernanceAuditWriter
}

export type PaidWorkerLaunchVerdict =
  | { action: 'allow_free' }
  | { action: 'allow_paid'; nonce: string }
  | { action: 'block'; code: PaidWorkerBlockCode; message: string }

function providerOf(modelKey: string): string {
  const slash = modelKey.indexOf('/')
  return slash > 0 ? modelKey.slice(0, slash) : modelKey
}

export async function enforcePaidWorkerLaunch(
  input: EnforcePaidWorkerLaunchInput,
): Promise<PaidWorkerLaunchVerdict> {
  const { resolvedModelKey, pricing } = input
  if (!resolvedModelKey) return { action: 'allow_free' }

  const status = classifyPaidStatus(resolvedModelKey, pricing)
  if (status === 'free') return { action: 'allow_free' }

  const audit = input.audit
  const emit = (event: PaidConsentAuditEvent, detail: Record<string, unknown>): void => {
    audit?.write(input.rootSessionID, { subsystem: 'paid_consent', event, ...detail })
  }

  const policy = input.modelRouting?.paid_workers?.policy ?? DEFAULT_PAID_WORKER_POLICY
  if (policy !== 'master_with_operator_consent') {
    emit('paid_worker_blocked', { reason: PAID_WORKER_POLICY_DISABLED, model: resolvedModelKey })
    return {
      action: 'block',
      code: PAID_WORKER_POLICY_DISABLED,
      message: 'PAID_WORKER_POLICY_DISABLED: paid workers are disabled by policy; refusing paid child launch for ' + resolvedModelKey + '.',
    }
  }

  if (!input.isRootSession) {
    emit('paid_escalation_required', { model: resolvedModelKey, requesting_session_id: input.rootSessionID })
    emit('paid_worker_blocked', { reason: PAID_WORKER_AUTHORITY_REJECTED, model: resolvedModelKey })
    return {
      action: 'block',
      code: PAID_WORKER_AUTHORITY_REJECTED,
      message: 'PAID_WORKER_AUTHORITY_REJECTED: only the master/root session may request a paid worker. A child cannot authorize a paid launch; report free_pool_exhausted to the master instead.',
    }
  }

  const request: PaidWorkerConsentRequest = {
    rootSessionID: input.rootSessionID,
    childAgentType: input.workerIdentity,
    capabilityTier: input.capabilityTier,
    model: resolvedModelKey,
    provider: providerOf(resolvedModelKey),
    billable: true,
    reason: input.reason ?? 'paid worker requested by master',
    freeCandidatesExhausted: input.freeCandidatesExhausted,
    task: input.task,
    taskID: input.taskID,
  }

  emit('paid_worker_requested', {
    requesting_session_id: input.rootSessionID,
    root_authority: input.isRootSession,
    model: resolvedModelKey,
    provider: request.provider,
    billable: request.billable,
    reason: request.reason,
    free_candidates_exhausted: request.freeCandidatesExhausted,
    agent: request.childAgentType,
  })

  const { nonce } = input.registry.request(request)
  emit('approval_requested', { approval_id: nonce, model: resolvedModelKey })

  const outcome = await input.consentProvider.request(request)
  input.registry.decide(nonce, outcome)

  if (outcome === 'approved') {
    emit('approval_granted', { approval_id: nonce, model: resolvedModelKey })
    return { action: 'allow_paid', nonce }
  }

  emit('approval_denied', { approval_id: nonce, outcome, model: resolvedModelKey })
  emit('paid_worker_blocked', { reason: outcome, approval_id: nonce, model: resolvedModelKey })

  if (outcome === 'unavailable') {
    return {
      action: 'block',
      code: PAID_WORKER_CONSENT_UNAVAILABLE,
      message: 'PAID_WORKER_CONSENT_UNAVAILABLE: operator approval is required to launch paid worker ' + resolvedModelKey + ' and no interactive operator is available. Failing closed; no paid launch.',
    }
  }
  return {
    action: 'block',
    code: PAID_WORKER_CONSENT_DENIED,
    message: 'PAID_WORKER_CONSENT_DENIED: the operator denied the paid worker launch for ' + resolvedModelKey + '.',
  }
}

export function consumePaidApproval(
  registry: PaidConsentRegistry,
  nonce: string | undefined,
  identity: PaidLaunchIdentity,
  audit?: GovernanceAuditWriter,
): PaidWorkerApproval | null {
  const approval = registry.consumeAndVerify(nonce, identity)
  if (!approval) return null
  audit?.write(identity.rootSessionID, {
    subsystem: 'paid_consent',
    event: 'approval_consumed',
    approval_id: approval.nonce,
    model: approval.request.model,
  })
  audit?.write(identity.rootSessionID, {
    subsystem: 'paid_consent',
    event: 'paid_worker_launched',
    approval_id: approval.nonce,
    model: approval.request.model,
    agent: approval.request.childAgentType,
    task_id: identity.taskID,
  })
  return approval
}

export function isRootSessionInfo(info: { parentID?: string | null } | undefined): boolean {
  return info === undefined || info.parentID == null
}
