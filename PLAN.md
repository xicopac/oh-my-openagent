# OMO Stabilization Plan

Last updated: 2026-11-03 (Europe/Madrid)
Owner: Codex
Canonical base: `d4e2979b80de9d04768f380828bfca4b428276ae` (merged PR stack on `release/canonical-20261029`)
Implementation worktree: `/srv/dev/omo-canonical-release-rc-wt/fix/stabilize-slice-e-release-gate` (Slice E, based directly on the merged release head)
Production boundary: `/srv/dev/oh-my-openagent` remains untouched until the exact merged release-candidate commit passes every gate. The user has authorized a later atomic, rollback-capable deployment of that verified artifact only; production Git history must not be rewritten or synchronized.

## Objective

Remove the architectural causes of lost worker results, abandoned workers, missed parent wakes, inconsistent authorization, unauthorized paid dispatch, and source/artifact drift. Acceptance requires real isolated OpenCode runs with local fake providers; unit tests alone are never sufficient.

## Evidence already accepted as input

- `/tmp/omo-consolidation-audit.md`: overlapping lifecycle authorities and mutable production deployment.
- `/tmp/omo-canonical-release.md`: canonical source reconstruction and byte-identical bundle proof.
- `/tmp/omo-autonomous-recovery-repair.md`: demonstrated lifecycle defects and isolated runtime recovery runs.
- `/srv/dev/omo-guard-consistency-rc/.omo/evidence/20261030-guard-consistency/CHECKPOINT.md`: real-runtime guard false positive and `apply_patch` bypass.
- `/srv/dev/omo-canonical-preserve-20261029/`: preserved source and build provenance.
- Existing isolated worktrees and `.omo/evidence/` directories remain evidence; none may be deleted or rewritten.

These findings will not be re-investigated unless current source contradicts them or a focused regression needs a before/after reproduction.

## Target architecture

### 1. One delegation control authority

Create one policy-owning worker coordinator for admission, attempt state, deadlines, stall classification, retry, terminalization, and relaunch authorization. The background manager remains the OpenCode session/process executor. Watchdog and liveness components become signal producers only; neither may cancel, retry, terminalize, or wake a parent independently.

The coordinator owns the only legal state machine:

`DISPATCHED -> STARTING -> RUNNING -> COMPLETED | FAILED | CANCELLED | BLOCKED`

`STALLED` is an observation/recovery condition, not a second terminal authority. A terminal compare-and-set is idempotent and immutable.

### 2. Durable worker ledger and terminal outbox

Persist worker identity, assignment id, attempt id, parent id, child session id, selected model, authorization provenance, timestamps, bounded result/error, terminal outcome, and wake-delivery state before destructive cleanup. Session deletion and compaction are observations, not storage.

Every terminal transition writes one durable outbox record in the same logical operation. Parent wake delivery consumes that outbox idempotently. Startup reconciliation replays undelivered terminal records and classifies stale nonterminal records without duplicating completed work.

### 3. One retry/recovery episode

An assignment has one recovery episode and a bounded attempt sequence. The idempotency key is assignment + attempt. Recovery selects free eligible workers first, excludes quarantined workers, and never replays a completed attempt. Exhaustion terminalizes as `BLOCKED` and wakes exactly once.

### 4. One authorization decision function

All dispatch paths—sync task, background task, continuation, recovery relaunch, fallback, and resumed work—must call the same decision function with the effective model and pricing. Unknown cost is paid. Free dispatch is preferred. Paid dispatch requires an explicit, scoped, single-use approval. Missing state, missing price, missing registry, or unresolvable session authority fails closed. No path may switch model/provider after authorization without a new decision.

Tool authorization similarly uses one effect classifier independent of the transport/tool spelling. Equivalent read, mutation, test, delegation, and control operations receive the same decision through native, shell, interactive shell, or MCP paths. Opaque execution fails closed.

### 5. One process owner

Task process ownership is the only component allowed to terminate task-owned process groups/scopes. Cancellation asks it to release the exact task ownership record. It must never use broad process-name matching and must not affect unrelated processes.

### 6. Independent bounded supervision

A single unref'd timer owned by the coordinator evaluates deadlines independently of parent LLM activity. The timer performs metadata-only checks. It has a bounded cadence, no model calls, no recursive timers, and is stopped during disposal. Process/server restart is handled by durable startup reconciliation rather than a competing external recovery policy.

### 7. Reproducible release boundary

Git commit + lockfile + pinned Bun version are the source of truth. A release build requires a clean checkout and emits a manifest with commit, tool versions, artifact hash/size, evidence hashes, and rollback target. Deployment is a separate, explicitly authorized atomic switch to a versioned artifact directory. This project stops before that switch.

