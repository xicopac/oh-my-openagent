import type { OpencodeClient } from "./types"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import { QUESTION_DENIED_SESSION_PERMISSION } from "../../shared/question-denied-session-permission"
import { assertAuthorizedChildLaunch, resolvedModelKey, type ChildLaunchBackstop } from "../../hooks/resource-governor"

export async function createSyncSession(
  client: OpencodeClient,
  input: {
    parentSessionID: string
    agentToUse: string
    description: string
    defaultDirectory: string
    categoryModel?: DelegatedModelConfig
  },
  backstop?: ChildLaunchBackstop
): Promise<{ ok: true; sessionID: string; parentDirectory: string } | { ok: false; error: string }> {
  const parentSession = await client.session.get({ path: { id: input.parentSessionID } }).catch(() => null)
  const parentDirectory = parentSession?.data?.directory ?? input.defaultDirectory

  assertAuthorizedChildLaunch(backstop, {
    sessionID: input.parentSessionID,
    workerIdentity: input.agentToUse,
    resolvedModelID: resolvedModelKey(input.categoryModel?.providerID, input.categoryModel?.modelID),
  })

  const createResult = await client.session.create({
    body: {
      parentID: input.parentSessionID,
      title: `${input.description} (@${input.agentToUse} subagent)`,
      permission: QUESTION_DENIED_SESSION_PERMISSION,
      ...(input.categoryModel
        ? {
            model: {
              id: input.categoryModel.modelID,
              providerID: input.categoryModel.providerID,
              ...(input.categoryModel.variant ? { variant: input.categoryModel.variant } : {}),
            },
          }
        : {}),
    } as Record<string, unknown>,
    query: {
      directory: parentDirectory,
    },
  })

  if (createResult.error !== undefined) {
    return { ok: false, error: `Failed to create session: ${createResult.error}` }
  }
  if (createResult.data === undefined) {
    return { ok: false, error: "Failed to create session: missing session data" }
  }

  return { ok: true, sessionID: createResult.data.id, parentDirectory }
}
