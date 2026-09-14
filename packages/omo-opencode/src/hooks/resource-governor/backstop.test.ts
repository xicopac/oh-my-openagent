import { describe, test, expect } from "bun:test"
import { ResourceGovernorConfigSchema } from "../../config/schema/resource-governor"
import {
  ChildLaunchGuard,
  ResourceGovernorBackstopError,
  assertAuthorizedChildLaunch,
  authorizeChildDispatch,
  createResourceGovernorRuntime,
  resolvedModelKey,
  type ChildLaunchBackstop,
} from "./index"

function guardWithOneAuthorization(): { guard: ChildLaunchGuard; backstop: ChildLaunchBackstop } {
  const guard = new ChildLaunchGuard()
  const token = guard.issue({
    sessionID: "parent-session",
    workerIdentity: "explore",
    resolvedModelID: "openai/gpt-5.6-sol",
    escrowID: "escrow-1",
  }).token
  return { guard, backstop: { guard, token } }
}

describe("resolvedModelKey", () => {
  test("joins provider and model with a slash", () => {
    expect(resolvedModelKey("openai", "gpt-5.6-sol")).toBe("openai/gpt-5.6-sol")
  })

  test("returns the bare model id when there is no provider", () => {
    expect(resolvedModelKey(undefined, "gpt-5.6-sol")).toBe("gpt-5.6-sol")
  })

  test("returns the empty string when there is no model id", () => {
    expect(resolvedModelKey("openai", undefined)).toBe("")
    expect(resolvedModelKey(undefined, null)).toBe("")
  })
})

describe("ChildLaunchGuard", () => {
  test("issues and consumes an authorization without error", () => {
    const { backstop } = guardWithOneAuthorization()
    const consumed = assertAuthorizedChildLaunch(backstop, {
      sessionID: "parent-session",
      workerIdentity: "explore",
      resolvedModelID: "openai/gpt-5.6-sol",
    })
    expect(consumed).toBeUndefined()
  })

  test("throws when a launch reaches execution with no authorization token", () => {
    const { guard } = guardWithOneAuthorization()
    expect(() =>
      guard.assertAndConsume(undefined, {
        sessionID: "parent-session",
        workerIdentity: "explore",
        resolvedModelID: "openai/gpt-5.6-sol",
      }),
    ).toThrow(ResourceGovernorBackstopError)
  })

  test("throws when the token is unknown or already invalid", () => {
    const { guard } = guardWithOneAuthorization()
    expect(() =>
      guard.assertAndConsume("not-a-real-token", {
        sessionID: "parent-session",
        workerIdentity: "explore",
        resolvedModelID: "openai/gpt-5.6-sol",
      }),
    ).toThrow(ResourceGovernorBackstopError)
  })

  test("throws on parent-session mismatch", () => {
    const { backstop } = guardWithOneAuthorization()
    expect(() =>
      assertAuthorizedChildLaunch(backstop, {
        sessionID: "other-session",
        workerIdentity: "explore",
        resolvedModelID: "openai/gpt-5.6-sol",
      }),
    ).toThrow(/session mismatch/)
  })

  test("throws on worker-identity mismatch", () => {
    const { backstop } = guardWithOneAuthorization()
    expect(() =>
      assertAuthorizedChildLaunch(backstop, {
        sessionID: "parent-session",
        workerIdentity: "librarian",
        resolvedModelID: "openai/gpt-5.6-sol",
      }),
    ).toThrow(/worker mismatch/)
  })

  test("throws on resolved-model mismatch", () => {
    const { backstop } = guardWithOneAuthorization()
    expect(() =>
      assertAuthorizedChildLaunch(backstop, {
        sessionID: "parent-session",
        workerIdentity: "explore",
        resolvedModelID: "anthropic/claude-fable-5-1",
      }),
    ).toThrow(/model mismatch/)
  })

  test("consumes a one-shot proof exactly once", () => {
    const { backstop } = guardWithOneAuthorization()
    const expected = {
      sessionID: "parent-session",
      workerIdentity: "explore",
      resolvedModelID: "openai/gpt-5.6-sol",
    }
    expect(() => assertAuthorizedChildLaunch(backstop, expected)).not.toThrow()
    expect(() => assertAuthorizedChildLaunch(backstop, expected)).toThrow(/already consumed/)
  })

  test("tracks pending and consumed counts", () => {
    const guard = new ChildLaunchGuard()
    expect(guard.pendingCount()).toBe(0)
    expect(guard.consumedCount()).toBe(0)
    const token = guard.issue({
      sessionID: "s",
      workerIdentity: "w",
      resolvedModelID: "m",
      escrowID: "",
    }).token
    expect(guard.pendingCount()).toBe(1)
    guard.assertAndConsume(token, { sessionID: "s", workerIdentity: "w", resolvedModelID: "m" })
    expect(guard.pendingCount()).toBe(0)
    expect(guard.consumedCount()).toBe(1)
  })

  test("redeems nested authorizations independently", () => {
    const guard = new ChildLaunchGuard()
    const first = guard.issue({ sessionID: "s", workerIdentity: "explore", resolvedModelID: "m", escrowID: "" }).token
    const second = guard.issue({ sessionID: "s", workerIdentity: "librarian", resolvedModelID: "n", escrowID: "" }).token

    expect(() =>
      guard.assertAndConsume(first, { sessionID: "s", workerIdentity: "explore", resolvedModelID: "m" }),
    ).not.toThrow()
    expect(() =>
      guard.assertAndConsume(second, { sessionID: "s", workerIdentity: "librarian", resolvedModelID: "n" }),
    ).not.toThrow()
    expect(guard.consumedCount()).toBe(2)
    expect(guard.pendingCount()).toBe(0)
  })
})

