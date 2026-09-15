# OMA Resource Governor — Authoritative Report

## Model Routing: usable-worker selection + disabled-model hard-fail (this change)

**Status: COMPLETE.** Real delegation was firing but `explore` workers resolved to
`opencode/claude-haiku-4-5`, which the `opencode` gateway rejects with `AI_APICallError: Model is
disabled`; the child produced 0 tokens and stayed `running`. This change makes worker routing
select *usable* models (cheapest sufficient free-first, escalating to MAIN's own model) and hard-fail
on a disabled model by marking it unavailable and auto-dispatching the next eligible worker.

### Resolver discrepancy (traced, not guessed)

The inspected fallback source `packages/model-core/src/agent-model-requirements.ts` lists
`explore`'s `claude-haiku-4-5` rung under providers `["anthropic", "github-copilot"]` — never
`opencode` (the `model-requirements-deprecated-routing.test.ts` contract forbids Haiku via
`opencode`). The runtime nonetheless selected `opencode/claude-haiku-4-5` because the **user's own
config** `~/.omo/omo.jsonc` `[opencode].agents.explore.models` names `opencode/claude-haiku-4-5`
FIRST, and the user-model override path in `resolveModelForDelegateTask` outranks the hardcoded
chain. `opencode` is the only authenticated provider (`~/.config/opencode/auth.json` =
`["opencode"]`), its live catalog lists `claude-haiku-4-5`, so the resolver treats it
"available/connected" — but the gateway's underlying route is disabled, so catalog presence did not
prove usability. Nothing re-ranked to the next usable configured model (`opencode-go/qwen3.5-plus`,
…), nothing classified "Model is disabled", and `handleSessionErrorEvent` treated the still-alive
shell session as transient, leaving the task `running`.

### Changes

- `model-core/model-error-classifier.ts`: `isModelDisabledError` + `isAvailabilityError` (availability
  ≠ reasoning ≠ transient retry); "Model is disabled" is NOT a quality retry.
- `delegation-first/model-availability-cache.ts` (new): bounded, expiring negative-availability cache.
- `delegation-first/free-worker-candidates.ts`: `unavailable` filter, `mainModel` terminal rung,
  `minCapability`/`capabilities` strength floor (free-before-paid ranking unchanged).
- `delegation-first/availability-failover.ts` (new) + `runtime.ts` `recordModelUnavailable`: marks the
  model unavailable, auto-dispatches the next eligible worker via the governed relaunch sink, and
  hard-fails truthfully (`onTerminal("failed")` + cancel + `retry_chain_exhausted`) when none remains.
- `background-agent/error-classifier.ts`: a disabled model is a TERMINAL session error (fixes the
  zombie); `manager.ts` fires `onSubagentModelUnavailable` wired in `create-managers.ts` to
  `recordModelUnavailable`.
- `available-models.ts`: `getModelsWithPricingForDelegateTask` derives authoritative $0 from the live
  `client.model.list()` cost; unknown cost is never free. Wired into both background and sync dispatch.

### Availability / free-price sources

- Bundled OpenGateway catalog (`opengateway-models.json`): 60 paid entries, 0 free, 0 `opencode/`.
- Live source (fixed): `client.model.list()` per-model `cost` (USD/1M tokens; free only when input AND
  output are 0). The catalog alone was the wrong/incomplete source for free discovery.

### Escalation ladder

free → stronger free → cheap paid → strong paid → MAIN's own model (appended as the terminal `expert`
rung). A disabled model escalates forward-only to the next stronger eligible worker, never back.

### Tests (all green)

`model-error-classifier-disabled` (7), `model-availability-cache` (6), `free-worker-candidates` +
`free-worker-candidates-routing` (9), `availability-failover` (3), `record-model-unavailable` (3),
`available-models-pricing` (4). Regression: `delegation-first` 56, `delegate-task` 516,
`background-agent` 771, `model-core` error-classifier suite — all pass. `bun run typecheck` clean;
`bun run build` succeeds; `dist/index.js` carries `isModelDisabledError`, `selectNextEligibleWorker`,
`createModelAvailabilityCache`, `recordModelUnavailable`, `unavailableModels`; smoke-import OK.

### Live validation

Deterministic candidate-A-disabled → candidate-B-dispatched is proven by
`record-model-unavailable.test.ts` through the real `createDelegationFirstRuntime` + governed relaunch
sink. A live `date` child (tokens > 0) was NOT run: no genuine free model is configured here (only the
`opencode` gateway; bundled catalog has 0 $0 models), and a paid DeepSeek call is out of scope for this
branch's validation policy. The title fallback already degrades gracefully (`session.update` wrapped
in `.catch`); no OpenAI/Anthropic re-enable was made. Full evidence:
`.omo/evidence/20260915-model-routing-disabled-model/README.md`.


**Proven root cause.** Three parallel `explore` background children created successfully and
then sat at `status=running` for ~28 minutes with no output because the runtime had **no lifecycle
milestones**, **no differentiated stall classification**, **no stage-aware timeouts**, and **no
automatic reclaim**. Two independent gaps combined:

1. The background-task poller (`BackgroundManager`) only completes a child on `session.idle` +
   stability. If the provider never responds and the session never idles, the task stays `running`
   indefinitely (no deadline).
2. The Level-1 watchdog only *detected* `SUSPECTED_STALL` and journaled it; the periodic sweep in
   `create-managers.ts` called `checkAllWatchdogs()` and discarded the result. Nothing cancelled the
   child, marked it terminal, or retried it.

Because there were no per-stage timestamps, we could not even determine *where* a child stopped
(request never sent vs. provider hung vs. response lost). The reported class of failure is therefore
"zero-progress child with no observable failure point and no automatic recovery".

**Real child lifecycle path (traced).** For a background child:
`task` tool → `executeBackgroundTask` → `BackgroundManager.launch` (task `pending`, queued) →
`startTask` (manager.ts): `client.session.get(parent)` → `client.session.create` (session created) →
`promptWithRetryInDirectory` (provider request dispatched, fire-and-forget) →
`onSubagentSessionCreated` (tmux callback → `delegationFirstRuntime.attachChildSession` → watchdog
register) → `event` hook `watchdogActivity` (first provider output) → task-poller `session.idle` →
terminal. The watchdog attach fires *after* prompt dispatch, so `markRequestStarted` uses a
pending-set so the milestone is applied once the session registers.

**Authoritative progress primitive.** The existing per-child-session activity-event counter
(`onActivity`, one in-process integer increment per `message.updated` / `message.part.*` /
`session.next.*` / `step.*` event). Monitoring reads only `progressCounter`,
`previousProgressCounter`, `lastChangeAtMs`, stage + stage/request/response timestamps. It reads no
output, no output delta, no transcript, and makes zero model calls per check.

**Stage-aware timeout policy** (`worker-supervisor/timeouts.ts`, configurable via
`resource_governor.watchdog`): `dispatch_timeout_ms` (30s, authorized→no session),
`request_start_timeout_ms` (30s, session→no request), `provider_response_timeout_ms` (180s,
request→no response), `quiet_stall_threshold_ms` (180s, execution stall),
`wedged_threshold_ms` (300s, tool/process). A build/test/process is `QUIET_BUT_ACTIVE`, never
falsely stalled.

