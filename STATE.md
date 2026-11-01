# OMO Stabilization State

Last updated: 2026-11-01 Europe/Madrid
Status: Slice A PR #1 and dependent Slice B PR #2 are clean and mergeable but await the human CLA signature; Slice C single-supervision implementation and runtime proof are complete in its dependent worktree and await commit/stacked PR; no production changes.

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

## Current call graph and ownership defects

- Background dispatch: `createDelegateTask()` performs model/free-first/paid decisions, `executeBackgroundTask()` calls `BackgroundManager.launch()`, and the manager performs a second resource-governor decision before queue/session/prompt work.
- Background terminal observations arrive through `background-notification` event forwarding and the manager's own polling interval. Idle, deleted, error, retry, missing status, empty turn, stale task, explicit cancel, and circuit breaker paths can terminalize the task.
- Delegation recovery: `createManagers()` drives `checkAllWatchdogs()` on an independent timer. `createDelegationFirstRuntime()` owns watchdog, recovery coordinator, liveness supervisor, relaunch, and a cancel dedupe set. The liveness callbacks can call the same `reclaimStalled()` and blocked-notification paths as the watchdog sweep.
- Runtime fallback separately owns a first-prompt timer and error/status handlers that abort and re-prompt child sessions. Background fallback separately requeues attempts. Sync fallback separately retries prompts or creates a new child session.
- Sync execution bypasses the durable background worker record/outbox and returns its result through the live tool call. Restart recovery therefore differs by execution mode.
- The worker JSON record uses atomic rename but no terminal compare-and-set. Terminal payload and notification timestamps are separate writes. The pending/dispatched wake queues are in-memory; `notificationDeliveredAt` records prompt dispatch, not durable parent consumption.
- Process ownership records exact ai-job units/process groups and is idempotent per record. Multiple event paths request cleanup, but the ownership service is the only component that signals those recorded scopes. This mechanism should remain the exclusive process terminator.
- `docs/reference/worker-reliability-architecture.md` now records the required invariants, current split ownership, target coordinator/ledger/outbox, migration sequence, runtime matrix, and release boundary.

## Safety and resource state

- One orphaned isolated QA server from the previous guard run (PID 918547, port 4199) was confirmed to use the synthetic XDG sandbox and stopped with SIGTERM. No matching QA process remains.
- Temperature after the source trace was 91°C, then cooled to 82°C before focused work resumed. The dependency install unexpectedly invoked the repository build but remained isolated; its tracked generated output was restored from the clean same-commit canonical checkout. An earlier typecheck reached 92°C, so work paused until cooldown. The final post-edit typecheck passed with an immediate CPU package reading of 86°C.
- No credentials were read. No real provider was contacted.
- No production process, config, bundle, source checkout, or service was modified.

## Current decision

Slice C is ready for an atomic three-commit checkpoint and a stacked PR against Slice B. The live delegation runtime no longer embeds a competing liveness retry/block/wake authority. The independent manager timer observes watchdog metadata and delegates each eligible timeout to the single recovery coordinator; lifecycle/process cleanup remains downstream of the confirmed BackgroundManager terminal transition.

Final focused evidence is 86 passing tests with 311 assertions plus a clean scoped typecheck. The rebuilt candidate bundle imports with required assets. Real OpenCode 1.19.3 provider-stall runs prove bounded recovery success and bounded exhaustion both persist an acknowledged terminal result and resume the idle parent without a second human message.

Both final runtime runs used only local fake endpoints and explicitly configured zero-cost fake models, left the real OpenCode DB at 2,351 sessions and the real worker store at 93 records, and stopped their isolated OpenCode/provider processes. Production source, build, branch, configuration, and services remain untouched.

## Next checkpoint

1. Commit Slice C atomically, verify both merge bases and its exact dependent diff, push, and open its stacked PR against `fix/stabilize-worker-ledger`.
2. The human `xicopac` account signs the CLA so the stacked PRs can satisfy their only non-automatable gate.
3. Merge the stack in dependency order with merge commits after gates pass; never synchronize `dev` or deploy.
4. Continue with Slice D unified dispatch authorization and the remaining Slice E runtime/release matrix in fresh dependent worktrees.

## Honest remaining gaps

- Slice C removes the live competing liveness authority but does not unify every dispatch/fallback paid-authorization decision; that remains Slice D.
- Compaction-specific runtime proof, standalone empty-response and explicit-cancellation scenarios, and repeated unattended resource measurements remain for Slice E. Provider-stall success and recovery exhaustion are now proven in a real isolated runtime.
- Slice B is committed, pushed, and open as PR #2. Both #1 and #2 are CLA-blocked by required human action; Codex cannot satisfy or bypass that gate.
- The fork task branch is safely pushed, but `origin/dev` remains 6,429 commits behind local production `dev`. This is a separate housekeeping task; no force-push, rewrite, synchronization, or production checkout mutation is authorized.
- Milestone 2 has durable terminal/outbox behavior, autonomous parent wake, and a single live supervision/recovery authority. Unified dispatch authorization remains before the milestone can exit; Milestones 3–4 remain incomplete.