describe("assertAuthorizedChildLaunch", () => {
  test("passes through when the backstop is undefined (governor disabled)", () => {
    expect(() =>
      assertAuthorizedChildLaunch(undefined, {
        sessionID: "s",
        workerIdentity: "w",
        resolvedModelID: "m",
      }),
    ).not.toThrow()
  })
})

describe("authorizeChildDispatch mint and redeem", () => {
  test("mints a redeemable authorization for the un-priced ALLOW path", () => {
    const runtime = createResourceGovernorRuntime({ config: ResourceGovernorConfigSchema.parse({}), pricing: {} })
    const decision = authorizeChildDispatch(runtime, {
      sessionID: "parent-session",
      role: "explore",
      workerIdentity: "explore",
      subtask: "trace the login path",
      resolvedModelID: null,
      requestedTier: null,
      expectedTokens: 600_000,
      rootModelID: null,
    })

    expect(decision.verdict).toBe("ALLOW")
    expect(decision.authorization).toBeDefined()

    const authorization = decision.authorization!
    expect(authorization.token).toBeTruthy()

    expect(() =>
      assertAuthorizedChildLaunch(
        { guard: runtime.launchGuard, token: authorization.token },
        { sessionID: "parent-session", workerIdentity: "explore", resolvedModelID: "" },
      ),
    ).not.toThrow()
  })

  test("a null-model authorization cannot be redeemed against a resolved model", () => {
    const runtime = createResourceGovernorRuntime({ config: ResourceGovernorConfigSchema.parse({}), pricing: {} })
    const decision = authorizeChildDispatch(runtime, {
      sessionID: "parent-session",
      role: "explore",
      workerIdentity: "explore",
      subtask: "trace",
      resolvedModelID: null,
      requestedTier: null,
      expectedTokens: 600_000,
      rootModelID: null,
    })
    expect(decision.verdict).toBe("ALLOW")

    expect(() =>
      assertAuthorizedChildLaunch(
        { guard: runtime.launchGuard, token: decision.authorization!.token },
        { sessionID: "parent-session", workerIdentity: "explore", resolvedModelID: "openai/gpt-5.6-sol" },
      ),
    ).toThrow(/model mismatch/)
  })
})