**Differentiated failure modes** (`worker-supervisor/stall.ts`): `DISPATCH_STALL`,
`PROVIDER_START_STALL`, `PROVIDER_RESPONSE_STALL`, `EXECUTION_STALL`, `TOOL_STALL`,
`QUIET_BUT_ACTIVE`. Each carries `timedOut` so a within-deadline quiet child is not reclaimed.

**Automatic recovery** (`worker-supervisor/recovery.ts` + `delegation-first/reclaimStalled` +
`create-managers.ts` sweep): detect → record exact stage → cancel/reclaim (truthful `cancelled`
terminal, never left `running`) → journal `watchdog_reclaimed` + `worker_retry_started` → retry per
policy. First stall recharges same worker; a repeated same-model stall flips `alternate_worker`
(true); a correlated parallel stall (>=2 same provider/model reclamations within 120s) also flips
`alternate_worker` so three identical workers are not blindly relaunched into the same failure.
Same-worker reclaim budget (`sameWorkerMaxReclaims=1`) stops unbounded loops.

**Truthful status.** A reclaimed child reaches stage `cancelled` / `TERMINAL`; the `stalled`
intermediate is preserved via `markStalled` + the stage is absorbing (a later session-deleted
terminal cannot overwrite an explicit terminal kind).

**Tests.** `worker-supervisor` 49 pass / 0 fail (watchdog, lifecycle, stall, recovery + supervision);
`delegation-first` 15 pass / 0 fail (incl. `stall-recovery.test.ts` real-path integration:
healthy→completed; zero-progress explore reclaimed within timeout; request-never-started;
three parallel correlated stalls; no child content in audit). Resource-governor 168, background-agent
771, delegate-task 512, create-managers 9 — all green. `bun run typecheck` clean; `bun run build`
succeeds; `dist/index.js` carries `child_*` milestones, `reclaimStalled`,
`onSubagentRequestStarted`, and all six `*_STALL` modes.

**Live validation: SKIPPED.** No cheap configured provider is available in this environment and a
paid-inference drive is out of scope. No success is fabricated.

**Remaining limitations (at that time).** Retry was a journaled recommendation (`worker_retry_started` +
`alternate_worker`/`worker_model_escalated`) plus a truthful `cancelled` terminal; the fully automatic
*re-dispatch to a new child* then still required retaining the full `LaunchInput`. **This is now
implemented** — see "Automatic Child Failover" below. `DISPATCH_STALL` was available in the classifier
but the background path pre-empted it with the poller's stale-task timeout.

## Automatic Child Failover — Re-Dispatch of Reclaimed Children (this change)

**Status: COMPLETE.** The previous stall-diagnosis change reclaimed stalled children truthfully but only
*journaled* a retry recommendation; it did not actually launch a replacement. This change closes that
gap: a stalled child is now reclaimed AND a governed replacement child is automatically re-dispatched
through the real launch path, with stage-aware worker selection, correlated-failure avoidance, partial
finding preservation, and bounded retry lineage.

**Replayable assignment.** `features/delegation-first/replay.ts` defines a bounded, secrets-free
`ReplayableAssignment` (assignment id, root/parent/message ids, prompt, description, agent, category,
model, parent model/agent/tools, fallback chain, skills, skill content, session permissions, cwd,
unstable flag, and the ordered `WorkerCandidate` ladder) plus a `RetryLineage` (`attempt_number`,
`worker_index`, `previous_workers`, `current_worker`, failure stage/mode/reason, `findings`). No
transcript, output, or secret is retained. The runtime retains it at dispatch:
`executeBackgroundTask` (`tools/delegate-task/background-task.ts`) calls
`retainAssignment(...)` after launch, and `create-managers.ts` reuses it. The original `LaunchInput`
shape is reused end-to-end; no parallel dispatch system is introduced.

**Retry lineage.** `RetryLineage` tracks `attempt_number` (attempt 1 = original dispatch),
`previous_workers` (model ids already tried, in order), `current_worker`, and the failure
stage/mode/reason. Each replacement increments the attempt number and appends the failed worker, so a
retry chain (`assignment_id`, attempt N, previous worker, current worker) is fully observable without
conflating sessions.

**Stage-aware failover.** `features/delegation-first/failover.ts` `recommendFailoverAction` maps a
timed-out stall to `retry_worker` / `alternate_worker` / `escalate_worker` / `give_up`:
`DISPATCH_STALL`/`PROVIDER_START_STALL` (launch failures) re-fire the same worker; `PROVIDER_RESPONSE_STALL`
and correlated failures prefer an alternate model/provider; repeated same-worker `EXECUTION_STALL`/`TOOL_STALL`
escalate up the ladder after `escalate_after_attempts`; the chain is bounded by
`max_attempts_per_tier * workers.length` and `max_free_attempts_total`.

**Correlated failures.** The existing `RecoveryCoordinator` `correlated` signal feeds the failover
decision: several same-provider/model reclamations within `correlatedWindowMs` select an alternate
target instead of blindly relaunching identical workers, preventing retry storms.

**Budget handling.** A replacement is a NEW governed launch: the `relaunch` sink in
`create-managers.ts` reconstructs the `LaunchInput` (new worker model from the failover action, original
prompt + a compact prior-evidence block) and calls `backgroundManager.launch(...)`, which runs
`authorizeChildDispatch` (Resource Governor) + the `ChildLaunchGuard` backstop at `session.create`.
Previous spend stays spent; a blocked replacement returns `{ kind: "blocked" }` and is journaled
`replacement_child_blocked` + `retry_chain_exhausted` with no silent bypass.

**Result propagation.** The replacement launches with the same `parentSessionId`/`parentMessageId`, so its
result flows down the existing parent-wake path to the original caller; the old child stays truthfully
terminal (`cancelled`). Watchdog ownership transfers cleanly because the replacement is a distinct
session id with fresh stage/counter state.

**Audit events.** `shared/governance-audit/events.ts` `STALL_RECOVERY_AUDIT_EVENTS` now includes
`worker_reclaimed`, `worker_retry_started` (kept for compatibility), `worker_retry_planned`,
`worker_retry_dispatched`, `alternate_worker_selected`, `replacement_child_created`,
`replacement_child_completed`, `replacement_child_blocked`, `retry_chain_exhausted`. Each carries
`assignment_id`, attempt number, old/new worker and session ids, provider/model, failure stage and
reason code; no prompt/output/secret.

**Tests.** `features/delegation-first/failover.test.ts` (9) covers the decision core (stage-aware,
correlated, bounded, exhaustion, free budget). `failover-redispatch.test.ts` (12) proves the runtime
reclaim→relaunch path (replacement launched, original bounded assignment received, partial findings
survive, old child terminal, fresh watchdog state + lineage, repeated same-model stall switches
model, correlated stalls do not blind-relaunch, bounded attempts, exhausted → truthful terminal,
budget block, no root takeover, no prompt/output in audit, no retained assignment → exhausted).
`failover-replay.e2e.test.ts` (3) exercises the REAL governed boundary (real `createResourceGovernorRuntime`
+ `authorizeChildDispatch` + `ChildLaunchGuard`): Scenario A (provider-response stall → alternate
auto-dispatch → complete → result path), Scenario B (three correlated stalls → non-identical retarget),
Scenario C (hard-budget block, truthful). All green; `worker-supervisor` 49, `delegation-first` 39,
`resource-governor` 112, `background-agent` 771, `delegate-task` 512, `create-managers` 9. `bun run
typecheck` clean; `bun run build` succeeds; `dist/index.js` carries `recommendFailoverAction`,
`buildReplacementPrompt`, `initialLineage`, `retainAssignment`, `noteReplacementSession`, and the eight
new audit-event names; smoke-import succeeds with `{ id, server }`.

