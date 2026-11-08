# OMO Stabilization Todo

Status markers: `[ ]` pending, `[>]` in progress, `[x]` complete, `[!]` blocked.

## Milestone 1 — architecture and root causes

- [x] Read the repository roadmap before touching source.
- [x] Read the `work-with-pr` and `opencode-qa` instructions and relevant OpenCode QA references.
- [x] Inspect canonical Git state, production boundary, existing worktrees, reports, preserved evidence, and unfinished guard candidate without modifying them.
- [x] Verify and stop the exact orphaned isolated QA server recorded by the guard checkpoint; verify no matching process remains.
- [x] Create a fresh task-owned worktree from canonical commit `4d1961c7e` without touching production.
- [x] Write `PLAN.md`, `STATE.md`, and this atomic todo list before any source edit.
- [x] Trace dispatch from the `task` tool through model selection, paid authorization, `BackgroundManager.launch()`, session creation, and `promptAsync`; record the authoritative and duplicate decision points in the architecture document.
- [x] Trace every terminal source (`session.idle`, `session.deleted`, assistant error/empty output, watchdog timeout, liveness signal, cancellation, restart reconciliation) to durable record, result capture, cleanup, and parent wake.
- [x] Trace sync-task execution separately and compare its authorization, persistence, retry, cancellation, and wake behavior with background execution.
- [x] Trace process ownership registration/cleanup and prove cancellation targets only task-owned scopes.
- [x] Write `docs/reference/worker-reliability-architecture.md` with current flow, defects, target ownership, invariants, migration sequence, and non-goals.
- [x] Update `STATE.md` with the complete call graph and Milestone 1 exit assessment.

## Slice A — authorization consistency

- [x] Check package temperature; testing resumed only after CPU package fell to 82°C and the hottest reported zone to 88°C.
- [x] Run the smallest existing guard/plugin test files as a baseline and capture output under `.omo/evidence/20261030-stabilize-guard/baseline/`.
- [x] Add a failing classifier test proving native `apply_patch` is classified as implementation, not control.
- [x] Add failing classifier tests proving unknown/opaque shell mutation, command substitution, process substitution, and unhandled wrappers fail closed.
- [x] Add failing classifier tests proving stderr suppression and read-only single-file diagnostics do not become mutation/broad work.
- [x] Add a failing root-state test proving one bounded specific-file diagnostic remains available in `worker_required` while `apply_patch`, source writes, test/build, and broad discovery remain blocked.
- [x] Add a failing plugin-boundary test proving root `apply_patch` is blocked and a registered worker `apply_patch` is allowed.
- [x] Add materialization tests proving patches to `.omo/evidence/`, `.omo/plans/`, `.omo/state/`, or `.omo/handoffs/` require policy authorization and source patches remain blocked.
- [x] Port only the useful shell-wrapper/selective-diagnostic behavior from `af1b246ee`; do not cherry-pick unrelated or unproven behavior wholesale.
- [x] Implement a normalized effect classifier for native tools, shell/interactive shell, and opaque paths with a fail-closed unknown default.
- [x] Implement patch-target extraction in the OpenCode hook so `apply_patch` reaches policy with concrete target hints.
- [x] Implement bounded diagnostic allowance without reopening broad exploration or mutation.
- [x] Re-run focused guard/plugin tests and capture the green output.
- [x] Run `tsgo --noEmit -p packages/omo-opencode/tsconfig.json` sequentially and capture output.
- [x] Check temperature again; post-typecheck CPU package reached 92°C, testing stopped, and resumed only after cooldown to 66°C.
- [x] Repair the existing isolated fake-provider harness to use `apply_patch` and bounded cleanup traps.
- [x] Run production-baseline and candidate scenarios sequentially against real isolated OpenCode with local fake provider.
- [x] Prove real DB session count is unchanged before/after, fake provider received no paid route, and no QA process remains.
- [x] Write reviewer-readable evidence summary and SHA-256 lines under `.omo/evidence/20261030-stabilize-guard/`.
- [x] Update `PLAN.md`, `STATE.md`, and `TODO.md` with observed behavior and remaining risks.
- [x] Commit documentation/plan, tests, and implementation in five atomic commits according to repository commit-count policy.
- [x] Push `fix/stabilize-omo-core` to the fork without altering production.
- [x] Push the canonical base and open reviewer-readable PR #1 against `release/canonical-20261029`; exact merge base is `4d1961c7e` and the diff contains only Slice A stabilization files.
- [x] Resolve CI and review findings with fresh QA for behavior-changing fixes.
- [x] Merge PR #1 into `release/canonical-20261029` with merge commit `876cff5e0`; do not update `dev` or deploy.

