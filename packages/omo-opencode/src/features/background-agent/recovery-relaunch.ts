import type { ModelRoutingConfig } from "../../config/schema"
import type { PricingCatalog } from "../../hooks/resource-governor/pricing"
import { parseModelString } from "../../shared/model-string-parser"
import type { GovernanceAuditWriter } from "../../shared/governance-audit"
import type {
  RedispatchAction,
  RelaunchOutcome,
  ReplayableAssignment,
} from "../delegation-first"
import {
  authorizeRecoveryRelaunch,
  filterFreeRecoveryFallbackChain,
} from "../delegation-first/recovery-relaunch-authorization"
import type { LaunchInput } from "./types"

export type RecoveryRelaunchLauncher = {
  launch(input: LaunchInput): Promise<{ id: string; sessionId?: string }>
}

export type CreateRecoveryRelaunchHandlerInput = {
  backgroundManager: RecoveryRelaunchLauncher
  pricing: () => PricingCatalog
  modelRouting?: ModelRoutingConfig
  audit?: GovernanceAuditWriter
  onSessionCreated?: (assignmentID: string, sessionID: string) => void
}

export type RecoveryRelaunchHandler = (
  assignment: ReplayableAssignment,
  action: RedispatchAction,
  replacementPrompt: string,
) => RelaunchOutcome | Promise<RelaunchOutcome>

export function createRecoveryRelaunchHandler(
  input: CreateRecoveryRelaunchHandlerInput,
): RecoveryRelaunchHandler {
  return (assignment, action, replacementPrompt) => {
    const pricing = input.pricing()
    const model = action.worker.model_id
    const authorization = authorizeRecoveryRelaunch({
      model,
      verifiedFree: action.worker.free === true,
      pricing,
      modelRouting: input.modelRouting,
      rootSessionID: assignment.root_session_id,
      requestingSessionID: assignment.parent_session_id,
    })

    if (!authorization.allowed) {
      input.audit?.write(assignment.parent_session_id, {
        subsystem: "delegation",
        event: "recovery_relaunch_denied",
        code: authorization.code,
        model,
        assignment_id: assignment.assignment_id,
        root_session_id: assignment.root_session_id,
        requesting_session_id: assignment.parent_session_id,
        reason: authorization.message,
      })
      return { kind: "blocked", reason: authorization.message }
    }

    const verifiedFreeModels = new Set(
      assignment.workers.filter((worker) => worker.free).map((worker) => worker.model_id),
    )
    const configuredFallbackCount = assignment.fallback_chain?.length ?? 0
    const fallbackChain = filterFreeRecoveryFallbackChain(assignment.fallback_chain, {
      pricing,
      verifiedFreeModels,
    })
    const keptFallbackCount = fallbackChain?.length ?? 0

    input.audit?.write(assignment.parent_session_id, {
      subsystem: "delegation",
      event: "recovery_relaunch_authorized",
      kind: authorization.kind,
      model,
      assignment_id: assignment.assignment_id,
      root_session_id: assignment.root_session_id,
      requesting_session_id: assignment.parent_session_id,
      fallback_chain_configured: configuredFallbackCount,
      fallback_chain_kept: keptFallbackCount,
      fallback_chain_dropped: configuredFallbackCount - keptFallbackCount,
    })

    const parsed = parseModelString(model)
    const replacementModel =
      parsed && parsed.modelID
        ? {
            providerID: parsed.providerID,
            modelID: parsed.modelID,
            ...(parsed.variant ? { variant: parsed.variant } : {}),
          }
        : undefined

    const launchInput: LaunchInput = {
      description: assignment.description ?? `auto-retry: ${assignment.agent}`,
      prompt: replacementPrompt,
      agent: assignment.agent,
      parentSessionId: assignment.parent_session_id,
      parentMessageId: assignment.parent_message_id,
      parentModel: assignment.parent_model,
      parentAgent: assignment.parent_agent,
      parentTools: assignment.parent_tools,
      model: replacementModel,
      verifiedFreeModel: authorization.kind === "free",
      fallbackChain,
      skills: assignment.skills,
      skillContent: assignment.skill_content,
      category: assignment.category,
      sessionPermission: assignment.session_permission,
      cwd: assignment.cwd,
      isUnstableAgent: assignment.is_unstable_agent,
      onSessionCreated: (sessionID) => {
        input.onSessionCreated?.(assignment.assignment_id, sessionID)
      },
    }

    return input.backgroundManager.launch(launchInput).then(
      (task) => ({ kind: "launched", taskID: task.id, sessionID: task.sessionId }),
      (error) => ({
        kind: "blocked",
        reason: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