**Remaining limitations.** `replacement_child_completed` fires when the replacement session id resolves
(the real background path links it via the `onSessionCreated` callback; a session id not yet known at
relaunch time is linked once the session is created). Partial-finding capture for a *background* child
is opportunistic: a child that stalled before producing output has no findings to preserve (truthful);
the retention API (`recordPartialFindings`) is available for paths that can surface compact anchors.
Live free-worker validation remains SKIPPED (no configured free provider; see below), so free selection
is proven with injected pricing, never fabricated.

## Delegation-First + Watchdog Level 1 (this change)

**Status (updated 2026-09-15): delegation-first is now LIVE-WIRED into the real OpenCode child
dispatch path.** The `delegation-first` runtime (retry/escalation ladder + metadata-only Level-1
watchdog + root grunt-guard) is composed over the zero-token Governance Audit Journal and is now
attached to managers, the `task` tool sync dispatch path, the plugin `event` hook (watchdog
activity feed), and the `tool.execute.after` grunt-guard feed. Retry/refine, model escalation, and
free-first worker selection now run for real child launches; the watchdog observes real child
session lifecycles metadata-only. No paid-model inference was made during validation (catalog has
0 free models; dispatch validity was proven with injected free candidates).

Scope (`.omo/plans/20260915-delegation-first-watchdog.md`): extend, not replace, the Resource
Governor / Context Governor / Worker Supervisor / audit journal / dynamic routing work. The chosen
Level-1 monotonic progress signal is the plugin's own per-child-session activity-event counter
(one in-process integer increment per lifecycle event: no DB read, no spawn, no model call, no
transcript/output read), with `session.time_updated` as the authoritative DB cross-check.

New / extended modules (all pure, dependency-injected pricing + free status):

- `features/delegation-ladder/` (`types.ts`, `ladder.ts`, `refinement.ts`, `attempts.ts`): retry +
  model-escalation ladder with finding preservation; bounded retries before escalation
  (`retry_refined` → `escalate` → `done`/`exhausted`). Preserves prior `findings` + `unresolved`
  across attempts; never auto-takes-over to root grunt work.
- `features/worker-supervisor/` extended with `level1.ts` (`HEALTHY` / `QUIET_BUT_ACTIVE` /
  `SUSPECTED_STALL`) + `watchdog.ts` (stateful facade, zero model calls, coalesced metadata-only
  audit events). Watchdog NEVER reads output / delta / transcript.
- `features/grunt-guard/` (`detector.ts`): pure detector for repeated direct MAIN search/read/test
  cycles with no delegation (orchestration guidance; emits `root_direct_exception`).
- `features/delegation-first/` (`runtime.ts` + barrel): composes the three above over one
  `GovernanceAuditWriter`; every audit event is metadata only (ids, tiers, counters, decisions).

Integration scaffolding:

- `shared/governance-audit/events.ts` + `index.ts`: `DELEGATION_AUDIT_EVENTS` +
  `WATCHDOG_AUDIT_EVENTS` + `GOVERNANCE_DELEGATION_WATCHDOG_EVENTS` name catalogs (metadata only).
- `config/schema/resource-governor.ts`: bounded `delegation_ladder` + `watchdog` Zod subschemas,
  wired into `ResourceGovernorConfigSchema`; 3 new schema tests.
- `agents/sisyphus-dynamic-prompt-role.ts`: concise "Delegation-first: Retry / Escalation Ladder"
  note (by-read only; no prose-contract test).

Mocked E2E (deterministic, no paid call), `delegation-first/delegation-first.e2e.test.ts`:

- Successful flow: free worker attempt 1 weak → `retry_refined` (same free worker) → adequate →
  `done`; MAIN verifies the critical source anchor with one selective read (not grunt); a broad
  search/read crawl WITHOUT delegation IS flagged grunt. No `worker_model_escalated`; no worker
  prompt / output / anchor text ever reaches the journal.
- Escalation flow: two inadequate free attempts → `escalate` to the next worker model (`free_alt`),
  findings preserved; root still takes no direct crawl.

Invariants honored: no `as any` / `@ts-ignore`; given/when/then; kebab-case + barrel `index.ts`;
watchdog Level 1 metadata-only (no output/delta/transcript); unknown-price model is NOT free
(`isFreePricing(undefined) === false` already in the core); disabled providers stay disabled.

Tests (all green): `delegation-ladder`, `grunt-guard`, `worker-supervisor` (incl.
`watchdog.test.ts`), `delegation-first` (2 E2E) → **45 pass / 0 fail** across 5 feature files;
resource-governor 112, config/schema 56, governance-audit 15, delegate-task-retry 10.
`tsgo --noEmit` clean; `bun run build` succeeds; `dist/index.js`
contains the new audit-event names and `dist/oh-my-opencode.schema.json` / `assets/*.schema.json`
carry the `delegation_ladder` + `watchdog` blocks.

