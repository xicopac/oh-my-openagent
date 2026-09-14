/**
 * Fail-closed dispatch backstop at the shared child-session execution
 * boundary. The per-path authorization (`authorizeChildDispatch`) evaluates
 * the full Resource Governor policy and, on ALLOW, mints a one-shot
 * `ChildLaunchAuthorization` proof. The actual child execution (session
 * creation) then passes that proof through `assertAuthorizedChildLaunch`,
 * which consumes it and FAILS CLOSED when it is missing, already consumed, or
 * does not match the exact launch it was minted for.
 *
 * This layer deliberately reintroduces NO policy: it only checks that the
 * launch reaching execution is one that the governor already authorized, and
 * that nothing about the execution (model/provider, worker identity, parent
 * session) drifted from what was authorized. There is no bypass flag; the
 * only way past this assertion is a valid, unconsumed proof minted by the
 * governor itself.
 */

/** One-shot proof that a specific child launch was authorized. */
export type ChildLaunchAuthorization = {
  readonly token: string
  /** Parent/root session that authorized this child. */
  readonly sessionID: string
  /** Worker/agent identity the authorization was issued for. */
  readonly workerIdentity: string
  /** Exact resolved model (provider/model) the authorization was issued for. */
  readonly resolvedModelID: string
  /** Escrow id backing this authorization (may be empty when un-priced). */
  readonly escrowID: string
  readonly issuedAt: number
}

/** The launch identity that actually reaches execution. */
export type ExpectedChildLaunchIdentity = {
  readonly sessionID: string
  readonly workerIdentity: string
  readonly resolvedModelID: string
}

/**
 * Canonical resolved-model key, shared by every mint site and every redeem
 * site so the authorization binding and the actual execution always derive the
 * exact same string. Empty when no model is resolved.
 */
export function resolvedModelKey(providerID: string | undefined | null, modelID: string | undefined | null): string {
  if (!modelID) return ""
  return providerID ? `${providerID}/${modelID}` : modelID
}

/** Thrown when child execution reaches the boundary without valid authorization. */
export class ResourceGovernorBackstopError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResourceGovernorBackstopError"
  }
}

/**
 * In-memory registry of issued-but-unconsumed authorizations plus a consumed
 * tombstone set so a one-shot proof cannot be redeemed twice. Proofs are
 * unforgeable in-process: a token is a random UUID that only `issue` records.
 */
export class ChildLaunchGuard {
  private readonly pending = new Map<string, ChildLaunchAuthorization>()
  private readonly consumed = new Set<string>()

  issue(input: Omit<ChildLaunchAuthorization, "token" | "issuedAt">): ChildLaunchAuthorization {
    const authorization: ChildLaunchAuthorization = {
      ...input,
      token: crypto.randomUUID(),
      issuedAt: Date.now(),
    }
    this.pending.set(authorization.token, authorization)
    return authorization
  }

  /**
   * Redeem and consume an authorization proof against the actual launch
   * identity. Throws `ResourceGovernorBackstopError` on any failure so the
   * caller fails closed rather than proceeding to execution.
   */
  assertAndConsume(token: string | undefined, expected: ExpectedChildLaunchIdentity): ChildLaunchAuthorization {
    if (!token) {
      throw new ResourceGovernorBackstopError(
        "[resource-governor] child launch reached execution without authorization",
      )
    }
    if (this.consumed.has(token)) {
      throw new ResourceGovernorBackstopError(
        "[resource-governor] child launch authorization was already consumed",
      )
    }
    const authorization = this.pending.get(token)
    if (!authorization) {
      throw new ResourceGovernorBackstopError(
        "[resource-governor] child launch authorization is unknown or invalid",
      )
    }
    if (authorization.sessionID !== expected.sessionID) {
      throw new ResourceGovernorBackstopError(
        `[resource-governor] child launch authorization session mismatch (authorized "${authorization.sessionID}", executing "${expected.sessionID}")`,
      )
    }
    if (authorization.workerIdentity !== expected.workerIdentity) {
      throw new ResourceGovernorBackstopError(
        `[resource-governor] child launch authorization worker mismatch (authorized "${authorization.workerIdentity}", executing "${expected.workerIdentity}")`,
      )
    }
    if (authorization.resolvedModelID !== expected.resolvedModelID) {
      throw new ResourceGovernorBackstopError(
        `[resource-governor] child launch authorization model mismatch (authorized "${authorization.resolvedModelID}", executing "${expected.resolvedModelID}")`,
      )
    }
    this.pending.delete(token)
    this.consumed.add(token)
    return authorization
  }

  pendingCount(): number {
    return this.pending.size
  }

  consumedCount(): number {
    return this.consumed.size
  }
}

/** A guard plus the proof to redeem, bundled for the shared boundary. */
export type ChildLaunchBackstop = {
  readonly guard: ChildLaunchGuard
  readonly token: string
}

/**
 * Shared low-level authorization assertion. When `backstop` is absent the
 * governor is disabled and child execution proceeds unchanged (matching the
 * existing `resource_governor.enabled: false` semantics). When present, the
 * proof must be valid or this fails closed.
 */
export function assertAuthorizedChildLaunch(
  backstop: ChildLaunchBackstop | undefined,
  expected: ExpectedChildLaunchIdentity,
): void {
  if (!backstop) return
  backstop.guard.assertAndConsume(backstop.token, expected)
}
