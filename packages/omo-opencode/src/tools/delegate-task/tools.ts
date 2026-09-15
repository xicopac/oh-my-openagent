import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { resolveModelTier } from "@oh-my-opencode/delegate-core"
import type { DelegatedModelConfig, ToolContextWithMetadata, DelegateTaskToolOptions, DelegateTaskArgs } from "./types"
import { log } from "../../shared/logger"
import { parseModelString } from "../../shared/model-string-parser"
import { getAvailableModelsForDelegateTask, getModelsWithPricingForDelegateTask } from "./available-models"
import { buildSystemContent } from "./prompt-builder"
import {
  resolveSkillContent,
  resolveParentContext,
  executeBackgroundContinuation,
  executeSyncContinuation,
  resolveCategoryExecution,
  resolveSubagentExecution,
  executeUnstableAgentTask,
  executeBackgroundTask,
  executeSyncTask,
} from "./executor"
import type { ParentContext } from "./executor-types"
import { prepareDelegateTaskArgs } from "./tool-argument-preparation"
import { createDelegateTaskPresentation } from "./tool-description"
import type { AvailableSkill } from "../../agents/dynamic-agent-prompt-builder"
import { mergeNativeSkillInfos, type NativeSkillEntry } from "../skill/native-skills"
import type { SkillInfo } from "../skill/types"
import { authorizeChildDispatch, blockMessage, resolvedModelKey, type ChildLaunchBackstop, type ResourceGovernorRuntime } from "../../hooks/resource-governor"
import { buildDelegationWorkerCandidates } from "../../features/delegation-first"
import { refineAssignment } from "../../features/delegation-ladder"
import { judgeSyncAdequacy } from "./sync-adequacy"

async function loadNativeSkillEntries(
  nativeSkills: DelegateTaskToolOptions["nativeSkills"] | undefined,
): Promise<NativeSkillEntry[]> {
  if (!nativeSkills) return []
  try {
    const list = await nativeSkills.all()
    return Array.isArray(list) ? list : []
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    log("[delegate-task] nativeSkills.all() failed; skipping native skills", { error: errorMessage })
    return []
  }
}

function buildPromptNativeSkillInfos(
  availableSkills: AvailableSkill[],
  nativeSkillEntries: NativeSkillEntry[],
  disabledSkills: ReadonlySet<string> | undefined,
): Array<{ name: string; description: string; location: string }> {
  if (nativeSkillEntries.length === 0) return []
  const availableSkillInfos: SkillInfo[] = availableSkills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    location: undefined,
    scope: skill.location === "plugin" ? "builtin" : skill.location,
  }))
  const initialCount = availableSkillInfos.length
  mergeNativeSkillInfos(availableSkillInfos, nativeSkillEntries, disabledSkills)
  return availableSkillInfos.slice(initialCount).map((skill) => ({
    name: skill.name,
    description: skill.description,
    location: skill.location ?? "",
  }))
}

export { resolveCategoryConfig } from "./categories"
export type { SyncSessionCreatedEvent, DelegateTaskToolOptions, BuildSystemContentInput } from "./types"
export { buildSystemContent, buildTaskPrompt } from "./prompt-builder"

const delegateTaskArgsSchema = {
  load_skills: tool.schema
    .array(tool.schema.string())
    .optional()
    .describe("Skill names to inject. Optional; defaults to [] when omitted. Pass an explicit array (e.g. [\"git-master\"]) for skill-specific tasks."),
  description: tool.schema.string().optional().describe("Short task description (3-5 words). Auto-generated from prompt if omitted."),
  prompt: tool.schema.string().describe("Full detailed prompt for the agent"),
  run_in_background: tool.schema
    .boolean()
    .optional()
    .describe("true is the standard spawn: returns a background task ID `bg_...` at once; the completion notification delivers the result, which background_output reads. false blocks this response until the child finishes; use it only for a short child whose result gates your very next call. Omitted counts as false."),
  category: tool.schema.string().optional().describe("REQUIRED if subagent_type not provided. Do NOT provide both category and subagent_type."),
  subagent_type: tool.schema.string().optional().describe("REQUIRED if category not provided. Do NOT provide both category and subagent_type."),
  task_id: tool.schema
    .string()
    .optional()
    .describe("Continuation session id (`ses_...`) from task metadata; not a background task id (`bg_...`)."),
  command: tool.schema.string().optional().describe("The command that triggered this task"),
  model_tier: tool.schema
    .string()
    .optional()
    .describe("Capability tier for the delegated model: \"fast\", \"balanced\", \"strong\", or \"master\". Independent of category/subagent_type. \"master\" uses the parent session's current model. Overrides the category/agent's static model when configured. Omit to keep existing model resolution."),
}