## Separate housekeeping — fork Git history

- [ ] Reconcile the fork's `dev` history in a dedicated future task. `origin/dev` is 6,429 commits behind local production `dev`; do not force-push, rewrite, synchronize, or mutate the production checkout as part of stabilization.

## Slice B — durable terminal result/outbox

- [x] Map the current record, terminalization, session-deletion, retention, wake dispatch, wake acknowledgement, and startup-recovery call paths without redoing the completed architecture audit.
- [x] Capture the smallest existing worker-recovery and parent-wake tests under `.omo/evidence/20261030-worker-ledger/baseline/` before source edits.
- [x] Add a RED worker-record test proving the first terminal transition wins and a late failed/cancelled/completed event cannot overwrite its outcome, result, event id, or attempt id.
- [x] Add a RED worker-record test proving terminal payload and a pending wake outbox entry are persisted in one synchronous commit.
- [x] Add RED state-transition tests proving pending -> dispatched -> acknowledged is monotonic, duplicate transitions are idempotent, and pruning requires acknowledgement.
- [x] Add a RED manager test proving completion captures and commits the result/outbox before child abort or deletion.
- [x] Add RED restart tests proving pending and unacknowledged dispatched outbox entries replay, while acknowledged entries do not.
- [x] Add a RED parent-output test proving an observed assistant/tool response acknowledges the exact worker wake instead of treating prompt dispatch as delivery.
- [x] Add a cancellation-abort regression proving a failed abort does not commit a provisional terminal outcome that blocks later truthful completion.
- [x] Add an admitted/dispatched ownership regression proving parent consumption acknowledges every coalesced worker debt.
- [x] Implement terminal compare-and-set and explicit durable wake-outbox fields in `worker-record-types.ts` and `worker-record.ts`, retaining backward reads of existing schema-1 records.
- [x] Make nonterminal persistence refuse to overwrite a terminal record and route every terminal path through the same compare-and-set helper.
- [x] Mark wake dispatch and acknowledgement separately; keep legacy notification timestamps read-compatible but stop using dispatch as delivery.
- [x] Replay only pending/unacknowledged terminal outbox records on startup without creating a replacement worker or repeating completed work.
- [x] Re-run the focused record/manager/wake test group sequentially and capture final GREEN output (79 pass, 0 fail, 319 assertions).
- [x] Run the scoped OpenCode adapter typecheck only below 90°C and capture output (exit 0).
- [x] Build the candidate with the resource-bounded single-entry bundle command and materialize required skill assets.
- [x] Run real isolated OpenCode fake-provider scenarios for normal completion, child-session deletion, restart replay, result retrieval, and parent idle wake without a human message.
- [x] Prove real DB count unchanged, fake free model only, bounded replay, exact process cleanup, and no orphan test process.
- [x] Freeze reviewer-readable evidence and SHA-256 manifest under `.omo/evidence/20261030-worker-ledger/`.
- [x] Update `PLAN.md`, `STATE.md`, and `TODO.md` with observed behavior and residual risks.
- [x] Commit Slice B in five atomic commits, verify exact merge bases and the 16-file intended diff, push the dependent branch, and open reviewer-readable PR #2.
- [x] Retarget PR #2 to `release/canonical-20261029`, revalidate its exact isolated delta/checks, and merge it as `61f887117`; no deployment.

## Slice C — single supervision authority

