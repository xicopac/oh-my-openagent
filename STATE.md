# OMO Stabilization State

Last updated: 2026-10-30 Europe/Madrid
Status: Milestone 1 and Slice A implementation/QA committed and pushed; stacked canonical-base PR authorized and pending; no production changes.

## Repository state

- Canonical source: `/srv/dev/omo-canonical-release-rc` at `4d1961c7e` on `release/canonical-20261029`.
- Active implementation worktree: `/srv/dev/omo-canonical-release-rc-wt/fix/stabilize-omo-core` on `fix/stabilize-omo-core`, based on `4d1961c7e`.
- Production plugin: `/srv/dev/oh-my-openagent`; untouched.
- Existing guard candidate: `/srv/dev/omo-guard-consistency-rc` at `af1b246ee`; preserved and not edited.
- Existing evidence and historical worktrees: preserved; none deleted.
- Goal registered: stabilize OMO through architecture, core reliability, real runtime proof, and reproducible release safeguards; stop before deployment.
- Remote task branch: `origin/fix/stabilize-omo-core`; tracks this checkpoint branch and was pushed without changing `origin/dev` or the production checkout.

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

The first implementation slice is authorization consistency because it contains a demonstrated mutation bypass on the real OpenCode tool surface. The isolated worktree now classifies `apply_patch` and equivalent native mutation tools as implementation, fails closed on opaque shell execution, preserves read-only runtime diagnostics, allows one bounded specific-file diagnostic after delegation becomes mandatory, extracts every patch target, and derives durable `.omo` materialization authority from normalized paths. Opaque MCP tools retain their prefix and remain broad; only known local compatibility aliases are normalized.

Focused RED evidence captured the canonical failures. The final candidate passes 140 guard/recovery/human-authorization/materialization/hook tests with 571 expectations, including a leading-traversal regression added during pre-commit review, and passes `tsgo --noEmit -p packages/omo-opencode/tsconfig.json`. These are unit/type gates only; they do not satisfy the mandatory real OpenCode QA requirement by themselves.

Real OpenCode 1.19.3 QA now satisfies the Slice A runtime requirement. Against the untouched production bundle, the deterministic fake-provider sequence reproduced blocked specific-file diagnostics, successful source `apply_patch`, successful wrapped mutation, and blocked safe stderr metadata. Against the candidate bundle, the first diagnostic completed and the second was bounded, source/wrapped mutations were blocked, durable `.omo/evidence` materialization completed, and safe metadata completed. Both runs kept the real DB count at `2351`, created exactly one sandbox session, used only `gpt-fake`, and stopped the exact OpenCode/provider PIDs.

After the leading-traversal fix, the candidate bundle was rebuilt at SHA-256 `049916ef29d26890f6d32ce8f913453d9b4e23efeeb3dc3242a83316b8d26646` (6,580,169 bytes) and the complete real OpenCode candidate scenario passed again. The post-run package reading reached exactly 90°C, so no further build/test/runtime activity is permitted until another cooldown.

## Next checkpoint

1. Push `release/canonical-20261029` without rewriting any existing ref, prove the stacked merge base is `4d1961c7e`, and verify the diff contains only Slice A files.
2. Open the stacked PR and resolve CI/review findings with fresh scoped QA if any behavior changes.
3. Merge with a merge commit into the canonical release branch without updating `dev` or the production checkout, then continue to Slice B.

## Honest remaining gaps

- Slice A does not address worker result durability, restart replay, competing watchdog ownership, or unified dispatch authorization; those remain explicitly incomplete.
- No PR exists for this work.
- The fork task branch is safely pushed, but no PR exists yet. `origin/dev` is an ancestor of local `dev`, with no divergence, and is 6,429 commits behind it. This is now a separate housekeeping task. The user authorized a stacked PR against `release/canonical-20261029` only after exact merge-base and diff verification; `dev` and production history must remain untouched.
- Milestones 2–4 remain incomplete.
