import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { _resetForTesting } from "../claude-code-session-state"
import { createGovernanceAuditWriter } from "../../shared/governance-audit"
import { createChatMessageHandler } from "../../plugin/chat-message"
import type { DelegationFirstRuntime } from "./runtime"
import { createDelegationFirstRuntime } from "./runtime"
import { handleUserMessageHumanAuthorization } from "./handle-user-message-authorization"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import type { OhMyOpenCodeConfig } from "../../config"

function makeRuntime(): { rt: DelegationFirstRuntime; root: string; availabilityDir: string } {
  const root = mkdtempSync(join(tmpdir(), "handoff-wire-"))
  const availabilityDir = mkdtempSync(join(tmpdir(), "handoff-wire-avail-"))
  const audit = createGovernanceAuditWriter({ root })
  const rt = createDelegationFirstRuntime(audit, {
    modelAvailabilityFilePath: join(availabilityDir, "model-availability.json"),
  })
  return { rt, root, availabilityDir }
}

function cleanup(r: { rt: DelegationFirstRuntime; root: string; availabilityDir: string }): void {
  r.rt.dispose()
  rmSync(r.root, { recursive: true, force: true })
  rmSync(r.availabilityDir, { recursive: true, force: true })
}

afterEach(() => {
  _resetForTesting()
})