export function createDelegateTask(options: DelegateTaskToolOptions): ToolDefinition {
  const { availableCategories, availableSkills, categoryExamples, description } = createDelegateTaskPresentation(options)

  return tool({
    description,
    args: delegateTaskArgsSchema,
    async execute(args, toolContext) {
      const ctx = toolContext as ToolContextWithMetadata
      const delegateTaskArgs = await prepareDelegateTaskArgs(args, ctx)

      const runInBackground = delegateTaskArgs.run_in_background === true

      const { content: skillContent, contents: skillContents, error: skillError } = await resolveSkillContent(delegateTaskArgs.load_skills, {
        gitMasterConfig: options.gitMasterConfig,
        browserProvider: options.browserProvider,
        disabledSkills: options.disabledSkills,
        teamModeEnabled: options.teamModeEnabled,
        directory: options.directory,
        targetAgent: delegateTaskArgs.subagent_type,
        nativeSkills: options.nativeSkills,
        getLoadedSkills: options.getLoadedSkills,
      })
      if (skillError) {
        return skillError
      }
      const nativeSkillEntries = await loadNativeSkillEntries(options.nativeSkills)
      const nativeSkillInfos = buildPromptNativeSkillInfos(
        availableSkills,
        nativeSkillEntries,
        options.disabledSkills,
      )

      const continuationSystemContent = buildSystemContent({
        skillContent,
        skillContents,
        availableCategories,
        availableSkills,
        nativeSkillInfos,
      })

      const parentContext = await resolveParentContext(ctx, options.client)

      if (delegateTaskArgs.task_id) {
        if (runInBackground) {
          return executeBackgroundContinuation(delegateTaskArgs, ctx, options, parentContext, continuationSystemContent)
        }
        return executeSyncContinuation(delegateTaskArgs, ctx, options, parentContext, undefined, continuationSystemContent)
      }

      if (!delegateTaskArgs.category && !delegateTaskArgs.subagent_type) {
        return `Invalid arguments: Must provide either category or subagent_type.`
      }

      let systemDefaultModel: string | undefined
      try {
        const openCodeConfig = await options.client.config.get()
        systemDefaultModel = (openCodeConfig as { data?: { model?: string } })?.data?.model
      } catch (error) {
        if (!(error instanceof Error)) throw error
        systemDefaultModel = undefined
      }

      const inheritedModel = parentContext.model
        ? `${parentContext.model.providerID}/${parentContext.model.modelID}`
        : undefined

      const currentModelConfig = options.loadCurrentModelConfig?.()
      const modelOptions = currentModelConfig === undefined
        ? options
        : { ...options, userCategories: currentModelConfig.categories, agentOverrides: currentModelConfig.agents, modelRouting: currentModelConfig.model_routing }

      let agentToUse: string
      let categoryModel: DelegatedModelConfig | undefined
      let categoryPromptAppend: string | undefined
      let modelInfo: import("../../features/task-toast-manager/types").ModelFallbackInfo | undefined
      let actualModel: string | undefined
      let isUnstableAgent = false
      let fallbackChain: import("../../shared/model-requirements").FallbackEntry[] | undefined
      let maxPromptTokens: number | undefined

      const applyModelTier = async (): Promise<void> => {
        const tier = delegateTaskArgs.model_tier
        if (!tier) return
        const availableModels = await getAvailableModelsForDelegateTask(options.client)
        const resolved = resolveModelTier({
          tier,
          config: modelOptions.modelRouting ?? {},
          availableModels,
          parentModel: inheritedModel,
        })
        if (!resolved) {
          log("[delegate-task] model_tier requested but unresolved; keeping existing resolution", {
            tier,
            agent: agentToUse,
            description: delegateTaskArgs.description,
          })
          return
        }
        const parsed = parseModelString(resolved.model)
        if (!parsed) {
          log("[delegate-task] model_tier resolved to an invalid model id; keeping existing resolution", {
            tier,
            model: resolved.model,
          })
          return
        }
        categoryModel = parsed
        actualModel = resolved.model
        modelInfo = { model: resolved.model, type: "user-defined", source: "override" }
        log("[delegate-task] model_tier", {
          agent: agentToUse,
          requestedTier: tier,
          tier: resolved.tier,
          model: resolved.model,
          escalated: resolved.escalated,
          usedParentModel: resolved.usedParentModel,
          description: delegateTaskArgs.description,
        })
      }

      if (delegateTaskArgs.category) {
        const resolution = await resolveCategoryExecution(delegateTaskArgs, modelOptions, inheritedModel, systemDefaultModel)
        if (resolution.error) {
          return resolution.error
        }
        agentToUse = resolution.agentToUse
        categoryModel = resolution.categoryModel
        categoryPromptAppend = resolution.categoryPromptAppend
        modelInfo = resolution.modelInfo
        actualModel = resolution.actualModel
        isUnstableAgent = resolution.isUnstableAgent
        fallbackChain = resolution.fallbackChain
        maxPromptTokens = resolution.maxPromptTokens
        await applyModelTier()

        const isRunInBackgroundExplicitlyFalse = isExplicitSyncRun(delegateTaskArgs.run_in_background)

        log("[task] unstable agent detection", {
          category: delegateTaskArgs.category,
          actualModel,
          isUnstableAgent,
          run_in_background_value: delegateTaskArgs.run_in_background,
          run_in_background_type: typeof delegateTaskArgs.run_in_background,
          isRunInBackgroundExplicitlyFalse,
          willForceBackground: isUnstableAgent && isRunInBackgroundExplicitlyFalse,
        })

        if (isUnstableAgent && isRunInBackgroundExplicitlyFalse) {
          const systemContent = buildSystemContent({
            skillContent,
            skillContents,
            categoryPromptAppend,
            agentName: agentToUse,
            maxPromptTokens,
            model: categoryModel,
            availableCategories,
            availableSkills,
            nativeSkillInfos,
          })
          return executeUnstableAgentTask(delegateTaskArgs, ctx, options, parentContext, agentToUse, categoryModel, systemContent, actualModel)
        }
      } else {
        const resolution = await resolveSubagentExecution(delegateTaskArgs, modelOptions, parentContext.agent, categoryExamples)
        if (resolution.error) {
          return resolution.error
        }
        agentToUse = resolution.agentToUse
        categoryModel = resolution.categoryModel
        fallbackChain = resolution.fallbackChain
        await applyModelTier()
      }

      const systemContent = buildSystemContent({
        skillContent,
        skillContents,
        categoryPromptAppend,
        agentName: agentToUse,
        maxPromptTokens,
        model: categoryModel,
        availableCategories,
        availableSkills,
        nativeSkillInfos,
      })

      if (runInBackground) {
        return executeBackgroundTask(delegateTaskArgs, ctx, options, parentContext, agentToUse, categoryModel, systemContent, fallbackChain)
      }

      if (options.delegationFirstRuntime) {
        return runDelegationFirstSync({
          options,
          ctx,
          args: delegateTaskArgs,
          parentContext,
          agentToUse,
          categoryModel,
          systemContent,
          modelInfo,
          fallbackChain,
        })
      }

      const enforcement = enforceResourceGovernor(
        options,
        ctx,
        delegateTaskArgs,
        agentToUse,
        categoryModel,
        parentContext,
      )
      if (enforcement.message !== null) return enforcement.message

      try {
        return await executeSyncTask(delegateTaskArgs, ctx, options, parentContext, agentToUse, categoryModel, systemContent, modelInfo, fallbackChain, undefined, enforcement.backstop)
      } finally {
        if (enforcement.escrowID !== null) {
          options.resourceGovernorRuntime?.settleChild(ctx.sessionID, enforcement.escrowID, "completed")
        }
      }
    },
  })
}

