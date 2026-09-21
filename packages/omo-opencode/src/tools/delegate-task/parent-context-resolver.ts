import type { ToolContextWithMetadata } from "./types"
import type { OpencodeClient } from "./types"
import type { ParentContext } from "./executor-types"
import { resolveMessageContext } from "../../features/hook-message-injector"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { log } from "../../shared/logger"
import { getMessageDir } from "../../shared/opencode-message-dir"
import { parseModelString } from "../../shared/model-string-parser"

export async function resolveParentContext(
  ctx: ToolContextWithMetadata,
  client: OpencodeClient
): Promise<ParentContext> {
  const messageDir = getMessageDir(ctx.sessionID)
  const { prevMessage, firstMessageAgent } = await resolveMessageContext(
    ctx.sessionID,
    client,
    messageDir
  )

  const sessionAgent = getSessionAgent(ctx.sessionID)
  const parentAgent = ctx.agent ?? sessionAgent ?? firstMessageAgent ?? prevMessage?.agent

  log("[task] parentAgent resolution", {
    sessionID: ctx.sessionID,
    messageDir,
    ctxAgent: ctx.agent,
    sessionAgent,
    firstMessageAgent,
    prevMessageAgent: prevMessage?.agent,
    resolvedParentAgent: parentAgent,
  })

  const parentModel = prevMessage?.model?.providerID && prevMessage?.model?.modelID
    ? {
        providerID: prevMessage.model.providerID,
        modelID: prevMessage.model.modelID,
        ...(prevMessage.model.variant ? { variant: prevMessage.model.variant } : {}),
      }
    : undefined

  // The parent session's model is authoritative for the terminal `main_equiv`
  // escalation rung. When the nearest message carries no model, fall back to
  // the session default model from the live config so MAIN remains reachable
  // (otherwise a worker may resolve to a catalog-listed model the gateway
  // actually rejects with "Model is disabled").
  let model = parentModel
  if (!model) {
    try {
      const openCodeConfig = await client.config.get()
      const defaultModel = (openCodeConfig as { data?: { model?: string } })?.data?.model
      const parsed = defaultModel ? parseModelString(defaultModel) : undefined
      if (parsed?.providerID && parsed.modelID) {
        model = {
          providerID: parsed.providerID,
          modelID: parsed.modelID,
          ...(parsed.variant ? { variant: parsed.variant } : {}),
        }
      }
    } catch (error) {
      log("[task] parent model fallback failed", { sessionID: ctx.sessionID, error: String(error) })
    }
  }

  return {
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
    agent: parentAgent,
    model,
  }
}