describe("handleUserMessageHumanAuthorization - direct helper", () => {
  test("given user-role message with load and continue, after handler runtime contains matching path-prefix grant", () => {
    // given master session with no grants
    const r = makeRuntime()
    try {
      const sessionID = "ses-master-handoff"
      // when handling a user message containing explicit authorization
      handleUserMessageHumanAuthorization(r.rt, sessionID, {
        role: "user",
        content: "load and continue /tmp/x/handoff.md",
      })
      // then
      const grants = r.rt.humanAuthorizations(sessionID)
      expect(grants.length).toBeGreaterThan(0)
      expect(grants.some((g) => g.scope.includes("/tmp/x/handoff.md") || g.scope.includes("handoff"))).toBe(true)
      expect(grants.some((g) => g.scopeKind === "path-prefix")).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("given user-role message with fix the watchdog yourself, after handler runtime contains watchdog task-label grant", () => {
    // given
    const r = makeRuntime()
    try {
      const sessionID = "ses-master-watchdog"
      // when
      handleUserMessageHumanAuthorization(r.rt, sessionID, {
        role: "user",
        content: "fix the watchdog yourself",
      })
      // then
      const grants = r.rt.humanAuthorizations(sessionID)
      expect(grants.some((g) => g.scope === "watchdog/control-plane" && g.scopeKind === "task-label")).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("given assistant-role message with explicit phrase, no grant is registered (role gate)", () => {
    // given
    const r = makeRuntime()
    try {
      const sessionID = "ses-assistant"
      // when assistant message contains same phrasing
      handleUserMessageHumanAuthorization(r.rt, sessionID, {
        role: "assistant",
        content: "fix the watchdog yourself and load and continue /tmp/x/handoff.md",
      })
      // then
      expect(r.rt.humanAuthorizations(sessionID)).toHaveLength(0)
    } finally {
      cleanup(r)
    }
  })

  test("given child/subagent session even with user-role message, no grant is registered (master-only)", () => {
    // given a child session registered via attachChildSession
    const r = makeRuntime()
    try {
      const parent = "ses-parent"
      const child = "ses-child-subagent"
      r.rt.attachChildSession(parent, child)
      expect(r.rt.isChildSession(child)).toBe(true)
      // when handling user-role explicit message on the child session
      handleUserMessageHumanAuthorization(r.rt, child, {
        role: "user",
        content: "load and continue /tmp/x/handoff.md",
      })
      // then child gets no grant
      expect(r.rt.humanAuthorizations(child)).toHaveLength(0)
      // parent also gets no grant (isolation)
      expect(r.rt.humanAuthorizations(parent)).toHaveLength(0)
    } finally {
      cleanup(r)
    }
  })

  test("given ambiguous/plain user message without explicit phrase, no grant is registered (conservative)", () => {
    // given
    const r = makeRuntime()
    try {
      const sessionID = "ses-ambiguous"
      // when plain message
      handleUserMessageHumanAuthorization(r.rt, sessionID, {
        role: "user",
        content: "Please read /tmp/file.md and fix things",
      })
      // then
      expect(r.rt.humanAuthorizations(sessionID)).toHaveLength(0)
      // also tool role never grants
      handleUserMessageHumanAuthorization(r.rt, sessionID, {
        role: "tool",
        content: "I authorize read /tmp/file.md",
      })
      expect(r.rt.humanAuthorizations(sessionID)).toHaveLength(0)
    } finally {
      cleanup(r)
    }
  })

  test("idempotent/cheap: empty content or single space produces no grants", () => {
    // given
    const r = makeRuntime()
    try {
      const sessionID = "ses-empty"
      handleUserMessageHumanAuthorization(r.rt, sessionID, { role: "user", content: "   " })
      handleUserMessageHumanAuthorization(r.rt, sessionID, { role: "user", content: "" })
      expect(r.rt.humanAuthorizations(sessionID)).toHaveLength(0)
    } finally {
      cleanup(r)
    }
  })
})

describe("handleUserMessageHumanAuthorization - wired via chat.message handler", () => {
  test("given chat.message with user text containing explicit authorization, after handler runtime contains grant (master session)", async () => {
    // given a real chat.message handler wired with delegationFirstRuntime (master session)
    const r = makeRuntime()
    try {
      const sessionID = "ses-chat-master"
      const handler = createChatMessageHandler({
        ctx: unsafeTestValue({ directory: "/tmp", client: { tui: { showToast: async () => {} } } }),
        pluginConfig: unsafeTestValue<OhMyOpenCodeConfig>({}),
        firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
        hooks: unsafeTestValue({}),
        delegationFirstRuntime: r.rt,
      })
      // when the actual user's message arrives containing an explicit authorization
      await handler(
        { sessionID, agent: "sisyphus" },
        { message: {}, parts: [{ type: "text", text: "fix the watchdog yourself" }] },
      )
      // then the session received the derived grant
      const grants = r.rt.humanAuthorizations(sessionID)
      expect(grants.some((g) => g.scope === "watchdog/control-plane")).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("given chat.message with load and continue handoff path, after handler runtime contains path-prefix grant", async () => {
    // given
    const r = makeRuntime()
    try {
      const sessionID = "ses-chat-handoff"
      const handler = createChatMessageHandler({
        ctx: unsafeTestValue({ directory: "/tmp", client: { tui: { showToast: async () => {} } } }),
        pluginConfig: unsafeTestValue<OhMyOpenCodeConfig>({}),
        firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
        hooks: unsafeTestValue({}),
        delegationFirstRuntime: r.rt,
      })
      // when
      await handler(
        { sessionID },
        { message: {}, parts: [{ type: "text", text: "load and continue /tmp/x/handoff.md" }] },
      )
      // then
      const grants = r.rt.humanAuthorizations(sessionID)
      expect(grants.length).toBeGreaterThan(0)
      expect(grants.some((g) => g.scopeKind === "path-prefix")).toBe(true)
    } finally {
      cleanup(r)
    }
  })

  test("given chat.message on a child session, no grant is registered even with explicit phrase", async () => {
    // given child session attached
    const r = makeRuntime()
    try {
      const parent = "ses-chat-parent"
      const child = "ses-chat-child"
      r.rt.attachChildSession(parent, child)
      const handler = createChatMessageHandler({
        ctx: unsafeTestValue({ directory: "/tmp", client: { tui: { showToast: async () => {} } } }),
        pluginConfig: unsafeTestValue<OhMyOpenCodeConfig>({}),
        firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
        hooks: unsafeTestValue({}),
        delegationFirstRuntime: r.rt,
      })
      // when explicit message arrives on child
      await handler(
        { sessionID: child },
        { message: {}, parts: [{ type: "text", text: "fix the watchdog yourself" }] },
      )
      // then no grant
      expect(r.rt.humanAuthorizations(child)).toHaveLength(0)
      expect(r.rt.humanAuthorizations(parent)).toHaveLength(0)
    } finally {
      cleanup(r)
    }
  })

  test("given chat.message with ambiguous/plain user text, no grant is registered (conservative)", async () => {
    // given
    const r = makeRuntime()
    try {
      const sessionID = "ses-chat-ambiguous"
      const handler = createChatMessageHandler({
        ctx: unsafeTestValue({ directory: "/tmp", client: { tui: { showToast: async () => {} } } }),
        pluginConfig: unsafeTestValue<OhMyOpenCodeConfig>({}),
        firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
        hooks: unsafeTestValue({}),
        delegationFirstRuntime: r.rt,
      })
      // when ambiguous
      await handler(
        { sessionID },
        { message: {}, parts: [{ type: "text", text: "Please read /tmp/file.md and fix things" }] },
      )
      // then
      expect(r.rt.humanAuthorizations(sessionID)).toHaveLength(0)
    } finally {
      cleanup(r)
    }
  })

  test("given synthetic/internal-only chat.message, no grant is registered even with explicit phrase", async () => {
    // given handler wired with runtime
    const r = makeRuntime()
    try {
      const sessionID = "ses-chat-synthetic"
      const handler = createChatMessageHandler({
        ctx: unsafeTestValue({ directory: "/tmp", client: { tui: { showToast: async () => {} } } }),
        pluginConfig: unsafeTestValue<OhMyOpenCodeConfig>({}),
        firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
        hooks: unsafeTestValue({}),
        delegationFirstRuntime: r.rt,
      })
      // when synthetic/injected message containing the phrase
      await handler(
        { sessionID },
        {
          message: {},
          parts: [{ type: "text", text: "fix the watchdog yourself <!-- OMO_INTERNAL_INITIATOR -->", synthetic: true }],
        },
      )
      // then synthetic gate skips before our wiring, so no grant
      expect(r.rt.humanAuthorizations(sessionID)).toHaveLength(0)
    } finally {
      cleanup(r)
    }
  })
})