- [x] Inventory every timer/cancel/retry/wake owner and mark watchdog + recovery coordinator as the retained detector/decision authority.
- [x] Capture focused baseline tests for watchdog sweep, delegation runtime coordination, failover redispatch, and process ownership.
- [x] Add a failing create-managers test proving a declined reclaim never requests process cleanup.
- [x] Add a failing create-managers test proving an accepted reclaim relies on the manager terminal callback and does not request duplicate sweep cleanup.
- [x] Add a delegation-runtime regression proving watchdog inspection is read-only until one explicit reclaim produces one cancel, with no liveness-supervisor wake side effect.
- [x] Remove the live `worker-liveness-supervisor` integration from delegation-first runtime while preserving authoritative request-start, activity, terminal, and vanished-child signals in the watchdog path.
- [x] Simplify the periodic sweep to call only `reclaimStalled`; retain one unref'd timer and verify shutdown clears it.
- [x] Re-run focused unit scope and scoped OpenCode adapter typecheck (86 pass, 0 fail, 311 assertions; typecheck exit 0).
- [x] Build the candidate with the single-entry command and materialize required assets (2,163 modules; bundle SHA-256 `5404e1b2d36906b3f516435e721f1f64339d6b489b2ae5422fc41a5a906ebd50`).
- [x] Run isolated real OpenCode provider-stall and recovery-exhaustion scenarios sequentially with a local fake provider and no human wake-up message.
- [x] Prove one bounded alternate succeeds or exhausts to BLOCKED, one acknowledged terminal wake resumes the parent, only configured free fake models are requested, real stores remain unchanged, and exact test processes stop.
- [x] Freeze local evidence with reviewer-readable summary and SHA-256 manifest.
- [x] Update durable state, commit atomically, verify the dependent diff/merge bases, push, and open clean mergeable stacked PR #3.
- [x] Retarget PR #3 to `release/canonical-20261029`, revalidate its exact isolated delta/checks, and merge it as `d4e2979b8`; no deployment.

## Slice D — unified paid/free dispatch authorization

- [x] Enumerate initial sync/background, unstable-agent, continuation, background retry, sync prompt fallback, sync replacement-session fallback, recovery relaunch, and resume entry points.
- [x] Capture focused baseline tests for paid consent, free-first dispatch, recovery authorization, background fallback, and sync fallback before source edits.
- [x] Add RED tests for one final effective-model decision: verified free allow, unknown-cost fail closed, exact paid approval allow once, wrong identity reject, and replay reject.
- [x] Add a RED background fallback test proving an unapproved paid/unknown next model is never queued or prompted, while a catalog-verified free fallback remains eligible.
- [x] Add RED sync fallback tests proving both same-session prompt fallback and replacement-session fallback reject an unapproved paid/unknown model before provider dispatch.
- [x] Add a RED recovery test proving a static approval file cannot authorize paid automatic recovery and exact verified-free evidence still allows a free relaunch.
- [x] Implement the shared effective-model decision on top of the single-use `PaidConsentRegistry`; missing model/pricing is paid/unknown and fails closed without exact approval.
- [x] Wire BackgroundManager initial launch and fallback retry through the shared decision; pass the initial approval nonce/task identity to the execution boundary and never copy it to automatic fallback/recovery attempts.
- [x] Wire sync initial dispatch and both sync fallback paths through the same decision.
- [x] Remove the recovery approval-file exception and retain only catalog/retained-worker verified-free automatic relaunch.
- [x] Pass exact dispatch approval through Resource Governor once so a valid launch is not rejected and no reusable session consent is created.
- [x] Run the focused unit scope and scoped OpenCode adapter typecheck (119 pass, 0 fail, 355 assertions; typecheck exit 0).
- [x] Build/import the candidate and run isolated real OpenCode fake-provider scenarios proving no unapproved paid/unknown request and exactly one synthetic single-use approved paid request.
- [x] Prove only configured local fake endpoints were contacted, real stores were unchanged, and exact test processes stopped.
- [x] Freeze reviewer-readable evidence and SHA-256 manifest under `.omo/evidence/20261101-dispatch-authorization/`.
- [x] Update durable state, commit atomically, verify exact Slice C/canonical merge bases and the 23-file dependent diff, push, and open clean mergeable stacked PR #4.
- [x] Prove merged PR #4 is included exactly once in #3 by tree and patch identity; no redundant open PR remains to close.

## Slice E — reliability gate and reproducible release