## Delivery slices and dependency order

### Slice A — Architecture baseline and authorization consistency

Files:

- `PLAN.md`, `STATE.md`, `TODO.md`: durable execution record.
- `docs/AGENTS.md`: route maintainers to the new reliability reference.
- `docs/reference/worker-reliability-architecture.md`: reviewed target architecture and invariants.
- `packages/omo-opencode/src/features/grunt-guard/classify.ts`: effect-equivalent classification; cover `apply_patch`, opaque tools, wrappers, substitutions, redirections, and unknown shell mutations.
- `packages/omo-opencode/src/features/delegation-first/root-worker-state.ts`: allow bounded legitimate diagnostics without permitting source mutation.
- `packages/omo-opencode/src/features/delegation-first/materialization-scope.ts`: recognize the real patch tool for approved durable evidence/plan paths only, without trusting caller assertions for source paths.
- `packages/omo-opencode/src/plugin/tool-execute-before.ts`: extract actual patch target(s) and pass normalized hints through the same authority.
- Focused colocated tests in the same modules plus `plugin/tool-execute-before.delegation.test.ts`.

Verification:

- Focused guard and plugin-hook unit tests.
- `tsgo --noEmit -p packages/omo-opencode/tsconfig.json`.
- Real isolated OpenCode 1.19.3 server/API run with local fake provider proving: `apply_patch` source mutation blocked, evidence-path materialization allowed only when policy permits, single-file diagnostics allowed, wrapped/opaque mutations blocked, child role allowed, production DB count unchanged, no orphan processes.

### Slice B — Durable terminal-result/outbox contract

Files expected after source confirmation:

- `features/background-agent/worker-record-types.ts`, `worker-record.ts`.
- `features/background-agent/attempt-lifecycle.ts`, `manager.ts`, `task-registry.ts`.
- `features/background-agent/parent-wake-*` modules.
- Background output/result formatting tools and focused tests.

Changes:

- Make terminal compare-and-set explicit and idempotent.
- Persist result and terminal outbox before session abort/delete.
- Replay only undelivered outbox entries on startup.
- Prevent retention cleanup from deleting the last durable result.

Verification:

- Focused lifecycle scope: 79 tests pass with terminal first-writer, monotonic wake state, cancellation-abort, duplicate ownership, retention, and restart cases.
- Real OpenCode normal completion: durable result precedes cleanup, the idle parent resumes without another human message, and output acknowledges the exact wake.
- Real OpenCode restart/deleted-child recovery: a 48-hour-old outbox replays, `background_output` retrieves the result, acknowledgement survives a second restart, and completed work is not repeated.
- Compaction-specific runtime proof remains in the wider Slice C/E matrix; Slice B does not claim that deferred scenario is complete.

### Slice C — Single supervision and bounded retry authority

Files expected after source confirmation:

- `features/delegation-first/runtime.ts` or a smaller extracted coordinator module.
- `features/worker-supervisor/*`.
- `features/worker-liveness-supervisor/*` reduced to signals or removed.
- `create-managers.ts`, `plugin/event.ts`, relevant background manager seams.

Changes:

- Route all timeout, empty-turn, disappearance, and process-exit signals into one coordinator.
- Remove cancel/retry/wake authority from secondary mechanisms.
- Define one bounded retry episode with assignment/attempt idempotency.
- Dispose the single timer and release process ownership deterministically.

Verification:

- Fake-provider stalls before first byte, mid-response, empty response, vanished session, retry success, retry exhaustion, cancellation, repeated unattended loops, restart reconciliation.

Implementation checkpoint (2026-11-01):

- Retain `worker-supervisor/watchdog.ts` as the sole live stall detector and `worker-supervisor/recovery.ts` as the sole retry-budget decision authority.
- Remove `worker-liveness-supervisor` from `createDelegationFirstRuntime`; its live integration currently mutates retry/block state and emits parent wakes despite being described as detector-only.
- Preserve vanished-child detection in `detachChildSession`, which already has the authoritative OpenCode session-deletion observation and routes bounded redispatch through the shared recovery coordinator.
- Make the independent `createManagers` sweep call only `reclaimStalled`; do not request process cleanup when reclaim declines, and do not duplicate cleanup after reclaim. Confirmed terminal cancellation remains the only path to `BackgroundManager` cleanup callbacks and exact task-owned process release.
- Add focused RED/GREEN coverage for one detector tick, exactly one reclaim/cancel, no cleanup on declined reclaim, no duplicate cleanup on accepted reclaim, and timer disposal.
- Prove the change through real isolated OpenCode provider-stall/recovery-exhaustion runs before commit; normal completion/restart durability remains covered by Slice B evidence.

