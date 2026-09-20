import { describe, expect, test } from 'bun:test'
import {
  PAID_ESCALATION_REQUIRED,
  PAID_WORKER_AUTHORITY_REJECTED,
  PAID_WORKER_CONSENT_DENIED,
  PAID_WORKER_CONSENT_UNAVAILABLE,
  PaidConsentRegistry,
  classifyPaidStatus,
  consumePaidApproval,
  createOpenCodePermissionConsentProvider,
  createStaticConsentProvider,
  enforcePaidWorkerLaunch,
  isPaidOrUnknown,
  isRootSessionInfo,
  maxConcurrentPaidWorkers,
  paidBandAllowed,
  type PaidWorkerConsentRequest,
} from './paid-consent'
import type { GovernanceAuditWriter } from '../../shared/governance-audit'
import type { PricingCatalog } from '../../hooks/resource-governor'

const FREE = 'opencode/free-a'
const PAID = 'opencode/deepseek-v4-flash'
const UNKNOWN = 'opencode/unknown-cost'

const PRICING: PricingCatalog = {
  [FREE]: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  [PAID]: { input: 0.3, output: 0.9, cache_read: 0, cache_write: 0 },
}

const ROOT = 'ses_root'
const TASK = 'task-1'

function makeAudit(): {
  audit: GovernanceAuditWriter
  events: Array<{ session: string; fields: Record<string, unknown> }>
} {
  const events: Array<{ session: string; fields: Record<string, unknown> }> = []
  const audit: GovernanceAuditWriter = {
    write: (session, fields) => {
      events.push({ session, fields })
    },
    path: () => '',
    flush: async () => {},
  }
  return { audit, events }
}

function gateInput(overrides: Partial<Parameters<typeof enforcePaidWorkerLaunch>[0]> = {}) {
  return {
    resolvedModelKey: PAID,
    pricing: PRICING,
    modelRouting: undefined,
    isRootSession: true,
    rootSessionID: ROOT,
    workerIdentity: 'general',
    capabilityTier: 'strong',
    task: TASK,
    taskID: TASK,
    reason: 'free worker pool exhausted',
    freeCandidatesExhausted: true,
    consentProvider: createStaticConsentProvider('approved'),
    registry: new PaidConsentRegistry(),
    audit: makeAudit().audit,
    ...overrides,
  }
}

function identityFor(model: string, overrides: Partial<Parameters<typeof consumePaidApproval>[2]> = {}) {
  return {
    rootSessionID: ROOT,
    workerIdentity: 'general',
    resolvedModelID: model,
    taskID: TASK,
    ...overrides,
  }
}

function eventNames(events: Array<{ fields: Record<string, unknown> }>): string[] {
  return events.map((e) => String(e.fields.event ?? ''))
}

describe('paid-consent authority boundary', () => {
  test('#given a true root session #when it works on its own paid model #then the child-launch gate does not apply', () => {
    // The gate governs CHILD launches only; the root's own model usage is never
    // a delegated child and stays ungated.
    expect(isRootSessionInfo({ parentID: null })).toBe(true)
    expect(paidBandAllowed(undefined, true)).toBe(true)
    expect(classifyPaidStatus(FREE, PRICING)).toBe('free')
  })

  test('#given an ordinary child #when it resolves a model #then the paid band stays closed', () => {
    // Default policy is master_with_operator_consent, but a child lacks master
    // authority so it can never resolve into a paid band.
    expect(paidBandAllowed(undefined, false)).toBe(false)
    expect(paidBandAllowed({ paid_workers: { policy: 'master_with_operator_consent' } }, false)).toBe(false)
    expect(paidBandAllowed({ allow_paid_workers: true }, false)).toBe(false)
  })

  test('#given the free pool is exhausted #when a child requests resolution #then no paid launch is possible', async () => {
    const { audit, events } = makeAudit()
    const verdict = await enforcePaidWorkerLaunch(
      gateInput({ isRootSession: false, audit }),
    )
    expect(verdict.action).toBe('block')
    if (verdict.action === 'block') expect(verdict.code).toBe(PAID_WORKER_AUTHORITY_REJECTED)
    expect(eventNames(events)).not.toContain('paid_worker_launched')
  })

  test('#given a child attempts a direct paid launch #when the gate runs #then it is rejected', async () => {
    const verdict = await enforcePaidWorkerLaunch(
      gateInput({ isRootSession: false }),
    )
    expect(verdict.action).toBe('block')
    if (verdict.action === 'block') expect(verdict.code).toBe(PAID_WORKER_AUTHORITY_REJECTED)
  })

  test('#given a child requests model_tier master #when the gate runs #then it still cannot authorize paid execution', async () => {
    const verdict = await enforcePaidWorkerLaunch(
      gateInput({ isRootSession: false, capabilityTier: 'master' }),
    )
    expect(verdict.action).toBe('block')
    if (verdict.action === 'block') expect(verdict.code).toBe(PAID_WORKER_AUTHORITY_REJECTED)
  })

  test('#given a child hits a paid escalation need #when the gate blocks #then paid_escalation_required propagates', async () => {
    const { audit, events } = makeAudit()
    await enforcePaidWorkerLaunch(gateInput({ isRootSession: false, audit }))
    const names = eventNames(events)
    expect(names).toContain('paid_escalation_required')
    expect(PAID_ESCALATION_REQUIRED).toBe('PAID_ESCALATION_REQUIRED')
  })
})