- [x] Verify PR #1-#4 live state, exact ancestry, checks, mergeability, and #4 exact-once inclusion before integration.
- [x] Merge #1, retarget/revalidate/merge #2, retarget/revalidate/merge #3, and prove the final release tree matches #3/#4 exactly.
- [x] Re-run the post-merge combined 385-test scope and scoped OpenCode typecheck.
- [x] Re-run real isolated OpenCode guard, normal completion, free stall recovery, bounded exhaustion, restart/deleted-child replay, paid denial, and one synthetic approved paid scenario on the merged bundle.
- [x] Reproduce generated-artifact drift with host Bun 1.3.14 and with isolated CI-pinned Bun 1.4.3; identify missing toolchain declaration/fail-fast and stale committed outputs.
- [x] Add an exact Bun 1.4.3 package/toolchain contract and RED/GREEN tests; wire every tracked generator to fail before writing on mismatch.
- [x] Regenerate only the declared Codex/native/Senpi tracked artifacts with Bun 1.4.3 and prove a second generation is byte-identical.
- [x] Fix the Codex 0.166 live-hook failure by removing build-only cache-local `node_modules` after skill synchronization; prove install links still work and live hooks complete.
- [x] Add a clean-tree release-candidate verifier that records commit, tool versions, lockfile hash, artifact hash/size, evidence hashes, and explicit rollback target.
- [x] Make the Senpi release gate hermetic to ancestor temp-package metadata; rerun the exact failed files (including the unchanged descriptor diagnostic), then the combined Senpi gate without timeout-inducing over-throttling.
- [x] Prove two clean-checkout builds from one commit leave no tracked diff and emit matching artifact/manifest identity.
- [x] Build a committed sequential, time-bounded real OpenCode fake-provider regression matrix with cleanup and resource assertions.
- [x] Add standalone empty-response, explicit-cancellation, compaction, and repeated unattended scenarios.
- [x] Add a RED/GREEN manager regression for a terminal empty assistant turn and bound empty-output terminalization to 15 seconds.
- [x] Prove explicit cancellation reaches a running child and releases only that task's owned session/process resources.
- [x] Record CPU, memory, filesystem-watch, process, wall-time, and artifact-growth observations across repeated unattended runs.
- [x] Run scoped OpenCode, Codex, and Senpi real-harness QA required by the build surfaces; keep evidence local and ignored.
- [x] Update final architecture/state/release docs, open Slice E PR #5 against `release/canonical-20261029`, verify all gates, and merge it as `4ed0ee31d` with a merge commit.
- [x] Build the exact merged Slice E commit, preserve the prior bundle, deploy the versioned artifact atomically, and pass the post-deployment real OpenCode smoke test without rewriting production Git history.
- [x] Preserve production unchanged during the Garmin incident follow-up; no follow-up deployment is authorized.

## Slice E incident follow-up — Garmin repeated empty workers

