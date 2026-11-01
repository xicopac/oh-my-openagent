# OMO Stabilization State

Last updated: 2026-11-01 Europe/Madrid
Status: Slice A PR #1 and dependent Slice B PR #2 are clean and mergeable but await the human CLA signature; no production changes.

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
- Thermal checkpoint: the root `bun run build` was stopped when the hottest CPU sensor reached 98°C. Its interrupted materialization left `ui-ux-pro-max` half-checked-out; the worktree had been clean immediately beforehand, and a non-forced pinned submodule update restored exact gitlink `f32d6a61`. The failed build is preserved as `red/full-build-thermal-abort.txt`; it is not acceptance evidence. Future Slice B builds use only the documented single-entry OpenCode bundle command and start below 90°C.

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

Slice B is ready for a dependent stacked PR. The implementation establishes the durable terminal-result/outbox contract without adding a second recovery authority: the background manager still executes sessions, while the worker record is the durable terminal/result/wake ledger and the existing parent-wake machinery advances its delivery state.

Final focused evidence is 79 passing tests with 319 expectations plus a clean scoped typecheck. The rebuilt candidate bundle imports with required assets. Real OpenCode 1.19.3 normal completion proved one human prompt can dispatch a real child, persist its result, autonomously resume the parent, and acknowledge the wake after parent output. The restart scenario proved a 48-hour-old pending terminal result with a deleted child survives process restarts, is retrievable through the real `background_output` tool, wakes the idle parent without human input, and does not replay after acknowledgement.

Both final runtime runs used only local fake endpoints and `gpt-fake-free`, left the real OpenCode DB at 2351 sessions and the real worker store at 93 records, and stopped their isolated OpenCode/provider processes. Production source, build, branch, configuration, and services remain untouched.

## Next checkpoint

1. The human `xicopac` account signs the CLA so PRs #1 and #2 can satisfy their only failing gate.
2. Merge #1 and then #2 with merge commits after gates pass; never synchronize `dev` or deploy.
3. Begin Slice C's single-supervision authority and bounded retry/recovery matrix in a fresh dependent worktree.

## Honest remaining gaps

- Slice B does not remove competing watchdog/recovery authorities or unify every dispatch/fallback paid-authorization decision; those are Slices C and D.
- Compaction-specific runtime proof, standalone real-runtime cancellation/stall/empty-response/recovery-exhaustion scenarios, and repeated unattended resource measurements remain for Slices C/E.
- Slice B is committed, pushed, and open as PR #2. Both #1 and #2 are CLA-blocked by required human action; Codex cannot satisfy or bypass that gate.
- The fork task branch is safely pushed, but `origin/dev` remains 6,429 commits behind local production `dev`. This is a separate housekeeping task; no force-push, rewrite, synchronization, or production checkout mutation is authorized.
- Milestone 2 is partially complete through the terminal-result/outbox dependency; Milestones 3–4 remain incomplete.