describe('paid-consent operator approval', () => {
  test('#given a master requests a paid child #when an approving operator is asked #then an approval prompt is created and granted', async () => {
    const { audit, events } = makeAudit()
    const verdict = await enforcePaidWorkerLaunch(gateInput({ audit }))
    expect(verdict.action).toBe('allow_paid')
    const names = eventNames(events)
    expect(names).toContain('paid_worker_requested')
    expect(names).toContain('approval_requested')
    expect(names).toContain('approval_granted')
  })

  test('#given the operator denies #when the gate runs #then zero paid launches happen', async () => {
    const { audit, events } = makeAudit()
    const verdict = await enforcePaidWorkerLaunch(
      gateInput({ consentProvider: createStaticConsentProvider('denied'), audit }),
    )
    expect(verdict.action).toBe('block')
    if (verdict.action === 'block') expect(verdict.code).toBe(PAID_WORKER_CONSENT_DENIED)
    const names = eventNames(events)
    expect(names).toContain('approval_denied')
    expect(names).not.toContain('approval_granted')
    expect(names).not.toContain('paid_worker_launched')
  })

  test('#given the operator approves #when the approval is consumed #then exactly one paid child launch is authorized', async () => {
    const { audit, events } = makeAudit()
    const registry = new PaidConsentRegistry()
    const verdict = await enforcePaidWorkerLaunch(gateInput({ audit, registry }))
    expect(verdict.action).toBe('allow_paid')
    if (verdict.action !== 'allow_paid') return

    const first = consumePaidApproval(registry, verdict.nonce, identityFor(PAID), audit)
    expect(first).not.toBeNull()
    // Single use: a second consume of the same nonce is rejected.
    expect(consumePaidApproval(registry, verdict.nonce, identityFor(PAID), audit)).toBeNull()
    expect(registry.isConsumed(verdict.nonce)).toBe(true)
    expect(eventNames(events)).toContain('paid_worker_launched')
  })

  test('#given an approval is consumed #when a second paid launch is attempted #then a fresh approval is required', async () => {
    const registry = new PaidConsentRegistry()
    const first = await enforcePaidWorkerLaunch(gateInput({ registry }))
    expect(first.action).toBe('allow_paid')
    if (first.action !== 'allow_paid') return
    consumePaidApproval(registry, first.nonce, identityFor(PAID))

    // The old approval is gone; the second launch must mint a new nonce and a
    // new approval even for an identical launch.
    const second = await enforcePaidWorkerLaunch(gateInput({ registry }))
    expect(second.action).toBe('allow_paid')
    if (second.action !== 'allow_paid') return
    expect(second.nonce).not.toBe(first.nonce)
    expect(registry.isConsumed(first.nonce)).toBe(true)
    expect(registry.isConsumed(second.nonce)).toBe(false)
  })
})

describe('paid-consent single-use binding', () => {
  test('#given approved model A fails #when the router proposes model B #then B requires a fresh approval', async () => {
    const registry = new PaidConsentRegistry()
    const verdict = await enforcePaidWorkerLaunch(gateInput({ registry }))
    expect(verdict.action).toBe('allow_paid')
    if (verdict.action !== 'allow_paid') return
    consumePaidApproval(registry, verdict.nonce, identityFor(PAID))

    const modelB = 'openai/paid-strong'
    const reused = consumePaidApproval(registry, verdict.nonce, identityFor(modelB))
    expect(reused).toBeNull()
  })

  test('#given an approval for model A #when it is reused for model B #then it is rejected', async () => {
    const registry = new PaidConsentRegistry()
    const verdict = await enforcePaidWorkerLaunch(gateInput({ registry }))
    if (verdict.action !== 'allow_paid') throw new Error('expected approval')
    const modelB = 'openai/paid-strong'
    expect(consumePaidApproval(registry, verdict.nonce, identityFor(modelB))).toBeNull()
  })

  test('#given an approval for task X #when it is reused for task Y #then it is rejected', async () => {
    const registry = new PaidConsentRegistry()
    const verdict = await enforcePaidWorkerLaunch(gateInput({ registry }))
    if (verdict.action !== 'allow_paid') throw new Error('expected approval')
    expect(consumePaidApproval(registry, verdict.nonce, identityFor(PAID, { taskID: 'task-2' }))).toBeNull()
  })

  test('#given an approval from root session R1 #when it is reused by session R2 #then it is rejected', async () => {
    const registry = new PaidConsentRegistry()
    const verdict = await enforcePaidWorkerLaunch(gateInput({ registry }))
    if (verdict.action !== 'allow_paid') throw new Error('expected approval')
    expect(
      consumePaidApproval(registry, verdict.nonce, identityFor(PAID, { rootSessionID: 'ses_other_root' })),
    ).toBeNull()
  })

  test('#given a nested worker #when it tries to spoof root authority #then the session hierarchy rejects it', async () => {
    expect(isRootSessionInfo({ parentID: 'ses_parent' })).toBe(false)
    expect(isRootSessionInfo({ parentID: undefined })).toBe(true)
    expect(isRootSessionInfo(undefined)).toBe(true)
  })
})