- [x] Read the preserved incident README, runtime evidence, staged PLAN_UPDATE, current STATE.md, ROADMAP, and applicable repository instructions before changing source.
- [x] Trace the production provider, parent-session, delegation, child-terminal, parent-wake, recovery, and terminal-result retrieval paths end to end.
- [x] Compare the existing empty-response matrix with the Garmin production sequence and enumerate every material topology and assertion gap.
- [x] Inspect production metadata and logs read-only, without reading Garmin prompts/results or changing production configuration or source.
- [x] Write the implementation and verification plan to `.omo/plans/20261105-blocked-worker-incident.md` before the first source edit.
- [x] Add an exact repeated-empty-worker RED scenario that drives the real OpenCode runtime in an isolated XDG sandbox and preserves the failed pre-fix evidence.
- [x] Verify the RED scenario reproduces the idle unanswered-question wake deferral, non-causal wake acknowledgement, repeated empty children, absent recovery transition, and autonomous-progress failure.
- [x] Route terminal empty assistant turns through the existing bounded provider-fallback policy while preserving authorization and retry limits.
- [x] Record final ordinary empty-worker failures as delegation failures so two independent failures enter recovery mode and recovery probes remain bounded.
- [x] Make parent-wake history decisions machine-readable and allow only a bounded idle terminal-failure wake past an unanswered-question blocker, without bypassing active or tool-running turns.
- [x] Make parent-wake acknowledgement causal to output created after the dispatched wake, including message identity in stream and history checks.
- [x] Persist an explicit terminal wake-delivery-exhausted state when the bounded delivery retry is consumed, while keeping the worker result retrievable.
- [x] Replace the generic blocked-task “automatic recovery exhausted” text with the task's actual terminal reason.
- [x] Add focused unit regressions for bounded empty fallback, recovery-mode entry, definitive halt, causal wake acknowledgement, bounded history deferral, delivery exhaustion, durable terminal retrieval, escrow-specific sibling settlement, and failed-trace duplicate exclusion.
- [x] Build the OpenCode plugin from the edited source and bind the final runtime evidence to source fingerprint `c700845...` and bundle SHA-256 `c92b1a...`.
- [x] Run the exact repeated-empty-worker GREEN scenario in a fresh isolated real OpenCode runtime and capture terminal results, wake transitions, recovery transitions, bounded worker count, matching SSE event, and definitive autonomous exit.
- [x] Run the 1,291-test affected-subsystem gate, scoped OpenCode typecheck, OpenCode server smoke, the exact SSE attach probe, and the final eight-scenario real-runtime matrix with unchanged real OpenCode DB/worker-store proof.
- [x] Write reviewer-readable QA artifacts under `.omo/evidence/20261105-blocked-worker-incident/`, including commands, observations, sufficiency, omissions, and SHA-256 digests.
- [x] Correct the staged PLAN_UPDATE and update PLAN.md, STATE.md, and TODO.md with the verified root cause, fix, gate results, residual risk, and explicit production-deployment omission.
- [x] Commit only the intended source, regression, harness, and checkpoint files in atomic commits; never add `.omo/evidence/`.
- [ ] Open a reviewer-readable English PR against the canonical release branch, complete CI and review loops, merge with a merge commit, and verify the merged release candidate without deploying it.

- [ ] Publish the prepared deployment SOP/change record to Wiki.js after an operator grants executable access to the root-owned wiki helper scripts; this does not block the verified runtime deployment.

## Slice E incident follow-up — provider quota

- [x] Preserve and review the existing uncommitted provider-quota diff and its focused tests before continuing.
- [x] Add structured provider-error classification, including the exact Garmin message, retryability, quota signal, and a canonical `insufficient_quota` code for message-only retry envelopes.
- [x] Persist `providerError` and `terminalReasonCode` atomically with the blocked terminal record and wake outbox.
- [x] Add a synchronous terminal claim so late empty-turn/completion paths cannot overwrite the quota outcome during result-capture teardown.
- [x] Exclude the exhausted provider from fallback candidates while keeping a different authorized free provider eligible.
- [x] Carry the structured provider error into the immediate parent wake and all-complete summaries.
- [x] Render the durable provider error from `background_output` and task status after the child session is gone.
- [x] Authorize exactly the worker-runtime harness commands in the delegation recovery scope and add allow/deny regressions.
- [x] Implement the `provider-quota` scenario in `run.sh` / `fake-provider.mjs` per `REGRESSION_SPEC.md` (429 body, ledger, no retry/paid fallback, durable/wake/retrieval assertions, evidence retention).
- [x] Fix Bun 1.4.3 propagation so nested build steps and the Senpi generator use the running pinned executable.
- [x] Run focused tests (291 pass / 975 assertions), wider affected suites (883 + 303 + 24 pass), and scoped OpenCode typecheck (exit 0).
- [x] Build the candidate with Bun 1.4.3 and run the real isolated OpenCode `provider-quota` scenario: one child request, durable acknowledged quota terminal, structured retrieval, autonomous parent resume, definitive exit, unchanged real stores, no orphan.
- [x] Run the `empty` negative control on the same bundle and confirm it still produces the generic empty-output terminal with no provider error.
- [x] Freeze reviewer-readable evidence under `.omo/evidence/20261107-provider-quota-incident/` (`green/`, `negative-control/`, `focused/`, `RESOLUTION_20261108.md`, `SHA256SUMS`).
- [x] Update `STATE.md`, `PLAN.md`, and this todo with the observed verification and remaining delivery steps.
- [ ] Commit the intended source/test/harness/checkpoint files in atomic units and leave `.omo/evidence/` and `dist/` untracked.
- [ ] Push the follow-up branch and open/verify the PR against `release/canonical-20261029` when delivery is authorized; do not deploy.