function enforceResourceGovernor(
  options: DelegateTaskToolOptions,
  ctx: ToolContextWithMetadata,
  args: DelegateTaskArgs,
  agentToUse: string,
  categoryModel: DelegatedModelConfig | undefined,
  parentContext: ParentContext,
): { message: string | null; escrowID: string | null; backstop: ChildLaunchBackstop | undefined } {
  const runtime = options.resourceGovernorRuntime
  if (!runtime) return { message: null, escrowID: null, backstop: undefined }

  const resolvedModelID = categoryModel?.modelID
    ? resolvedModelKey(categoryModel.providerID, categoryModel.modelID)
    : null

  const rootModelID = parentContext.model
    ? `${parentContext.model.providerID}/${parentContext.model.modelID}`
    : null

  const decision = authorizeChildDispatch(runtime, {
    sessionID: ctx.sessionID,
    role: args.category ?? args.subagent_type ?? agentToUse,
    workerIdentity: agentToUse,
    subtask: args.prompt,
    resolvedModelID,
    requestedTier: args.model_tier ?? null,
    expectedTokens: options.resourceGovernorDefaultChildTokens ?? 600_000,
    rootModelID,
  })

  return {
    message: blockMessage(decision),
    escrowID: decision.verdict === "ALLOW" ? decision.escrowID : null,
    backstop: decision.verdict === "ALLOW" && decision.authorization
      ? { guard: runtime.launchGuard, token: decision.authorization.token }
      : undefined,
  }
}

