import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { MODEL_TIERS, resolveModelBand, type ModelBandCandidate, type ModelTier } from "@oh-my-opencode/delegate-core"
import type { DelegatedModelConfig, ToolContextWithMetadata, DelegateTaskToolOptions, DelegateTaskArgs } from "./types"
import { log } from "../../shared/logger"
import { parseModelString } from "../../shared/model-string-parser"
import { getModelsWithPricingAndMetadataForDelegateTask, getEnabledModelState } from "./available-models"
import { filterEnabledModelKeys } from "../../shared/model-enable-state"
import { paidWorkerGate } from "./paid-worker-gate"
import {
  classifyPaidStatus,
  consumePaidApproval,
  createOpenCodePermissionConsentProvider,
  enforcePaidWorkerLaunch,
  isRootSessionInfo,
  maxConcurrentPaidWorkers,
} from "./paid-consent"
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
import { authorizeChildDispatch, blockMessage, lookupPricing, resolvedModelKey, type ChildLaunchBackstop, type ResourceGovernorRuntime } from "../../hooks/resource-governor"
import { buildDelegationWorkerCandidates, type ModelCapabilityInfo } from "../../features/delegation-first"
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
  // The no-delegation-first-runtime fallback paid gate honors the configured limit.
  paidWorkerGate.setMaxConcurrent(maxConcurrentPaidWorkers(options.modelRouting))
  const { availableCategories, availableSkills, categoryExamples, description } = createDelegateTaskPresentation(options)

  return tool({
    description,
    args: delegateTaskArgsSchema,
    async execute(args, toolContext) {
      const ctx = toolContext as ToolContextWithMetadata
      const isRootSession = await resolveIsRootSession(options, ctx)
      const taskID = buildTaskID(ctx)
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
      const modelOptions = {
        ...(currentModelConfig === undefined
          ? options
          : { ...options, userCategories: currentModelConfig.categories, agentOverrides: currentModelConfig.agents, modelRouting: currentModelConfig.model_routing }),
        isRootSession,
      }

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

        let available = new Set<string>()
        let pricing = options.pricingCatalog
        let candidateInfo = new Map<string, ModelCapabilityInfo>()
        if (options.availableModelsOverride) {
          available = options.availableModelsOverride
        } else {
          const live = await getModelsWithPricingAndMetadataForDelegateTask(options.client)
          available = live.models
          candidateInfo = live.modelInfo
          pricing = options.pricingCatalog ? { ...options.pricingCatalog, ...live.pricing } : live.pricing
        }

        const enableState = await getEnabledModelState(options.client)
        const unavailable = new Set(options.delegationFirstRuntime?.unavailableModels() ?? [])
        for (const modelKey of enableState.disabledModels) unavailable.add(modelKey)

        const enabled = filterEnabledModelKeys(available, enableState)
        const mainModel = inheritedModel
        const mainPricing = mainModel && pricing ? lookupPricing(pricing, mainModel) : undefined

        const pinned: Partial<Record<ModelTier, string>> = {}
        const tiers = modelOptions.modelRouting?.tiers
        if (tiers) {
          for (const t of MODEL_TIERS) {
            const entry = tiers[t]
            if (!entry) continue
            if (t === "master") {
              if (entry.inherit_parent === false && entry.model) pinned.master = entry.model
            } else if (entry.model) {
              pinned[t] = entry.model
            }
          }
        }

        const candidates: ModelBandCandidate[] = []
        for (const id of enabled) {
          if (unavailable.has(id)) continue
          const info = candidateInfo.get(id)
          candidates.push({
            model: id,
            pricing: pricing ? lookupPricing(pricing, id) : undefined,
            ...(info?.vision === undefined ? {} : { vision: info.vision }),
            ...(info?.tool_call === undefined ? {} : { tool_call: info.tool_call }),
            ...(info?.reasoning === undefined ? {} : { reasoning: info.reasoning }),
            ...(info?.context_limit === undefined ? {} : { context_limit: info.context_limit }),
          })
        }

        const resolved = resolveModelBand({
          requestedTier: tier,
          candidates,
          mainModel,
          mainPricing,
          pinned,
          unavailable,
          // ORDINARY CHILD POLICY (free-only): an explicit `model_tier` on an
          // ordinary child request does NOT grant paid permission, even when the
          // parent is the root/master session. Paid execution requires a
          // separate explicit MASTER paid-worker request plus fresh operator
          // consent (gatePaidChildLaunch / enforcePaidWorkerLaunch).
          allowPaidWorkers: false,
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
          band: resolved.band,
          model: resolved.model,
          escalated: resolved.escalated,
          usedMainModel: resolved.usedMainModel,
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

        const unstablePaidGate = await gatePaidChildLaunch({
          options,
          ctx,
          modelOptions,
          args: delegateTaskArgs,
          agentToUse,
          categoryModel,
          isRootSession,
          taskID,
          task: delegateTaskArgs.prompt,
          reason: "unstable agent forced to background",
        })
        if (!unstablePaidGate.ok) {
          notifyChildLaunchBlocked(options, ctx, "paid_gate_block")
          return unstablePaidGate.message
        }
        const unstablePaidNonce = unstablePaidGate.nonce

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
          if (!consumePaidLaunchApproval(options, ctx, agentToUse, categoryModel, taskID, unstablePaidNonce)) {
            return "PAID_WORKER_CONSENT_CONSUMED: single-use paid approval did not match the unstable-agent launch identity."
          }
          return executeUnstableAgentTask(delegateTaskArgs, ctx, options, parentContext, agentToUse, categoryModel, systemContent, actualModel)
        }
      } else {
        const resolution = await resolveSubagentExecution(delegateTaskArgs, modelOptions, parentContext.agent, categoryExamples, { mainModel: inheritedModel })
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

      // COST-SAFETY: when the resolved child model is paid, acquire a paid-child
      // slot. Free-only children are not gated. With allow_paid_workers true the
      // slot is capped at max_concurrent_paid_workers (default 1); without paid
      // permission the resolver already refuses paid models.
      const resolvedPaidKey = categoryModel?.modelID
        ? resolvedModelKey(categoryModel.providerID, categoryModel.modelID)
        : null

      // PAID-WORKER CONSENT GATE: a paid child requires true MASTER/ROOT authority
      // plus a fresh single-use operator approval for this exact launch.
      const paidGate = await gatePaidChildLaunch({
        options,
        ctx,
        modelOptions,
        args: delegateTaskArgs,
        agentToUse,
        categoryModel,
        isRootSession,
        taskID,
        task: delegateTaskArgs.prompt,
      })
      if (!paidGate.ok) {
        notifyChildLaunchBlocked(options, ctx, "paid_gate_block")
        return paidGate.message
      }
      const paidApprovalNonce = paidGate.nonce

      let paidSlotAcquired = false
      if (resolvedPaidKey && classifyPaidStatus(resolvedPaidKey, options.pricingCatalog) !== "free") {
        if (paidApprovalNonce === null) {
          return "PAID_WORKER_CONSENT_CONSUMED: internal error, a paid launch reached execution without an approved single-use consent."
        }
        const gate = options.delegationFirstRuntime
        const ok = gate
          ? gate.tryAcquirePaidChild()
          : paidWorkerGate.tryAcquire()
        if (!ok) {
          notifyChildLaunchBlocked(options, ctx, "paid_slot_exhaustion")
          return `PAID_WORKER_CONCURRENCY_LIMIT: maximum ${maxConcurrentPaidWorkers(modelOptions.modelRouting)} concurrent paid child request(s) reached. Wait for an existing paid child to finish, then retry.`
        }
        paidSlotAcquired = true
      }

      if (runInBackground) {
        if (!consumePaidLaunchApproval(options, ctx, agentToUse, categoryModel, taskID, paidApprovalNonce)) {
          if (paidSlotAcquired) {
            if (options.delegationFirstRuntime) options.delegationFirstRuntime.releasePaidChild()
            else paidWorkerGate.release()
          }
          notifyChildLaunchBlocked(options, ctx, "paid_consent_consumed")
          return "PAID_WORKER_CONSENT_CONSUMED: single-use paid approval did not match the launch identity."
        }
        return executeBackgroundTask(delegateTaskArgs, ctx, options, parentContext, agentToUse, categoryModel, systemContent, fallbackChain, paidSlotAcquired)
      }

      if (options.delegationFirstRuntime) {
        try {
          return await runDelegationFirstSync({
            options,
            ctx,
            args: delegateTaskArgs,
            parentContext,
            agentToUse,
            categoryModel,
            systemContent,
            modelInfo,
            fallbackChain,
            isRootSession,
            taskID,
          })
        } finally {
          if (paidSlotAcquired) options.delegationFirstRuntime.releasePaidChild()
        }
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
        if (!consumePaidLaunchApproval(options, ctx, agentToUse, categoryModel, taskID, paidApprovalNonce)) {
          if (paidSlotAcquired) {
            paidWorkerGate.release()
          }
          notifyChildLaunchBlocked(options, ctx, "paid_consent_consumed")
          return "PAID_WORKER_CONSENT_CONSUMED: single-use paid approval did not match the launch identity."
        }
        return await executeSyncTask(delegateTaskArgs, ctx, options, parentContext, agentToUse, categoryModel, systemContent, modelInfo, fallbackChain, undefined, enforcement.backstop)
      } finally {
        if (paidSlotAcquired) {
          // This path runs only without a delegation-first runtime (that branch
          // returns earlier), so the module gate always owns the slot here.
          paidWorkerGate.release()
        }
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

function buildTaskID(ctx: ToolContextWithMetadata): string {
  return ctx.callID ?? ctx.callId ?? ctx.call_id ?? ctx.sessionID
}

// A paid-gate block returns before a child session exists, so background-task.ts
// never fires noteChildStartupFailure. This helper fires it so the parent root
// enters ROOT_REPAIR_MODE (repair does NOT grant paid authority; it only unlocks
// root repo work + validation). No-op when no delegation-first runtime is wired.
function notifyChildLaunchBlocked(
  options: DelegateTaskToolOptions,
  ctx: ToolContextWithMetadata,
  reasonCode: string,
): void {
  options.delegationFirstRuntime?.noteChildStartupFailure(ctx.sessionID, null, reasonCode)
}

async function resolveIsRootSession(options: DelegateTaskToolOptions, ctx: ToolContextWithMetadata): Promise<boolean> {
  // Test/harness seam: an explicit isRootSession option wins. Production never sets it,
  // so real launches always derive authority from the OpenCode session hierarchy.
  if (options.isRootSession !== undefined) return options.isRootSession
  try {
    const info = await options.client.session.get({ path: { id: ctx.sessionID } })
    return isRootSessionInfo((info as { data?: { parentID?: string | null } }).data)
  } catch {
    // Fail closed on authority: an unresolvable session cannot request paid launches.
    return false
  }
}

type PaidGateOutcome = { ok: true; nonce: string | null } | { ok: false; message: string }

async function gatePaidChildLaunch(input: {
  options: DelegateTaskToolOptions
  ctx: ToolContextWithMetadata
  modelOptions: DelegateTaskToolOptions
  args: DelegateTaskArgs
  agentToUse: string
  categoryModel: DelegatedModelConfig | undefined
  isRootSession: boolean
  taskID: string
  task: string
  reason?: string
  freeCandidatesExhausted?: boolean
}): Promise<PaidGateOutcome> {
  const resolvedModelKeyValue = input.categoryModel?.modelID
    ? resolvedModelKey(input.categoryModel.providerID, input.categoryModel.modelID)
    : null
  if (!resolvedModelKeyValue) return { ok: true, nonce: null }
  if (classifyPaidStatus(resolvedModelKeyValue, input.options.pricingCatalog) === "free") {
    return { ok: true, nonce: null }
  }
  const registry = input.options.paidConsentRegistry
  if (!registry) {
    return {
      ok: false,
      message: `PAID_WORKER_CONSENT_UNAVAILABLE: paid worker launch requires a single-use operator approval, but no consent registry is available; failing closed for "${resolvedModelKeyValue}".`,
    }
  }
  const ask = (input.ctx as ToolContextWithMetadata).ask
  const provider = createOpenCodePermissionConsentProvider(ask)
  const verdict = await enforcePaidWorkerLaunch({
    resolvedModelKey: resolvedModelKeyValue,
    pricing: input.options.pricingCatalog,
    modelRouting: input.modelOptions.modelRouting,
    isRootSession: input.isRootSession,
    rootSessionID: input.ctx.sessionID,
    workerIdentity: input.agentToUse,
    capabilityTier: input.args.model_tier ?? null,
    task: input.task,
    taskID: input.taskID,
    reason: input.reason,
    freeCandidatesExhausted: input.freeCandidatesExhausted ?? false,
    consentProvider: provider,
    registry,
    audit: input.options.paidConsentAudit,
  })
  if (verdict.action === "block") return { ok: false, message: verdict.message }
  return { ok: true, nonce: verdict.action === "allow_paid" ? verdict.nonce : null }
}

function consumePaidLaunchApproval(
  options: DelegateTaskToolOptions,
  ctx: ToolContextWithMetadata,
  agentToUse: string,
  categoryModel: DelegatedModelConfig | undefined,
  taskID: string,
  nonce: string | null,
): boolean {
  if (!nonce) return true
  const registry = options.paidConsentRegistry
  if (!registry) return false
  const resolvedModelKeyValue = categoryModel?.modelID
    ? resolvedModelKey(categoryModel.providerID, categoryModel.modelID)
    : null
  const approval = consumePaidApproval(
    registry,
    nonce,
    {
      rootSessionID: ctx.sessionID,
      workerIdentity: agentToUse,
      resolvedModelID: resolvedModelKeyValue ?? "",
      taskID,
    },
    options.paidConsentAudit,
  )
  return approval !== null
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
  isRootSession: boolean
  taskID: string
}

async function runDelegationFirstSync(params: DelegationFirstSyncParams): Promise<string> {
  const { options, ctx, args, parentContext, agentToUse, categoryModel, systemContent, modelInfo, fallbackChain } = params
  const ladder = options.delegationFirstRuntime

  let available = new Set<string>()
  let pricing = options.pricingCatalog
  let candidateModelInfo = new Map<string, import("../../features/delegation-first").ModelCapabilityInfo>()
  if (options.availableModelsOverride) {
    available = options.availableModelsOverride
  } else {
    try {
      const live = await getModelsWithPricingAndMetadataForDelegateTask(options.client)
      available = live.models
      candidateModelInfo = live.modelInfo
      pricing = options.pricingCatalog ? { ...options.pricingCatalog, ...live.pricing } : options.pricingCatalog
    } catch {
      available = new Set()
    }
  }

  const enableState = await getEnabledModelState(options.client)

  const resolvedModelID = categoryModel?.modelID
    ? resolvedModelKey(categoryModel.providerID, categoryModel.modelID)
    : null

  const unavailable = new Set(options.delegationFirstRuntime?.unavailableModels() ?? [])
  for (const modelKey of enableState.disabledModels) unavailable.add(modelKey)

  const workers = pricing
    ? buildDelegationWorkerCandidates({
        pricing,
        available: filterEnabledModelKeys(available, enableState),
        resolvedModelID,
        unavailable,
        modelInfo: candidateModelInfo,
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

    // Each paid child launch requires its own fresh single-use operator approval.
    const attemptGate = await gatePaidChildLaunch({
      options,
      ctx,
      modelOptions: options,
      args: { ...args, prompt: currentPrompt },
      agentToUse,
      categoryModel: currentModel,
      isRootSession: params.isRootSession,
      taskID: params.taskID,
      task: currentPrompt,
      reason: "delegation ladder escalated to a stronger/paid worker",
    })
    if (!attemptGate.ok) return attemptGate.message
    if (!consumePaidLaunchApproval(options, ctx, agentToUse, currentModel, params.taskID, attemptGate.nonce)) {
      return "PAID_WORKER_CONSENT_CONSUMED: single-use paid approval did not match the escalation launch identity."
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
