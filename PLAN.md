# OMO Stabilization Plan

Last updated: 2026-10-30 (Europe/Madrid)
Owner: Codex
Canonical base: `4d1961c7e45223590768cce43093a839198eb28a`
Implementation worktree: `/srv/dev/omo-canonical-release-rc-wt/fix/stabilize-omo-core`
Production boundary: `/srv/dev/oh-my-openagent` is read-only and must not be built, edited, restarted, or deployed by this plan.

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

- Real completion, session deletion, compaction, restart, and duplicate-event scenarios.
- Exactly one terminal result and one actionable wake per assignment.

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

### Slice E — Runtime reliability gate and release reproducibility

Files:

- Resource-bounded isolated runtime harness under repository test/script conventions.
- CI workflow/package scripts for the named reliability gate.
- Release manifest/build verification helper and architecture/release documentation.

Changes:

- Sequential fake-provider matrix, bounded timeouts, cleanup traps, process-leak assertions, DB isolation proof, CPU/temperature preflight documentation.
- Clean-checkout build manifest and artifact verification. No production switch.

Verification:

- Repeated unattended matrix with stable process count, bounded wall time, bounded artifact growth, and temperature below 90°C.
- Clean rebuild from commit with matching artifact hash and evidence manifest.

## Execution rules

- Work only in fresh task-owned worktrees based on the canonical release line.
- Use `GIT_MASTER=1` for every Git command.
- Never edit, build, restart, or deploy `/srv/dev/oh-my-openagent`.
- Never delete historical worktrees or original evidence.
- No real model/provider probes; fake local providers only.
- Heavy test suites run sequentially and only when package temperature is below 90°C. Stop immediately at or above 90°C.
- Every OpenCode-connected source change requires real isolated OpenCode QA and local evidence under `.omo/evidence/<slug>/` before commit.
- Evidence stays untracked. PR bodies include sanitized decisive excerpts and SHA-256 lines.
- Each slice is the smallest independently reviewable PR. Production deployment is explicitly out of scope.

## Milestone exit criteria

Milestone 1 exits when the architecture document, source trace, demonstrated root causes, and ordered PR slices are durable and reviewed.

Milestone 2 exits only when the core invariants above are implemented and every changed behavior has real runtime evidence.

Milestone 3 exits only when the full controlled-provider matrix passes repeatedly without human input, lost results, abandoned tasks, unauthorized paid routes, orphan processes, or resource growth.

Milestone 4 exits when a clean commit reproducibly builds a versioned artifact and rollback manifest. Deployment remains pending explicit human approval.
