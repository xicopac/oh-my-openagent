# OMO Stabilization State

Last updated: 2026-11-02 Europe/Madrid
Status: Slice A PR #1, Slice B PR #2, Slice C PR #3, and Slice D PR #4 form a clean mergeable stack. Earlier PR automation is green except the human CLA signature; PR #4 checks are newly queued. No production changes.

## Repository state

- Canonical source: `/srv/dev/omo-canonical-release-rc` at `4d1961c7e` on `release/canonical-20261029`.
- Slice A worktree: `/srv/dev/omo-canonical-release-rc-wt/fix/stabilize-omo-core` on `fix/stabilize-omo-core`, based on `4d1961c7e`.
- Production plugin: `/srv/dev/oh-my-openagent`; untouched.
- Existing guard candidate: `/srv/dev/omo-guard-consistency-rc` at `af1b246ee`; preserved and not edited.
- Existing evidence and historical worktrees: preserved; none deleted.
- Goal registered: stabilize OMO through architecture, core reliability, real runtime proof, and reproducible release safeguards; stop before deployment.
- Remote task branch: `origin/fix/stabilize-omo-core`; tracks this checkpoint branch and was pushed without changing `origin/dev` or the production checkout.
- Slice A PR: `https://github.com/xicopac/oh-my-openagent/pull/1`, base `release/canonical-20261029`, exact merge base `4d1961c7e`, 7 commits and 16 intended files. Structural checks pass; CLA is the only failed gate and requires the human `xicopac` account to sign.
- Active Slice B worktree: `/srv/dev/omo-canonical-release-rc-wt/fix/stabilize-worker-ledger` on `fix/stabilize-worker-ledger`, stacked from `e66143235` without modifying the Slice A worktree.
- Slice B PR: `https://github.com/xicopac/oh-my-openagent/pull/2`, base `fix/stabilize-omo-core`, exact Slice A merge base `e66143235`, exact canonical merge base `4d1961c7e`, five implementation/evidence commits and 16 intended files before this final status-only checkpoint. GitHub reports the PR mergeable; every active automation check passes except CLA.
- Slice B verification: final lifecycle/wake scope is green (79 pass, 0 fail, 319 assertions), scoped OpenCode adapter typecheck exits 0, the 2,168-module candidate bundle imports successfully, and both final real OpenCode runtime scenarios pass.
- Slice B bundle: `dist/index.js`, 6,585,323 bytes, SHA-256 `054a992efab1e87c43c17e34225466d4600e1f5e409bb635c08d809d49621715`; ignored build artifact only, not production.
- Slice B evidence: `.omo/evidence/20261030-worker-ledger/README.md` and `SHA256SUMS`; local and gitignored.
- Active Slice C worktree: `/srv/dev/omo-canonical-release-rc-wt/fix/stabilize-worker-supervisor` on `fix/stabilize-worker-supervisor`, stacked from Slice B status commit `22e99e7fa`.
- Slice C evidence: `.omo/evidence/20261101-worker-supervisor/README.md` and `SHA256SUMS`; local and gitignored.
- Slice C candidate bundle: 6,564,676 bytes, SHA-256 `5404e1b2d36906b3f516435e721f1f64339d6b489b2ae5422fc41a5a906ebd50`; ignored build artifact only, not production.
- Slice C PR: `https://github.com/xicopac/oh-my-openagent/pull/3`, base `fix/stabilize-worker-ledger`, exact Slice B merge base `22e99e7fa`, exact canonical merge base `4d1961c7e`, three implementation/evidence commits and eight intended files before this status-only checkpoint. GitHub reports the PR clean and mergeable; ensure-labels, label-pull-request, review-claim, and signal checks pass, while CLA is the only failed gate.
- Active Slice D worktree: `/srv/dev/omo-canonical-release-rc-wt/fix/stabilize-dispatch-authorization` on `fix/stabilize-dispatch-authorization`, stacked from Slice C status commit `6784d7a61`.
- Slice D evidence: `.omo/evidence/20261101-dispatch-authorization/`; local and gitignored.
- Slice D candidate bundle: SHA-256 `c9efff12498a282b330db709154fea16997ac30faa94d7787547a527ad5079f0`; ignored build artifact only, not production.
- Slice D PR: `https://github.com/xicopac/oh-my-openagent/pull/4`, base `fix/stabilize-worker-supervisor`, exact Slice C merge base `6784d7a61`, exact canonical merge base `4d1961c7e`, six implementation/evidence commits and 23 intended files before this status-only checkpoint. GitHub reports the PR clean and mergeable.

## Confirmed findings

