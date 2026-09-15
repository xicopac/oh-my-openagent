# OMA Resource Governor — Authoritative Report

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
