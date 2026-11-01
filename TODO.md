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
- [>] Push the canonical base and open a reviewer-readable stacked PR against `release/canonical-20261029`; first prove the merge base is exactly `4d1961c7e` and the diff contains only Slice A stabilization files.
- [ ] Resolve CI and review findings with fresh QA for behavior-changing fixes.
- [>] Merge the stacked PR into `release/canonical-20261029` with a merge commit after its active gates pass. Do not update `dev` or deploy.

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
- [>] Commit atomically according to file-count policy, push a dependent stacked branch, open a reviewer-readable PR, resolve active gates, and merge without deployment.

## Slice C — single supervision authority

- [ ] Inventory every timer/cancel/retry/wake owner and mark the one retained coordinator.
- [ ] Add failing tests for competing signals and exactly-one reclaim/terminal/wake.
- [ ] Remove policy authority from liveness/background/watchdog secondary paths and route signals to the coordinator.
- [ ] Prove pre-response stall, mid-response stall, empty response, disappearance, cancellation, retry success, and retry exhaustion with sequential fake-provider runs.
- [ ] Update durable state, commit atomically, PR, verify, and merge without deployment.

## Slice D — unified paid/free dispatch authorization

- [ ] Enumerate sync, background, continuation, retry, relaunch, fallback, and resume dispatch entry points.
- [ ] Add one effective-model authorization decision and idempotent approval consumption.
- [ ] Prove free-first selection and zero unauthorized paid-route requests on the fake-provider ledger.
- [ ] Update durable state, commit atomically, PR, verify, and merge without deployment.

## Slice E — reliability gate and reproducible release

- [ ] Build a sequential, time-bounded real OpenCode fake-provider regression matrix with cleanup and resource assertions.
- [ ] Run repeated unattended scenarios and record CPU, memory, filesystem-watch, process, and artifact-growth observations.
- [ ] Add clean-checkout build manifest and regression gate automation.
- [ ] Prove reproducible versioned artifact and rollback metadata from a clean commit.
- [ ] Update final architecture/state/release docs, PR, verify, and merge.
- [ ] Stop before production deployment and request explicit human approval for any future switch.