1. The canonical release commit reconstructs the deployed plugin source and reproduces the deployed bundle byte-for-byte with Bun 1.3.14. It is not deployed or merged into the live `dev` checkout.
2. Prior runtime QA demonstrated that worker results can be durably recorded and parents can wake after completion or retry exhaustion, but the implementation still contains overlapping watchdog/liveness/background mechanisms and conservative restart handling.
3. `createManagers()` runs a periodic watchdog sweep; `createDelegationFirstRuntime()` owns watchdog, recovery coordinator, and liveness supervisor; the liveness callback can call `reclaimStalled()`, while the same runtime sweep also calls it. A cancel set deduplicates effects, but ownership is still distributed and hard to reason about.
4. BackgroundManager remains a second lifecycle center: it launches sessions, polls them, detects empty turns/staleness, persists records, captures results, notifies parents, cleans sessions, and cancels tasks.
5. Parent wake delivery is in-memory queued/dispatched state layered over durable worker records. Existing evidence proves selected recovery cases, not every restart/compaction/deletion interleaving.
6. Paid authorization exists in ordinary dispatch and recovery relaunch paths, but it is implemented through multiple modules and must be proven equivalent for sync/background/retry/fallback paths.
7. Real guard QA proved a legitimate single-file `cat` is blocked after the root enters `worker_required`, while an offset+limit `read` is allowed.
8. Real OpenCode 1.19.3 exposes `apply_patch` as its mutation tool. Canonical `classifyOperation()` recognizes only `edit`/`write`, and unknown tools default to `control`; therefore `apply_patch` can bypass the worker-first authorization decision.
9. Canonical shell classification treats unknown commands as `control`, so mutations such as `rm`, `mv`, `touch`, `chmod`, `tee`, command substitution, and unhandled wrappers can receive weaker authorization than direct mutation tools.
10. The unfinished guard commit `af1b246ee` improves shell wrapper parsing and selective diagnostics but does not close the demonstrated `apply_patch` gap or all opaque-shell paths.
11. Worker terminal persistence is now first-writer-wins in the durable store. Terminal result, outcome, attempt identity, event identity, and pending wake outbox are written before session teardown.
12. Parent wake state is explicit and monotonic: pending -> dispatched -> acknowledged. Dispatch no longer means delivery; actual parent assistant/tool output or history proof acknowledges the exact worker IDs.
13. Startup recovery replays pending and unacknowledged dispatched terminal outboxes regardless of age for new records, remains backward-compatible with legacy records, and never recreates or reruns completed work.
14. A failed cancellation abort no longer writes a provisional cancelled terminal record. This preserves the later truthful completion path when the child remains alive.
15. Coalesced/admitted wake consumption now acknowledges the union of retained and dispatched worker ownership, preventing a completed worker from being stranded behind another wake.
16. Slice C trace confirms the live delegation runtime still embeds `worker-liveness-supervisor`, whose internal `attemptRecovery()` and `wake_parent` events can independently block/retry/wake beside the watchdog/recovery coordinator.
17. The periodic watchdog sweep currently calls exact process cleanup after every timed-out result even when `reclaimStalled()` returns false, and duplicates cleanup after an accepted reclaim. Cleanup must follow the confirmed BackgroundManager terminal transition instead.
18. Slice C removes `worker-liveness-supervisor` from the live delegation runtime. The watchdog is now the only live stall detector, the recovery coordinator is the only retry-budget decision authority, and liveness can no longer independently retry, block, or wake a parent.
19. The independent manager timer now performs a metadata-only sweep and calls only `reclaimStalled()`. It has no process-cleanup dependency; declined recovery has no cleanup side effect, while accepted recovery reaches exact task-owned cleanup only through the confirmed BackgroundManager terminal path.
20. Real OpenCode provider-stall proof covers both bounded alternate success and bounded exhaustion: each used one human root prompt, produced an acknowledged durable terminal record, and autonomously resumed the parent.
21. Slice D trace confirms ordinary task dispatch requests and consumes exact paid consent in `tools/delegate-task/tools.ts`, while BackgroundManager fallback retries bypass that boundary and mutate the effective model before queueing a new attempt.
22. Sync fallback can change the effective model both inside the existing session and while creating a replacement session without re-running the paid-consent boundary.
23. Recovery relaunch uses a separate persistent approval-file policy instead of the single-use in-memory operator approval registry. This is inconsistent with initial dispatch and can authorize repeated paid recovery attempts from one static entry.
24. Slice D replaces the split cost gates with one final effective-model decision. Missing pricing is unknown/paid, free models require catalog or retained-record verification, and paid models require exact single-use root/worker/model/task approval.
25. Background and sync fallback now authorize the next effective model before aborting, mutating task state, queueing, prompting, or creating a replacement session. Automatic fallback has no approval nonce and therefore remains free-only.
26. Automatic recovery no longer reads a static approval file as spending authority. Paid or unknown recovery terminalizes blocked; verified-free recovery retains bounded autonomous relaunch.
27. Real approved-path QA exposed and fixed a second consent owner: Resource Governor rejected an already-approved paid launch. Exact approval now satisfies only the same dispatch-level governor evaluation and never persists as reusable session consent.
28. On the final candidate bundle, real OpenCode requested zero paid models without interactive availability and exactly one paid model after synthetic explicit approval. Free completion also persisted and acknowledged its terminal result and woke the parent unattended.