Verification checkpoint (2026-11-01):

- Focused supervision/recovery/process-ownership scope: 86 tests pass, 0 fail, 311 assertions; scoped adapter typecheck exits 0.
- Candidate bundle: 2,163 modules, 6,564,676 bytes, SHA-256 `5404e1b2d36906b3f516435e721f1f64339d6b489b2ae5422fc41a5a906ebd50`; required assets materialize and the bundle imports successfully.
- Real provider-stall run: the first child stalled, one authorized free alternate completed, the durable terminal record reached `acknowledged`, and the parent produced `PARENT_RESUMED` without another human message.
- Real exhaustion run: both bounded free attempts stalled, the assignment terminalized `blocked`, the durable terminal record reached `acknowledged`, and the parent resumed with the terminal BLOCKED state without another human message.
- Both isolated runs used only configured local zero-cost fake models, left the real OpenCode DB at 2,351 sessions and the real worker ledger at 93 records, and stopped their exact OpenCode/provider processes.
- This slice intentionally does not claim the still-pending empty-response, explicit cancellation, compaction, repeated-loop resource, or unified paid-authorization matrix.

### Slice D — Unified dispatch authorization

Files expected after source confirmation:

- `tools/delegate-task/tools.ts`, background/sync execution modules.
- `features/delegation-first/recovery-relaunch-authorization.ts`, `recovery-relaunch.ts`.
- `paid-consent.ts`, `paid-worker-gate.ts`, and shared approval storage.

Changes:

- One effective-model authorization function for every initial/retry/fallback path.
- Free-first deterministic selection.
- Explicit single-use paid approval; no unapproved fallback or model switch.

Verification:

- Real fake-provider request ledger proves zero paid-route requests without approval and exactly one authorized request with synthetic approval; no real paid provider is contacted.

Implementation checkpoint (2026-11-01):

- Retain the existing host permission prompt and `PaidConsentRegistry` as the only source of explicit paid-worker approval; do not add a file-based or model-authored approval path.
- Add one final effective-model decision that treats missing pricing as paid, allows verified free models, and consumes an exact root/worker/model/task approval for paid or unknown-cost models.
- Invoke that decision from BackgroundManager's initial launch boundary and every background fallback attempt. Automatic recovery and fallback carry no approval nonce, so they may use only verified free models.
- Route sync initial dispatch through the same decision and add a free-only decision before every in-session prompt fallback or replacement-session fallback.
- Remove the recovery relaunch approval-file exception. A retained recovery candidate is automatically eligible only when catalog pricing or the retained worker record verifies it as free; paid recovery requires a new interactive operator approval and therefore fails closed in unattended recovery.
- Preserve Resource Governor escrow/backstop as the resource-budget authority after cost authorization; cost authorization and resource budgeting remain distinct checks at one launch boundary.
- Prove the boundary with focused RED/GREEN tests and real isolated OpenCode request ledgers for free fallback, unapproved paid/unknown fallback rejection, and one synthetic single-use paid approval. No real provider is contacted.

Verification checkpoint (2026-11-02):

- A single final `authorizeEffectiveModelDispatch()` decision now covers initial task dispatch, direct manager launches, background fallback, sync prompt fallback, sync replacement-session fallback, and recovery relaunch.
- Paid/unknown automatic fallback and recovery fail closed. Static recovery approval files no longer grant spending authority; only catalog or retained-record verified-free recovery proceeds unattended.
- Exact paid approval is bound to root, worker, effective model, and logical task and is consumed once. The Resource Governor receives that approval only for the same dispatch, so its older consent check no longer rejects a valid launch or creates reusable session consent.
- Final focused scope: 119 tests pass, 0 fail, 355 assertions; scoped OpenCode adapter typecheck exits 0.
- Candidate bundle: 2,163 modules, SHA-256 `c9efff12498a282b330db709154fea16997ac30faa94d7787547a527ad5079f0`; required assets materialize and the bundle imports successfully.
- Real OpenCode 1.19.3 proof on that exact bundle: free completion persisted an acknowledged terminal result and woke the idle parent; unattended paid dispatch made zero paid-model requests and created zero workers; synthetic explicit approval made exactly one paid-model request and one worker record.
- All runtime requests used local fake endpoints, the real OpenCode DB remained at 2,351 sessions, the real worker store remained at 93 records, and every exact test process stopped.

### Slice E — Runtime reliability gate and release reproducibility

Files:

- `package.json` plus a shared script helper: declare Bun `1.4.3` as the release toolchain and reject mismatched generator invocations before they can rewrite tracked outputs.
- `script/build.ts`, `script/build-codex-install.ts`, `script/build-service-auth.ts`, and the Senpi extension build entry: enforce the same exact Bun version at every tracked generator boundary.
- `packages/omo-codex/src/install/codex-cache-bins.ts` and cache-install tests: remove build-only cache-local `node_modules` after dependency installation and skill synchronization because Codex 0.166 rejects its npm shims and workspace symlinks before hooks execute.
- Focused toolchain and clean-build tests under `script/` and `packages/omo-senpi/plugin/scripts/`.
- Resource-bounded isolated runtime harness under repository test/script conventions.
- Release-candidate manifest/build verification helper and architecture/release documentation.

Changes:

- Preserve the integrated A-D stack exactly: PRs #1, #2, and #3 are merge commits on the release line; #4 is present exactly once through #3's tree-identical rewritten commits.
- Sequential fake-provider matrix, bounded timeouts, cleanup traps, process-leak assertions, DB isolation proof, and no real provider traffic.
- Regenerate only declared tracked artifacts with the CI-pinned Bun version; add a gate that starts and ends with a clean tracked tree.
- Preserve external command links through the installer-owned bin directory, but never expose build-only npm dependencies, shims, or workspace symlinks inside the plugin cache scanned by Codex.
- Make Senpi release tests hermetic to ancestor `/tmp/package.json` files by giving generated ESM fixtures their own module boundary; rerun the descriptor diagnostic at a non-starving bounded CPU quota because it passes unchanged outside the 25% whole-suite throttle.
- Emit a deterministic release-candidate manifest containing commit, Bun/Node versions, lockfile hash, artifact hash/size, evidence hashes, and an explicit rollback target. Production switching remains a separate post-merge operation.

Verification:

- Final combined scope: 386 tests / 1,425 assertions and scoped OpenCode typecheck.
- Real OpenCode 1.19.3 matrix on the exact merged bundle: guard policy, normal completion, free stall recovery, bounded BLOCKED exhaustion, restart/deleted-child replay, paid denial, and one synthetic explicit paid approval.
- The committed real-runtime matrix passes normal completion, free stall recovery, empty-response BLOCKED terminalization, running-child cancellation, in-flight compaction recovery, and three repeated unattended normal runs.
- Cancellation closes the worker-owned provider request without touching an unrelated sentinel. Every run leaves the real stores unchanged and exits without orphan processes.
- Repeated runs have bounded RSS, CPU, file descriptors, inotify watchers, wall time, and evidence growth.
- Two clean rebuilds from commit `eaba2c2de` leave the tracked tree unchanged and emit artifact SHA-256 `47949e129764ebc8748fd02fe3b1b2ebb7059a459d8cb726e9038960b635b969` with identical normalized manifest fields. The final merged commit receives a fresh manifest before deployment.

## Execution rules

- Work only in fresh task-owned worktrees based on the canonical release line.
- Use `GIT_MASTER=1` for every Git command.
- Do not touch `/srv/dev/oh-my-openagent` before the release PR is merged and its exact artifact is verified. Any authorized deployment must preserve the current artifact as a rollback target and must not rewrite production Git history.
- Never delete historical worktrees or original evidence.
- No real model/provider probes; fake local providers only.
- Heavy test suites run sequentially and only when package temperature is below 90°C. Stop immediately at or above 90°C.
- Every OpenCode-connected source change requires real isolated OpenCode QA and local evidence under `.omo/evidence/<slug>/` before commit.
- Evidence stays untracked. PR bodies include sanitized decisive excerpts and SHA-256 lines.
- Each slice is the smallest independently reviewable PR. Deployment is a separate final operation after the merged release candidate passes preflight and smoke checks.

## Separate housekeeping task

The fork's remote `dev` is an ancestor of the local production `dev` but is 6,429 commits behind it. This divergence is not part of worker stabilization and must not be repaired implicitly by a feature PR, force-push, production checkout mutation, or history rewrite. Track fork-history reconciliation separately, with its own review and explicit human authorization. Stabilization PRs may stack on the pushed `release/canonical-20261029` base after proving their merge base and diff contain only the intended slice.

## Milestone exit criteria

Milestone 1 exits when the architecture document, source trace, demonstrated root causes, and ordered PR slices are durable and reviewed.

Milestone 2 exits only when the core invariants above are implemented and every changed behavior has real runtime evidence.

Milestone 3 exits only when the full controlled-provider matrix passes repeatedly without human input, lost results, abandoned tasks, unauthorized paid routes, orphan processes, or resource growth.

Milestone 4 exits when a clean commit reproducibly builds a versioned artifact and rollback manifest. The user has explicitly authorized deployment of the exact merged, green artifact with atomic rollback; that operation remains separate from the PR.