function isExplicitSyncRun(runInBackground: unknown): boolean {
  return runInBackground === false || runInBackground === "false"
}

const MAX_DELEGATION_FIRST_ATTEMPTS = 4

type DelegationFirstSyncParams = {
  options: DelegateTaskToolOptions
  ctx: ToolContextWithMetadata
  args: DelegateTaskArgs
  parentContext: ParentContext
  agentToUse: string
  categoryModel: DelegatedModelConfig | undefined
  systemContent: string | undefined
  modelInfo?: import("../../features/task-toast-manager/types").ModelFallbackInfo
  fallbackChain?: import("../../shared/model-requirements").FallbackEntry[]
}

async function runDelegationFirstSync(params: DelegationFirstSyncParams): Promise<string> {
  const { options, ctx, args, parentContext, agentToUse, categoryModel, systemContent, modelInfo, fallbackChain } = params
  const ladder = options.delegationFirstRuntime

  let available = new Set<string>()
  let pricing = options.pricingCatalog
  if (options.availableModelsOverride) {
    available = options.availableModelsOverride
  } else {
    try {
      const live = await getModelsWithPricingForDelegateTask(options.client)
      available = live.models
      pricing = options.pricingCatalog ? { ...options.pricingCatalog, ...live.pricing } : options.pricingCatalog
    } catch {
      available = new Set()
    }
  }

  const resolvedModelID = categoryModel?.modelID
    ? resolvedModelKey(categoryModel.providerID, categoryModel.modelID)
    : null

  const workers = pricing
    ? buildDelegationWorkerCandidates({
        pricing,
        available,
        resolvedModelID,
        unavailable: new Set(options.delegationFirstRuntime?.unavailableModels() ?? []),
        mainModel: parentContext.model?.modelID
          ? resolvedModelKey(parentContext.model.providerID, parentContext.model.modelID)
          : undefined,
      })
    : []

  const jobID = `df-${ctx.callID ?? ctx.callId ?? ctx.call_id ?? Math.random().toString(36).slice(2, 10)}`

  if (ladder && workers.length > 0) {
    ladder.beginDelegation(jobID, ctx.sessionID, args.prompt, workers)
  }

  let currentModel = categoryModel
  let currentPrompt = args.prompt
  let lastResult = ""
  let lastAdequacy = null as ReturnType<typeof judgeSyncAdequacy> | null

  for (let attempt = 0; attempt < MAX_DELEGATION_FIRST_ATTEMPTS; attempt++) {
    const enforcement = enforceResourceGovernor(
      options,
      ctx,
      { ...args, prompt: currentPrompt },
      agentToUse,
      currentModel,
      parentContext,
    )
    if (enforcement.message !== null) {
      return enforcement.message
    }

    const result = await executeSyncTask(
      { ...args, prompt: currentPrompt },
      ctx,
      options,
      parentContext,
      agentToUse,
      currentModel,
      systemContent,
      modelInfo,
      fallbackChain,
      undefined,
      enforcement.backstop,
    )
    lastResult = result

    if (enforcement.escrowID !== null) {
      options.resourceGovernorRuntime?.settleChild(ctx.sessionID, enforcement.escrowID, "completed")
    }

    if (!ladder || workers.length === 0) return result

    const adequacy = judgeSyncAdequacy(result)
    lastAdequacy = adequacy
    const action = ladder.recordWorkerResult(jobID, adequacy)

    if (action.kind === "done" || action.kind === "give_up") break

    if (action.kind === "retry_refined") {
      currentPrompt = action.refinedPrompt
      continue
    }

    if (action.kind === "escalate") {
      const parsed = parseModelString(action.worker.model_id)
      const hasDifferentModel =
        parsed !== undefined &&
        typeof parsed.modelID === "string" &&
        typeof parsed.providerID === "string" &&
        (!currentModel || resolvedModelKey(parsed.providerID, parsed.modelID) !== resolvedModelKey(currentModel.providerID, currentModel.modelID))

      if (hasDifferentModel && parsed) {
        currentModel = {
          providerID: parsed.providerID,
          modelID: parsed.modelID,
          ...(parsed.variant ? { variant: parsed.variant } : {}),
        }
      }

      currentPrompt = lastAdequacy
        ? refineAssignment(args.prompt, lastAdequacy)
        : args.prompt
      continue
    }
  }

  return lastResult
}