## Current call graph and ownership

- `createDelegateTask()` resolves the initial model, prefers free candidates, obtains any exact paid approval, and calls the shared final cost decision. `BackgroundManager.launch()` consumes the trusted in-process decision marker and performs the separate Resource Governor budget/backstop decision before queue/session/prompt work.
- Background fallback and both sync fallback forms call the same final cost decision before changing model, aborting an attempt, queueing, prompting, or creating a replacement session. They carry no paid nonce and are therefore free-only.
- Recovery relaunch accepts only catalog or retained-record verified-free candidates. A paid or unknown candidate exhausts to the existing blocked terminal path and parent wake; static approval files are no longer part of recovery authority.
- `createManagers()` drives the one watchdog sweep on an independent unref'd timer. The watchdog detects stalls, the recovery coordinator owns bounded retry/exhaustion, and the removed live liveness supervisor no longer retries, blocks, or wakes independently.
- Background terminal observations converge on first-writer-wins durable terminal records and a monotonic pending/dispatched/acknowledged wake outbox. Startup replay never repeats completed work.
- Sync execution still returns through the live tool call rather than the durable background worker ledger/outbox. Restart recovery therefore remains intentionally different by execution mode and is a future simplification candidate.
- Process ownership records exact ai-job units/process groups and is idempotent per record. It remains the only component that signals recorded task-owned scopes.
- `docs/reference/worker-reliability-architecture.md` records the invariants, ownership boundaries, migration sequence, runtime matrix, and release boundary.

## Safety and resource state

- One orphaned isolated QA server from the previous guard run (PID 918547, port 4199) was confirmed to use the synthetic XDG sandbox and stopped with SIGTERM. No matching QA process remains.
- No credentials were read. No real provider was contacted.
- No production process, config, bundle, source checkout, or service was modified.

## Current decision

Slice D is ready for atomic commits and a stacked PR against Slice C. Cost authority is now path-independent: initial dispatch and every effective-model switch use one decision, automatic fallback/recovery is free-only, and paid approval is exact and single-use.

Final focused evidence is 119 passing tests with 355 assertions plus a clean scoped typecheck. The 2,163-module candidate bundle imports with required assets at SHA-256 `c9efff12498a282b330db709154fea16997ac30faa94d7787547a527ad5079f0`. Real OpenCode 1.19.3 runs prove free completion and parent wake, zero unattended paid requests, and exactly one paid request after one synthetic explicit approval.

All final runtime runs used only local fake endpoints, left the real OpenCode DB at 2,351 sessions and the real worker store at 93 records, and stopped their isolated OpenCode/provider processes. Production source, build, branch, configuration, and services remain untouched.

## Next checkpoint

1. Observe PR #4 automation and repair any real finding with fresh scoped QA.
2. The human `xicopac` account signs the CLA so PRs #1–#4 can satisfy their non-automatable gate.
3. Merge the stack in dependency order with merge commits after gates pass; never synchronize `dev` or deploy.
4. Continue with the remaining Slice E runtime/release matrix.

## Honest remaining gaps

- Compaction-specific runtime proof, standalone empty-response and explicit-cancellation scenarios, and repeated unattended resource measurements remain for Slice E. Provider-stall success and recovery exhaustion are now proven in a real isolated runtime.
- Slices A–D are committed, pushed, and open as PRs #1–#4. The earlier stack is CLA-blocked by required human action; Codex cannot satisfy or bypass that gate.
- The fork task branch is safely pushed, but `origin/dev` remains 6,429 commits behind local production `dev`. This is a separate housekeeping task; no force-push, rewrite, synchronization, or production checkout mutation is authorized.
- Milestone 2 now has durable terminal/outbox behavior, autonomous parent wake, one live supervision/recovery authority, and unified dispatch authorization. Slice E still owns the complete repeated runtime matrix and reproducible-release gate; Milestones 3–4 remain incomplete.