**Not yet wired (explicitly out of this change's scope):** the `delegation-first` runtime is not
connected to live child dispatch, the OpenCode `event` hook, or the Supervisor's real child-result
feed — that remains the same live-wiring gap already listed under "Known Limitations"
(free-first *re-selection* at dispatch; per-child result observation; end-of-run HUD). This change
delivers the decision core + scaffolding + deterministic proof, not a live-session observer. No
paid-model inference was made.

## Delegation-First Live-Wiring (2026-09-15 — this change)

**Status: COMPLETE.** The previously-unwired delegation-first runtime, ladder, watchdog, and
grunt-guard are now connected to the real OpenCode execution path. Plan:
`.omo/plans/20260915-delegation-live-wiring.md`; evidence:
`.omo/evidence/20260915-delegation-live-wiring/evidence.txt`.

Wiring points (all landed on `feature/dynamic-subagent-model-routing`):

- **Managers**: `create-managers.ts` now constructs `delegationFirstRuntime` from the
  resource-governor `delegation_ladder` + `watchdog` config, computes `pricingCatalog` once,
  starts a periodic `checkAllWatchdogs` sweep (`stopWatchdogSweep`), and attaches/detaches the
  watchdog on `onSubagentSessionCreated` / `onSubagentSessionDeleted`. Cleanup on shutdown.
- **Task tool**: `tools/delegate-task/tools.ts` sync path now runs `runDelegationFirstSync` when a
  `delegationFirstRuntime` is present. New `sync-adequacy.ts` (`judgeSyncAdequacy`) provides
  deterministic empty/truncated/failure detection. `types.ts` accepts `delegationFirstRuntime?` +
  `pricingCatalog?`.
- **Free-first selection**: `features/delegation-first/free-worker-candidates.ts`
  (`buildDelegationWorkerCandidates`) orders workers free-before-paid/cheapest-first and always
  retains the resolved model; unknown-price models are never classified free.
- **Watchdog feed**: `plugin/event.ts` feeds per-child-session progress events into
  `onToolActivity`; `plugin/tool-execute-after.ts` feeds root tool activity into the grunt-guard
  detector for non-subagent sessions.
- **Event catalog**: audit events include `delegation_first_selected`, `worker_attempt_inadequate`,
  `worker_prompt_refined`, `worker_model_escalated`, `worker_worker_done` (+ watchdog
  `*_start/end/terminal/health`).

Verification (all green): `tsgo --noEmit -p packages/omo-opencode/tsconfig.json` clean; 50 feature
tests (`delegation-first` incl. new `free-worker-candidates.test.ts`, `delegation-ladder`,
`worker-supervisor`, `grunt-guard`), 695 delegate-task/resource-governor/config/audit tests, 48
plugin/manager tests; new `delegation-first-integration.test.ts` (2 tests) proves the real
`task` tool reaches delegation-first, refines a weak result, escalates the model, and preserves
findings with zero worker output reaching the journal. `bun run build` succeeds; `dist/index.js`
contains `buildDelegationWorkerCandidates`, `createDelegationFirstRuntime`, `runDelegationFirstSync`,
`judgeSyncAdequacy`, `checkAllWatchdogs`, `onToolActivity`, `delegation_first_selected`,
`worker_model_escalated`; smoke-import of `dist/index.js` succeeds.

**Known pre-existing flakiness (not introduced here):** `sync-poll-timeout.test.ts` and the
`resource-governor-integration.test.ts` "blocked child" case flake under full-suite CPU load
(observed identically on a clean tree via `git stash`). Both pass in isolation and in the first
combined run.

## Early Delegation / Pre-Grunt Gate (2026-09-15)

**Status: COMPLETE.** The previously post-hoc root grunt-guard (advisory `root_direct_exception`
from `tool.execute.after`) is now a live EARLY gate on the real `tool.execute.before` path. Commit
`feat(delegation): enforce early free-worker delegation`.

**Problem addressed:** the delegation machinery existed but real Sisyphus still crawled the repo
itself before delegating (TUI showed `A(0; $0.00)` while MAIN read Android files, grepped methods,
and listed server routes/migrations). The guard only warned after the crawl had already happened.

**Runtime interception point:** `plugin/tool-execute-before.ts` now calls
`delegationFirstRuntime.preGruntCheck(sessionID, tool, hint, contextPressure)` for every root
(non-subagent) tool call. When the gate classifies the call as broad delegable exploration it
`throw`s a steering message, which surfaces to MAIN as a tool error that instructs it to delegate
to a free worker (`task` with `subagent_type "explore"`/`"librarian"`) and consume the returned
file/symbol/anchors. The existing `task`/`call_omo_agent` path (unchanged) is what actually
dispatches the worker; the gate only stops/redirects.

**Allowed root exceptions (never blocked):** any tool outside the search/read set — git status / one
narrow grep / one small known-file read / edit / write / `session_list` / `session_info` /
official orchestration calls. An anchored `read` carrying numeric `offset` + `limit` is treated as
selective verification and allowed (recorded as `selective_root_verification`).

**Trigger policy (conservative, fires early):** a rolling per-session window of search/read tool
activity is classified by three signals, any of which blocks:

- cross-module exploration (>= 2 module roots and >= 3 grunt ops),
- search -> read -> search sweep (>= 2 distinct targets),
- weighted grunt count >= threshold (default 4; context pressure lowers it by up to 2).

A delegation tool (`task`/`call_omo_agent`) resets the window and emits
`early_delegation_dispatched`. Context Governor pressure (from
`hooks.contextGovernor.diagnose().measured_context_tokens`) strengthens the bias without waiting
for a large root budget. Unknown-price models are never hinted free.

**Live dispatch behavior:** the gate does not spawn a second framework — it records
`root_grunt_pattern_detected` + `early_delegation_required` (with `free_worker_hint` derived from
the OpenGateway pricing catalog via `discoverFreeModels`) and steers MAIN into the existing `task`
tool, which already runs free-first worker selection (`buildDelegationWorkerCandidates`).

**Tests:** new `grunt-guard/gate.test.ts` (10) + `delegation-first/pre-grunt-gate.test.ts` (3) prove:
one tiny lookup allowed; one anchored read allowed; broad search/read triggers; cross-module
triggers; the gate acts before many ops accumulate (threshold 4, not 10-20); the gate invokes the
existing runtime; a free worker is hinted first; a worker result/next delegation resets the gate;
MAIN can selectively verify anchors; high context pressure strengthens delegation; a low-context
fresh task still delegates via search->read->search; unknown-price is never free. Existing
`delegation-first` e2e, `delegation-ladder`, `worker-supervisor`, and `grunt-guard` regressions stay
green; watchdog remains metadata-only; Resource Governor backstop and disabled providers remain
enforced (unchanged, covered by existing suites).

**Runtime evidence:** `.omo/evidence/20260915-early-delegation-gate/evidence.txt`. No paid-model
inference was made (the catalog has 0 free models live; free selection was proven with injected
pricing). `tsgo --noEmit` clean; `bun run build` succeeds; `dist/index.js` contains
`preGruntCheck`, `createPreGruntGate`, `evaluateEarlyDelegation`, `analyzeGruntSignals`, and the four
new audit-event names; `dist/index.js` smoke-imports with `{ id, server }`.

**Limitations:** the gate steers via a tool-error message — it cannot force a model call; a
pathological model could ignore the steering and keep retrying. Broad exploration is therefore
redirected, not hardware-prohibited. The post-hoc `root_direct_exception` feed (unchanged) still
records every completed crawl for observability. OpenCode TUI is not modified; real child execution
(not any write to OpenCode accounting) is what makes `A` non-zero.

## Context Governor — Live Runtime Wiring (this change)

**Status: Context Governor is now default-enabled and wired into the live normal-session hook path.**
Commit `fix(context-governor): enable and wire governor into live OMA runtime`.

A live diagnostic proved the Context Governor was previously **inert** in real sessions:
`context_governor.enabled = false`, no `GovernorSessionState`, no token measurement, no threshold
calculation, no assessment, no compaction loop. Three independent omissions caused it:

1. `ContextGovernorConfigSchema.enabled` defaulted `false`.
2. The top-level `context_governor` key was `.optional()` and the hook gated on
   `cfg?.enabled === true`, so an absent key resolved to disabled.
3. `createContextGovernorHook` was never registered in the live composer.

All three are fixed:

- **Default enabled:** `enabled` now defaults `true`; `DEFAULT_CONTEXT_GOVERNOR_CONFIG` is exported
  and resolved via `resolveConfig()` (`pluginConfig.context_governor ?? DEFAULT_CONTEXT_GOVERNOR_CONFIG`),
  so an absent key still enables the governor and an explicit `enabled: false` still disables it.
- **Live wiring:** registered in `create-session-hooks.ts` (`contextGovernor`), dispatched in
  `event-hook-dispatcher.ts` (`hooks.contextGovernor?.event`) and `tool-execute-after.ts`
  (`hooks.contextGovernor?.["tool.execute.after"]`).
- **Token measurement:** `message.updated` → `GovernorSessionState.lastUsedTokens`; `tool.execute.after`
  → `getContextWindowUsage` (authoritative runtime token signal) → `resolveEffectiveThresholds` →
  `evaluateGovernorDecision`.
- **Visible decision events:** `onEvent` emits one concise structured `[context-governor]` event per
  assessment with operational classifications `distill` / `audit` / `compact` / `expansion` / `defer`,
  plus `enter_expansion` on lease grant (example: `{ context, preferred, decision, reason, target,
  compressible, reassess }`).
- **Expansion reassessment:** state tracks `entered_at_tokens`, `next_reassessment_tokens`,
  `turns_since_assessment`, `last_assessment`; expansion schedules reassessment instead of running
  indefinitely.
- **Convergent compaction:** `performSummarize` loops up to `max_compaction_passes` (default 3),
  re-measuring after each pass and stopping early on target reached or poor pass value (no blind
  triple-compact).
- **Type-drift fix:** removed the invalid `auto: true` from the `summarize` body (v1 SDK body is
  `{ providerID; modelID }`). `tsgo --noEmit` is now fully clean (was 1 error at
  `context-governor/index.ts:218`).

Resource Governor enforcement is unchanged and independent: `create-managers.test.ts` proves the
resource governor runtime is built regardless of `context_governor` presence/enabled/disabled, and
`Context Governor failure must NOT disable Resource Governor enforcement` holds structurally (the
Resource Governor lives in `create-managers.ts`, outside the hook tier, and every hook is wrapped in
`safeCreateHook` / `runEventHookSafely`).

Full evidence: `.omo/evidence/20260915-context-governor-wiring/` (README.md + captured runtime
validation output). No paid-model E2E was run (per task constraint); validation used lowered
thresholds in an isolated in-process client.

## Governance Audit Journal — persistent zero-token runtime record

**Status: the Context Governor and Resource Governor now persist a durable, zero-model-token
audit journal of every runtime decision.** Commit `feat(governance): persist zero-token runtime
audit journal` (pending).

Before this change the governors acted but left no durable record: the Context Governor's
decision lines (`wakes.ndjson`) and lease/verdict entries land under the *project*
`.omo/context-twin/`, which does not survive OpenCode restart cleanly and is not OMA-owned
runtime state. The new journal is a single source of truth for governance decisions, stored
outside the repository and outside the OpenCode data dir.

- **Location:** `~/.omo/governance/<base64url(session-id)>/events.jsonl` (one newline-delimited
  JSON object per event). Directory segment is base64url-encoded so a raw session id can never
  be a path segment (traversal/reserved-char defense); the raw id is still recorded verbatim in
  every `session_id` field. Overridable via `OMO_GOVERNANCE_DIR` (QA sandboxes / tooling) or an
  explicit `root` option (tests / DI).
- **Zero model tokens, no secrets:** events are serialized directly from runtime values handed to
  `write`; the writer makes no model call and never asks an agent to report its own state. A
  defensive sanitizer strips sensitive top-level keys (`prompt`, `messages`, `output`, `content`,
  `text`, `transcript`, `response`, `api_key`, `secret`, `password`, `authorization`, `auth`,
  `credentials`, `reasoning`, `chain_of_thought`, `cot`, etc.) before any line reaches disk.
- **Deterministic TS/Node file I/O:** `appendFileSync` (O_APPEND) + per-session serialized promise
  queues (no interleaved/corrupted lines across parallel workers); directories `0700`, files
  `0600`; a writer failure is log-and-drop (never throws into a live session).
- **Retention bounds:** age / session-count / per-file byte caps (defaults `max_age_days=30`,
  `max_sessions=100`, `max_file_bytes=5 MiB`) swept once per writer construction; targets only
  data under the governance root.

Events persisted:

- **Context Governor** (`subsystem: "context_governor"`): `session_init`, `assessment`
  (with `context_tokens`, `preferred_tokens`, `effective_target_tokens`, `decision` =
  `none|distill|audit|compact|expansion|defer`, `reason_code` = decision kind), `enter_expansion` /
  `continue_expansion` / `exit_expansion`, `classification`, `twin_failure`, `measurement_failure`,
  `compaction_started` / `compaction_pass` (per-pass `before_tokens`/`after_tokens`) /
  `compaction_complete` (`stop_reason`, `pass_count`, `after_tokens`) / `compaction_failed`, and
  `session_shutdown`.
- **Resource Governor** (`subsystem: "resource_governor"`): `resource-plan-created`,
  `routing-free-preferred`, `cost-gate-approved`, `resource-hard-limit`, `cost-gate-blocked`,
  `duplicate-work-prevented`, `child-escrow-settled`. (`declined` intentionally emits nothing.)

Wiring:

- New module `packages/omo-opencode/src/shared/governance-audit/` (`paths.ts`, `retention.ts`,
  `audit-writer.ts`, `index.ts`), barrel-exported from `shared/index.ts`.
- `create-session-hooks.ts` passes `audit: createGovernanceAuditWriter({})` into the Context
  Governor hook; `create-managers.ts` builds one writer (gated on `resource_governor.enabled`) and
  passes it into the Resource Governor runtime. Two writer instances share one stateless
  append-only facade, so they are equivalent.
- `context-governor/index.ts` gained an optional `audit` dep plus an `auditEvent(...)` helper and
  an `audit_journal_path` field in the live diagnostic. `resource-governor/runtime.ts` gained
  `emitPlanEvent` + `audit` on `emitDecisionEvent`/`settleChild`.

Tests (all green): `audit-writer.test.ts` (writer, path, permissions, retention, sanitization,
order, resume, non-throw) + `audit-journal.test.ts` (governor-level: assessment, enter/continue
expansion, compact + effective target, multi-pass `compaction_pass`, convergence stop reason,
cross-instance resume, privacy, lifecycle, diagnostic path, behavior-unchanged without `audit`).
`tsgo --noEmit` clean; `bun run build` succeeds; `dist/index.js` contains the module.

No paid-model inference was made (per task constraint). Validation used lowered thresholds in an
isolated in-process client against the real hook code.

## Implementation Summary

**Overall status: enforcement complete across every child-launch surface; Subagent Supervisor (Part 7) implemented and tested. Accounting observation hooks, consent UI, and forecast/HUD wiring remain partial.**

The Resource Governor is no longer a pure-but-inert module. The pure decision core is
complete and tested, a per-session runtime bridge sits in the real execution paths, and the
"no OMA child dispatch may bypass enforcement" invariant now holds across **every** child
launch surface: the `task` (delegate-task) tool, the `call_omo_agent` tool, and
`BackgroundManager.launch` (which carries background-task tooling, team-mode member spawns,
atlas subagents, and Context Twin workers). The governor is **enabled by default**
(`resource_governor.enabled` defaults `true`); an explicit `enabled: false` still disables it.

A new **Subagent Supervisor / Worker Watchdog** feature now supervises active children with
cheap deterministic signals and intervenes on a bounded ladder, and its
reclaim-then-replace cycle is itself bounded by the Resource Governor's hard ceilings.

| Capability | Status |
|---|---|
| Pure decision core (governor/budget/pricing/routing/escrow/ledger/duplicate/review/forecast/account/events) | complete, tested |
| Config schema (`resource_governor` block, enabled by default) | complete + wired into root schema |
| Pricing discovery from bundled catalog (`loadPricingCatalog`) | complete |
| Per-session runtime bridge (ledger + escrows + enforce) | complete |
| Real child-dispatch enforcement in `task` tool | complete (sync + background + category + subagent_type + model_tier + nested) |
| Real child-dispatch enforcement in `call_omo_agent` | complete (sync + background) |
| Real child-dispatch enforcement in `BackgroundManager.launch` | complete (background-task, team-mode, atlas, Context Twin) |
| Dispatch backstop (fail-closed proof at `session.create` boundary) | complete (`backstop.ts` + threaded through all three governed surfaces) |
| Hard paid / hard token ceiling block dispatch | complete + tested |
| Free-worker passthrough / duplicate prevention / max concurrency / escalation consent decision | complete (decision core) |
| Subagent Supervisor (worker watchdog: classify / intervene / loop-detect) | complete, 15 tests |
| Replacement-budget bound (RECLAIM → governor re-dispatch gate) | complete, 2 tests |
| Root token snapshot accounting hook | not built (OpenCode SDK exposes no token-usage signal; estimate-only would mislead) |
| Child escrow settlement on completion | complete (escrowID captured in `launch`; idempotent settle at 4 terminal points) |
| Cost-escalation consent path | complete (no self-approval + bounded escalation `approveEscalation`/`increaseBudget`, tested in `consent.test.ts`); no human-facing approval tool |
| Structured-event emission | complete (`onEvent` → structured `[resource-governor]` log) |
| Task-start forecast | complete (`planFromDelegation` derives difficulty + establishes plan in `enforce`; per-child `expectedTokens` preserved) |
| End-of-run HUD | not wired (`renderHudStatus` complete + tested; no session-completion driver) |

## Starting State

- Repository: `/srv/dev/oh-my-openagent` (oh-my-opencode / oh-my-openagent).
- Branch: `feature/dynamic-subagent-model-routing`.
- Starting commit (HEAD): `5659c231c` — "feat(context-governor): complete decision core, capsule envelope, and hook wiring".
- Other worktrees present (not touched): `spawn-display-tier-model-persona`, `feature/context-governor`.
- On recovery the Resource Governor pure-core suite was **63 pass / 7 fail**; the 7 failures
  were real bugs (duplicate tokenization, hard-ceiling ordering, paid-blocked/consent
  handling, child-ledger accounting, low-difficulty forecast seed). All fixed.

## Git State (current)

- Branch: `feature/dynamic-subagent-model-routing` (unchanged).
- Commits: none created this session. QA evidence (harness self-check + unit/typecheck
  verification + isolation proof) is recorded under
  `.omo/evidence/20260914-resource-governor/README.md`. The paid-inference drive that would
  exercise a live `task`/`call_omo_agent` delegation is stopped per the plan ("if it genuinely
  requires paid spend, stop and explain"); no provider call was made.

Files changed/added across Parts 1–7:

- Modified (tracked):
  - `packages/omo-opencode/src/config/schema/oh-my-opencode-config.ts` (added `resource_governor`)
  - `packages/omo-opencode/src/create-managers.ts` (build runtime + wire authorizer into BackgroundManager)
  - `packages/omo-opencode/src/plugin/tool-registry-core-tools.ts` (pass runtime into tool factories)
  - `packages/omo-opencode/src/features/background-agent/manager.ts` (launch-time authorization)
  - `packages/omo-opencode/src/tools/call-omo-agent/tools.ts` (sync authorization)
  - `packages/omo-opencode/src/tools/call-omo-agent/sync-executor.ts` (backstop threading)
  - `packages/omo-opencode/src/tools/call-omo-agent/session-creator.ts` (backstop assert)
  - `packages/omo-opencode/src/tools/delegate-task/tools.ts`, `types.ts` (runtime injection)
  - `packages/omo-opencode/src/tools/delegate-task/sync-task.ts`, `sync-session-creator.ts` (backstop threading + assert)
  - `packages/omo-codex/scripts/install-dist/install-local.mjs` (rebuilt bundle)
  - five `packages/omo-senpi/plugin/extensions/*` (rebuilt bundles)
- Untracked (new):
  - `packages/omo-opencode/src/config/schema/resource-governor.ts`, `resource-governor.test.ts`
  - `packages/omo-opencode/src/hooks/resource-governor/` (modules + tests, incl. `runtime.ts`, `authorize.ts`, `backstop.ts`, `backstop.test.ts`, `replacement-budget.test.ts`)
  - `packages/omo-opencode/src/features/worker-supervisor/` (Part 7: 8 modules + 1 test)
  - `packages/omo-opencode/src/tools/delegate-task/resource-governor-integration.test.ts`
  - `packages/omo-opencode/src/tools/call-omo-agent/sync-enforcement.test.ts`
  - `packages/omo-opencode/src/features/background-agent/resource-governor-launch-enforcement.test.ts`

Intended commit grouping (for the QA-gated follow-up):

- `fix(resource-governor): correct duplicate detection, hard-ceiling ordering, child ledger accounting`
- `feat(resource-governor): runtime bridge + enforcement in task, call_omo_agent, BackgroundManager.launch`
- `feat(resource-governor): enable by default; add subagent supervisor (PART 7)`
- `test(resource-governor): runtime/integration/launch/replacement-budget coverage`

## Architecture

The Resource Governor has three cooperating "cops" over one shared ledger:

- **Context Cop** = the existing `context-governor` (context pressure, expansion mode,
  Continuity Capsule, compaction, rehydration). Preserved; not modified this session.
- **Token / Cost Cop** = `budget.ts`, `pricing.ts`, `ledger.ts`, `escrow.ts`.
- **Delegation Cop** = `governor.ts`, `routing.ts`, `duplicate.ts`, `review.ts`.

- **Shared Resource Ledger** = `ledger.ts` `ResourceLedger` + `computeTotals`, owned by the
  `createResourceGovernor` facade so root and every child land in one accounting surface.

Runtime bridge: `runtime.ts` (`createResourceGovernorRuntime`, one governor per session) +
`authorize.ts` (`authorizeChildDispatch`, the single path-agnostic verdict) +
`loadPricingCatalog` (real pricing discovery).

## Runtime Integration (enforcement choke points)

One shared `ResourceGovernorRuntime` is built in `create-managers.ts` when
`resource_governor.enabled` (default `true`). It feeds three enforcement sites:

1. **`task` (delegate-task)** — `createDelegateTask.execute` calls `enforceResourceGovernor`
   after model resolution and before the background/sync branch.
2. **`call_omo_agent`** — `authorizeSyncChild` blocks sync dispatch before reserving a spawn
   slot and settles the escrow on completion; background dispatch flows through
   `BackgroundManager.launch`.
3. **`BackgroundManager.launch`** — a constructor-injected `authorizeChildDispatch` runs before
   `session.create`, throwing `ResourceGovernorRejectedError` on `BLOCK`/`REQUIRE_CONSENT`.
   This single choke point also covers team-mode member spawns, atlas subagents, and Context
   Twin workers, since they all launch through `BackgroundManager`.

Enforcement is fail-through on unavailable data: no runtime, no resolved model id, or
`resolvedModelID === null` → `enforce` returns `null` → dispatch proceeds unchanged. The
`activeChildCount` is fed from `backgroundManager.getTasksByParentSession`, so
`max_concurrent_children` reflects live running/pending children.

**Hard ceilings are unconditional in the decision core**: nothing in a request (model hint,
"important" role, expected value) can override `RESOURCE_BUDGET_EXHAUSTED` /
`TOKEN_BUDGET_EXHAUSTED`. Only a human budget increase (updated `levels`) or explicit consent can.

## Subagent Supervisor / Worker Watchdog (PART 7)

New feature in `packages/omo-opencode/src/features/worker-supervisor/`:

- `types.ts` — `WorkerSignal` (cheap observation snapshot), `WorkerHealth`, `SupervisionPolicy`,
  `DEFAULT_SUPERVISION_POLICY` (paid workers supervised more strictly than free).
- `classify.ts` — static single-check classification (`HEALTHY`, `QUIET_STALL`, `TOKEN_BURN`,
  `LONG_RUNNING`, `WEDGED`, `BUDGET_WARNING`, `EXHAUSTED`, `STARTING`); `isInsecure`.
- `progress.ts` — `progressFingerprint`, `isMeaningfulProgress`.
- `supervisor.ts` — stateful facade; multi-check **loop detection** (fingerprint unchanged while
  `tokensDelta`/`toolCallsDelta` keep rising across `loopChecks` checks); ladder state
  (`insecureChecks`, `nudgesSent`, `alreadyReclaimed`); event stream.
- `intervention.ts` — bounded ladder `OBSERVE → STATUS_REQUEST → NUDGE → RECLAIM`. First
  insecure check requests status (not immediate reclaim); `maxInsecureChecks` escalates to
  reclaim; partial work preserved.
- `events.ts` — `SUPERVISION_EVENTS` structured names.
- `index.ts` — barrel.

**Replacement is root-driven, not generated by `nextIntervention`** (the ladder tops out at
`RECLAIM`). A replacement re-dispatch must pass back through `authorizeChildDispatch`, so a
reclaim→replace cycle cannot spend past the hard ceiling (pin by `replacement-budget.test.ts`).

## Dispatch Backstop (FAIL-CLOSED at the shared execution boundary)

A new fail-closed layer guarantees that **no child launch reaches the shared low-level
execution boundary (`client.session.create`) without a governor-minted one-shot proof**, and
that the exact launch reaching execution has not drifted from the launch the governor
authorized. This closes the gap where enforcement runs "upstream" but nothing independently
asserts the launch that actually executes still matches the authorized decision.

Components in `packages/omo-opencode/src/hooks/resource-governor/backstop.ts`:

- `ChildLaunchGuard` — in-process registry of issued-but-unconsumed proofs plus a consumed
  tombstone set. A proof token is a random UUID recorded only by `issue`; it cannot be forged
  in-process. `assertAndConsume` throws `ResourceGovernorBackstopError` on any of: missing
  token, unknown token, already-consumed token, parent-session mismatch, worker-identity
  mismatch, or resolved-model mismatch.
- `ChildLaunchAuthorization` — the one-shot proof (`token`, `sessionID`, `workerIdentity`,
  `resolvedModelID`, `escrowID`, `issuedAt`).
- `resolvedModelKey(providerID, modelID)` — the single canonical resolved-model string used by
  every mint site AND every redeem site, so the authorization binding and the post-execution
  assert derive byte-identical strings. Empty string when no model is resolved.
- `assertAuthorizedChildLaunch(backstop, expected)` — shared assertion. When `backstop` is
  `undefined` (governor disabled), it passes through unchanged (matching
  `resource_governor.enabled: false` semantics). When present, it FAILS CLOSED.

Mint/threading (authorization is minted on ALLOW in `authorize.ts`; `runtime.ts` owns the
`launchGuard`; every governed surface threads the `{ guard, token }` bundle to its
`session.create` boundary and redeems it immediately before creating the child session):

- `BackgroundManager.launch` → `startTask` asserts before `client.session.create`
  (`manager.ts`, `create-managers.ts` injects `launchGuard`).
- `task` sync path: `tools.ts` → `sync-task.ts` → `sync-session-creator.ts` (asserts before
  `session.create`). The fallback-model retry inside `sync-task-runner.ts` is deliberately NOT
  threaded: it is a pre-existing ungoverned fallback and the primary proof is already consumed.
- `call_omo_agent` sync path: `tools.ts` (`authorizeSyncChild`) → `sync-executor.ts` →
  `session-creator.ts` (asserts only in the create-new branch; `session_id` continuation is not
  a new launch). Background path flows through `BackgroundManager.launch`.
- `subagent-session-creator.ts` is dead (only imported by its own test); not threaded.

The backstop reintroduces **no policy**: it only proves the launch reaching execution is one the
governor already authorized, unchanged. There is no bypass flag.

## Root Accounting / Child Escrow

- Primitive: `createResourceGovernor.recordRootUsage(record)`; runtime
  `createResourceGovernorRuntime.recordRootUsage(sessionID, usage)` seeds the session governor.
- Escrow: on `approved`/`consent_required`, `createEscrow` stores a `ChildEscrow`; `recordChildUsage`
  updates usage; `settleChild` flips status.
- **Child settlement (wired):** `authorizeLaunch` returns the escrow id on `ALLOW`;
  `BackgroundManager.launch` stores it keyed by task id; `settleTaskEscrow` settles idempotently
  (map-delete guards against double-count) at four terminal points — `tryCompleteTask`
  (`"completed"`), `handleSessionErrorEvent` (`"failed"`), the stale-task prune (`"failed"`), and
  `failCrashedTask` (`"failed"`). `create-managers.ts` wires `settleChildDispatch` →
  `runtime.settleChild`, so `active_child_count` and the child ledger stay accurate.
- **Root accounting (not built):** no hook observes real root token snapshots because the OpenCode
  SDK exposes no token-usage signal to plugins. A zero/estimate observation would mislead the
  cost comparison, so it is left unwired rather than fabricated.

## Pricing / Model Discovery

- Source: `packages/omo-opencode/src/features/opengateway-provider/opengateway-models.json`
  (USD per 1,000,000 tokens per bucket). `loadPricingCatalog()` builds the `PricingCatalog`.
- Free detection: `isFreePricing` (all buckets zero); `discoverFreeModels`; unknown models are
  treated conservatively as **paid**, never assumed free (`isFreePricing(undefined) === false`).

## Routing / Budgets

- Cheapest-sufficient + free-first `selectWorker`; bounded-failure escalation
  `recommendPaidEscalation`; risk-based `decideReview` (decision core). Duplicate-work
  prevention `checkDuplicate` short-circuits at the top of `evaluateDelegation`.
- Budget modes seed defaults only; soft pressure `normal/elevated/high/critical/exhausted`;
  hard paid (`RESOURCE_BUDGET_EXHAUSTED`) and hard token (`TOKEN_BUDGET_EXHAUSTED`) ceilings.
- **Limitation at runtime:** dispatch offers only the single already-resolved model, so
  free-first *re-selection* is not performed at dispatch (active in pure core + unit-tested).

## Observability

- `RESOURCE_GOVERNOR_EVENTS`, `RESOURCE_BUDGET_EXHAUSTED`, `renderResourceAccount` /
  `renderHudStatus` exist and are tested.
- **Event emission (wired):** `create-managers.ts` passes `onEvent` to
  `createResourceGovernorRuntime`; every enforcement decision emits a structured
  `[resource-governor] {event}` log line (`routing-free-preferred`, `cost-gate-approved`,
  `resource-hard-limit`, `cost-gate-blocked`, `duplicate-work-prevented`) with `sessionID` +
  decision detail. Logged, not user-facing, so no hook spam.
- **Not wired:** end-of-run Resource Account / HUD rendering (no session-completion hook driver).

## Tests

Current results (all green):

| Suite | Result |
|---|---|
| `bun test packages/omo-opencode/src/hooks/resource-governor/` | 112 pass / 0 fail (15 files) |
| `bun test packages/omo-opencode/src/features/worker-supervisor/` | 15 pass / 0 fail (1 file) |
| `bun test packages/omo-opencode/src/features/background-agent/` | 771 pass / 0 fail (65 files) |
| `bun test packages/omo-opencode/src/tools/delegate-task/` | 510 pass / 0 fail (45 files) |
| `bun test packages/omo-opencode/src/tools/call-omo-agent/` | 70 pass / 0 fail (13 files) |
| `bun test packages/omo-opencode/src/config/schema/` | 46 pass / 0 fail (12 files) |
| `bun run typecheck` | 1 pre-existing error (see below) |

Key new tests:

- `runtime.test.ts` (14 tests), `resource-governor-integration.test.ts` (2),
  `replacement-budget.test.ts` (2), `sync-enforcement.test.ts` (1),
  `resource-governor-launch-enforcement.test.ts` (4), `resource-governor.test.ts` (schema, 3),
  `forecast.test.ts` (7), `consent.test.ts` (3), `supervisor.test.ts` (15),
  `backstop.test.ts` (15: happy path, missing/unknown/already-consumed token, session/worker/model
  mismatch, one-shot, nested, governor-disabled passthrough, mint→redeem).

Typecheck: fully clean for all Resource Governor + supervisor + Context Governor code. The former
pre-existing `context-governor/index.ts:218` error (invalid `auto: true` in the `summarize` body) was
fixed by this follow-up; `tsgo --noEmit` reports 0 errors.

## Enforcement Proof

The invariant "NO OMA CHILD DISPATCH MAY BYPASS RESOURCE GOVERNOR ENFORCEMENT" now holds for:

- `task` — `resource-governor-integration.test.ts` proves blocked dispatch does not reach
  `executeBackgroundTask`/`executeSyncTask`.
- `call_omo_agent` — `sync-enforcement.test.ts` proves a paid child past the ceiling is blocked
  before `reserveSubagentSpawn` is called.
- `BackgroundManager.launch` — `resource-governor-launch-enforcement.test.ts` proves `BLOCK` and
  `REQUIRE_CONSENT` both reject before `session.create`, with the resolved + root model ids
  forwarded; and that no authorizer is consulted when the governor is disabled.
- Replacement cycle — `replacement-budget.test.ts` proves a supervisor `RECLAIM` of an
  exhausted paid worker is followed by a paid replacement `BLOCK` at the hard ceiling, while a
  $0 replacement is `ALLOW`.
- Dispatch backstop — `backstop.test.ts` proves a launch reaching `session.create` without a
  proof (or with a consumed/unknown proof, or a session/worker/model drift) FAILS CLOSED, while
  a matching minted proof redeems exactly once and the disabled path passes through unchanged.

## Implementation Cost

- Paid models used: **none**. All work with the local `bun test`/`tsgo` runners.
- Estimated dollar spend: **$0**.

## Known Limitations

- Accounting approximations: cost is estimated from pricing metadata, not provider-reported
  dollars; exact per-session root token deltas are not observed (OpenCode SDK exposes no
  token-usage signal to plugins).
- Pricing coverage: only the bundled OpenGateway catalog; models outside it are treated as
  unknown/paid.
- Unenforceable token dimensions: hard child token/turn/context/output limits are recorded in
  the escrow but the OpenCode runtime does not enforce truncation at those limits.
- Consent has no human-facing tool: `REQUIRE_CONSENT` blocks (model cannot self-approve); the
  `approveEscalation`/`increaseBudget` escalation API exists and is tested, but no tool/command
  exposes it to a human yet.
- Free-first *re-selection* is not performed at dispatch (single resolved model only).
- End-of-run Resource Account / HUD rendering is not wired (no session-completion hook driver);
  the task-start forecast itself is wired (`planFromDelegation`).
- Historical forecast-multiplier feedback (`updateHistoricalMultiplier`) is pure + tested but not
  persisted/applied into future plans.
- `context-governor/index.ts:218` typecheck error is now FIXED (removed invalid `auto: true` from the
  `summarize` body); full `tsgo --noEmit` is clean.

## Rollback / Disable

- Disable: set `resource_governor.enabled: false` in `~/.omo/omo.jsonc`. With it off, the
  runtime is `undefined` and every enforcement site passes through unchanged. A plugin restart
  applies the change.
- Revert: nothing was committed; restore modified tracked files and remove new untracked files.

## Continuation Handoff

**Complete:** pure decision core; config schema (enabled by default); pricing loader; runtime
bridge; enforcement in `task`, `call_omo_agent`, and `BackgroundManager.launch` (all child
surfaces); hard ceiling/duplicate/consent/concurrency decisions; Subagent Supervisor (Part 7)
with loop detection and the intervention ladder; replacement-budget bound; child escrow
settlement (idempotent, wired to all terminal points); structured event emission; task-start
forecast (`difficultyFromExpectedTokens` + `planFromDelegation` + `establishPlan` wired into
`enforce`, with the per-child-`expectedTokens`-preservation bug fixed); consent path (no
self-approval + bounded escalation, tested); dispatch backstop (fail-closed proof at the shared
`session.create` boundary, threaded through `BackgroundManager`, `task` sync, and
`call_omo_agent` sync; tested in `backstop.test.ts`).

**Partially complete:** end-of-run Resource Account / HUD rendering (primitives exist, no
session-completion driver); historical forecast-multiplier feedback (pure + tested, not
persisted/applied); root accounting has no observer (SDK exposes no token signal).

**Remaining:**

1. Build a human-facing approval tool/command exposing `approveEscalation`/`increaseBudget`
   (the consent decision + bounded-escalation API are complete and tested; the invoker is not).
2. Perform free-first *re-selection* at dispatch (offer sufficient $0 catalog models as
   candidates).
3. Wire end-of-run Resource Account + HUD rendering (session-completion hook driver); persist +
   apply the historical forecast multiplier.
4. Root accounting: determine a correct root-usage source or leave unobserved (SDK exposes no
   token signal; do not fabricate an estimate).
5. Fix the pre-existing `context-governor/index.ts:218` typecheck error — DONE (this follow-up; also
   default-enabled and live-wired the Context Governor).
6. Run the paid-inference `opencode-qa` drive in an isolated XDG sandbox and create the logical
   commits (evidence for the non-paid surface is already recorded under
   `.omo/evidence/20260914-resource-governor/`).

**Exact next recommended task:** (1) + (2) — the human approval tool and free-first re-selection,
which close the remaining "cheapest-sufficient actually runs" and "bounded human escalation"
gaps. (Child settlement and the task-start forecast are now complete.)

**Exact next commands:**

```
bun test packages/omo-opencode/src/hooks/resource-governor/
bun test packages/omo-opencode/src/features/worker-supervisor/
node_modules/.bin/tsgo --noEmit -p packages/omo-opencode/tsconfig.json
```

**Files to inspect next:**

- `packages/omo-opencode/src/plugin/event.ts` (session lifecycle for accounting hooks).
- `packages/omo-opencode/src/hooks/resource-governor/runtime.ts` (extend the bridge).
- `packages/omo-opencode/src/tools/delegate-task/model-selection.ts` (free-first re-selection).

**Unresolved architecture decisions:**

- Whether to enforce via a uniform `tool.execute.before` hook vs. per-tool wiring (current
  approach; already covers all surfaces so this is now a consolidation question, not a gap).
- Root-model identity source for escalation consent when a session has no resolved parent model.

**Safe to use now:** yes, in a bounded sense — with `resource_governor.enabled` (default true),
all child-launch surfaces block paid dispatch past the hard ceiling and enforce
duplicate/consent/concurrency decisions; the Subagent Supervisor supervises active children.
Accounting is not yet automatic and consent has no UI. Treat as experimental.