describe('paid-consent fail-closed and free failover', () => {
  test('#given a non-interactive environment #when a paid launch is requested #then it fails closed', async () => {
    const noAsk = createOpenCodePermissionConsentProvider(undefined)
    expect(await noAsk.request(requestFixture())).toBe('unavailable')

    const { audit, events } = makeAudit()
    const verdict = await enforcePaidWorkerLaunch(
      gateInput({ consentProvider: noAsk, audit }),
    )
    expect(verdict.action).toBe('block')
    if (verdict.action === 'block') expect(verdict.code).toBe(PAID_WORKER_CONSENT_UNAVAILABLE)
    expect(eventNames(events)).not.toContain('paid_worker_launched')
  })

  test('#given a non-interactive flag #when the real ask sink is present #then it still fails closed', async () => {
    let called = false
    const provider = createOpenCodePermissionConsentProvider(async () => {
      called = true
    }, { nonInteractive: true })
    expect(await provider.request(requestFixture())).toBe('unavailable')
    expect(called).toBe(false)
  })

  test('#given a free model #when the gate runs #then free failover continues automatically with no prompt', async () => {
    let calls = 0
    const spyProvider = {
      async request(): Promise<'approved'> {
        calls += 1
        return 'approved'
      },
    }
    const verdict = await enforcePaidWorkerLaunch(
      gateInput({ resolvedModelKey: FREE, consentProvider: spyProvider }),
    )
    expect(verdict.action).toBe('allow_free')
    expect(calls).toBe(0)
  })

  test('#given paid_workers.max_concurrent #when concurrency is read #then the configured limit is honored', () => {
    expect(maxConcurrentPaidWorkers({ paid_workers: { max_concurrent: 2 } })).toBe(2)
    // Legacy key falls back.
    expect(maxConcurrentPaidWorkers({ max_concurrent_paid_workers: 3 })).toBe(3)
    // Default stays 1.
    expect(maxConcurrentPaidWorkers(undefined)).toBe(1)
  })

  test('#given an unknown-cost model #when the gate runs #then it is treated as paid for this boundary', async () => {
    expect(classifyPaidStatus(UNKNOWN, PRICING)).toBe('unknown')
    expect(isPaidOrUnknown('unknown')).toBe(true)
    expect(isPaidOrUnknown('free')).toBe(false)

    let requested: PaidWorkerConsentRequest | undefined
    const capturingProvider = {
      async request(req: PaidWorkerConsentRequest): Promise<'approved'> {
        requested = req
        return 'approved'
      },
    }
    const verdict = await enforcePaidWorkerLaunch(
      gateInput({ resolvedModelKey: UNKNOWN, consentProvider: capturingProvider }),
    )
    expect(verdict.action).toBe('allow_paid')
    expect(requested?.billable).toBe(true)
    expect(requested?.model).toBe(UNKNOWN)
  })

  test('#given a paid launch request #when the operator prompt fires #then all binding fields are shown to the operator', async () => {
    let captured: Record<string, unknown> | undefined
    const provider = createOpenCodePermissionConsentProvider(async (input) => {
      captured = input.metadata
    })
    await provider.request(requestFixture())
    expect(captured?.agent).toBe('general')
    expect(captured?.model).toBe(PAID)
    expect(captured?.provider).toBe('opencode')
    expect(captured?.billable).toBe(true)
    expect(captured?.reason).toContain('exhausted')
  })
})

function requestFixture(): PaidWorkerConsentRequest {
  return {
    rootSessionID: ROOT,
    childAgentType: 'general',
    capabilityTier: 'strong',
    model: PAID,
    provider: 'opencode',
    billable: true,
    reason: 'free worker pool exhausted',
    freeCandidatesExhausted: true,
    task: TASK,
    taskID: TASK,
  }
}
