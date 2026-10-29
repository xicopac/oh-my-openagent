import { describe, expect, test } from "bun:test"

import type { Managers } from "../create-managers"
import type { ChildActivitySignal } from "../features/worker-supervisor"
import { createEventHandler } from "./event"

type RecordedActivity = { sessionID: string; signal: ChildActivitySignal | undefined }

function cast<T>(value: unknown): T {
  return value as T
}

function createHarness(): {
  handler: ReturnType<typeof createEventHandler>
  activity: RecordedActivity[]
} {
  const activity: RecordedActivity[] = []
  const handler = createEventHandler({
    ctx: cast({}),
    pluginConfig: cast({}),
    firstMessageVariantGate: {
      markSessionCreated: () => {},
      clear: () => {},
    },
    managers: cast<Managers>({
      delegationFirstRuntime: {
        watchdogActivity: (sessionID: string, signal?: ChildActivitySignal) => {
          activity.push({ sessionID, signal })
        },
      },
    }),
    hooks: cast({}),
  })
  return { handler, activity }
}

async function emit(
  handler: ReturnType<typeof createEventHandler>,
  type: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await handler({ event: { type, properties } })
}

describe("event watchdog activity classification", () => {
  test("a user message is liveness only, not a provider response", async () => {
    // given
    const { handler, activity } = createHarness()
    // when
    await emit(handler, "message.updated", {
      sessionID: "ses_child",
      info: { id: "msg_user", sessionID: "ses_child", role: "user" },
    })
    // then
    expect(activity).toEqual([{ sessionID: "ses_child", signal: "alive" }])
  })

  test("an empty assistant message is startup state, not a provider response", async () => {
    // given
    const { handler, activity } = createHarness()
    // when
    await emit(handler, "message.updated", {
      sessionID: "ses_child",
      info: { id: "msg_assistant", sessionID: "ses_child", role: "assistant" },
    })
    // then
    expect(activity).toEqual([{ sessionID: "ses_child", signal: "alive" }])
  })

  test("an assistant message with a completion marker proves the provider responded", async () => {
    // given
    const { handler, activity } = createHarness()
    // when
    await emit(handler, "message.updated", {
      sessionID: "ses_child",
      info: { id: "msg_assistant", sessionID: "ses_child", role: "assistant", finish: "stop" },
    })
    // then
    expect(activity).toEqual([{ sessionID: "ses_child", signal: "provider_response" }])
  })

  test("a part before any assistant message is startup state, not provider output", async () => {
    // given
    const { handler, activity } = createHarness()
    // when
    await emit(handler, "message.part.updated", {
      part: { id: "part_startup", messageID: "msg_user", sessionID: "ses_child", type: "text", text: "startup" },
    })
    // then
    expect(activity).toEqual([{ sessionID: "ses_child", signal: "alive" }])
  })

  test("an assistant part after the assistant message is meaningful progress on the child session", async () => {
    // given
    const { handler, activity } = createHarness()
    // when
    await emit(handler, "message.updated", {
      sessionID: "ses_child",
      info: { id: "msg_assistant", sessionID: "ses_child", role: "assistant" },
    })
    await emit(handler, "message.part.updated", {
      part: { id: "part_tool", messageID: "msg_assistant", sessionID: "ses_child", type: "tool", tool: "read" },
    })
    // then
    expect(activity).toEqual([
      { sessionID: "ses_child", signal: "alive" },
      { sessionID: "ses_child", signal: "progress" },
    ])
  })

  test("a session.next stream event routes progress to the emitting child session", async () => {
    // given
    const { handler, activity } = createHarness()
    // when
    await emit(handler, "session.next.text.delta", {
      sessionID: "ses_child",
      delta: "working",
    })
    // then
    expect(activity).toEqual([{ sessionID: "ses_child", signal: "progress" }])
  })
})
