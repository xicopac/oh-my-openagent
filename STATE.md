# OMO Stabilization State

Last updated: 2026-11-06 Europe/Madrid
Status: Slices A-E are merged through PR #5. The Garmin repeated-empty-worker incident follow-up is fixed and locally green on a real isolated OpenCode runtime; its follow-up PR and merge gates remain. Production is unchanged.

## Git and release state

- Canonical release base and rollback target: `d4e2979b80de9d04768f380828bfca4b428276ae`.
- Integrated merge commits: PR #1 `876cff5e0`, PR #2 `61f887117`, PR #3 `d4e2979b8`, PR #5 `4ed0ee31d`.
- PR #4 is included exactly once: original #4 head `63e83c488`, integrated #3 head `1dbe9fcfe`, and the release head share tree `d408007c6b21230dea0713e9cd62575cea4e9abe`.
- Active Slice E worktree: `/srv/dev/omo-canonical-release-rc-wt/fix/stabilize-slice-e-release-gate`.
- Active branch: `fix/stabilize-slice-e-release-gate`; incident implementation commit `187574414` follows merged PR #5 commit `4ed0ee31d`.
- Slice E commits before the final runtime checkpoint: `707b6b4d8` (durable plan/state) and `eaba2c2de` (reproducible adapter builds).
- Production plugin: `/srv/dev/oh-my-openagent`; no source, Git history, configuration, bundle, or running service has been changed.
- The current incident task explicitly prohibits production deployment. Any earlier deployment authorization is out of scope for this follow-up and must not be acted on here.

## Core reliability architecture now implemented

- Terminal worker records are first-writer-wins and persist outcome, bounded result/error, attempt/event identity, and a pending wake outbox before child teardown.
- Wake delivery is monotonic `pending -> dispatched -> acknowledged`. Startup replays unacknowledged terminal events without repeating completed work.
- The watchdog is the single live stall detector; the recovery coordinator is the single retry/exhaustion authority. The removed liveness integration no longer independently retries, blocks, cancels, or wakes.
- The independent watchdog timer runs without parent LLM activity. Bounded free recovery either completes or terminalizes `blocked` and wakes the parent.
- Initial dispatch, background/sync fallback, and recovery evaluate the effective model through the same cost boundary. Unknown cost is paid; unattended fallback/recovery is free-only; exact paid approval is single-use and identity-bound.
- Tool authorization classifies normalized effect rather than transport spelling. Native `apply_patch`, wrappers, opaque shell paths, substitutions, and redirections fail closed consistently.
- Task process ownership terminates only exact recorded task scopes. Cleanup is idempotent and does not enumerate unrelated processes.
- A provider-completed empty assistant turn gets a 15-second event-settle grace, then terminalizes `blocked` and wakes the parent instead of polling forever.
- Empty terminal turns first consume the existing bounded, authorized fallback chain. Two distinct final empty-provider failures enter bounded recovery; two failed probes halt definitively while preserving read-only diagnostics and result retrieval.
- Parent-wake acknowledgement is causal to post-dispatch assistant output. Idle unanswered-question history may delay a terminal-failure wake only to the existing 60-second ceiling; active/tool-running turns remain protected.
- Resource-governor sibling traces settle by escrow identity. Failed workers are not reusable duplicate results, and request-start no longer erases preceding failure evidence.
- Sync execution still returns through its attached tool call rather than the durable background outbox. This is a documented future simplification, not a demonstrated release blocker.

## Slice E implementation

- Package metadata and every tracked generator enforce exact Bun 1.4.3 before writing.
- Build concurrency is bounded by `OMO_BUILD_JOBS`.
- Declared Codex, native, service-auth, and Senpi generated artifacts were regenerated under Bun 1.4.3 and proved byte-stable.
- Codex cache installs remove cache-local build-only `node_modules` after dependency/skill preparation; Codex 0.166 no longer rejects npm shims or workspace symlinks before hooks execute.
- Generated Senpi ESM fixtures create their own module boundary and no longer inherit unrelated ancestor `/tmp/package.json` metadata.
- `script/release-candidate.ts` requires a clean checkout, validates the rollback ancestor, runs the pinned build, rechecks cleanliness, and emits a versioned artifact plus deterministic manifest with commit, Bun/Node, lockfile, generated artifacts, evidence hashes, and rollback target.
- `script/qa/worker-runtime-matrix/` is the one committed, sequential real-OpenCode runtime gate for normal, stall, empty, cancellation, compaction, and repeated unattended scenarios.

## Garmin repeated-empty-worker incident follow-up

- The old `empty` case was a false negative: it used one child and accepted any terminal plus any parent response. It did not reproduce idle unanswered-question history, repeated empty siblings, exact retrieval, causal acknowledgement, recovery entry/probes/halt, or definitive exit.
- Production metadata showed a durable empty-output terminal wake delayed about 5h23m until parent reactivation. The staged 45s/90s source-drift conclusion was corrected: both the Slice E source and bundle use the intentional 5s/15s thresholds.
- Root causes were unbounded unanswered-question wake deferral, non-causal acknowledgement, empty terminals bypassing fallback/recovery evidence, request-start clearing failure evidence, escrow settlement mutating the wrong sibling trace, failed duplicate reuse, silent wake-delivery exhaustion, and misleading generic blocked status.
- The exact incident harness now binds bundle/source fingerprints, drives the real HTTP session API and SSE stream in isolated XDG/HOME/DB state, retrieves four exact terminal results, proves two failures and two bounded probes, requires halt rejection with no fifth worker, and requires a model-visible definitive exit.
- Garmin source, production configuration/source/bundle/service, real providers, and paid models remain untouched.

## Verification evidence

### OpenCode

- Final combined scope on Bun 1.4.3: 386 tests, 0 failures, 1,425 assertions across 35 files.
- Scoped `packages/omo-opencode` typecheck exits 0.
- Real OpenCode 1.19.3 post-merge coverage includes guard policy, normal completion, provider stall recovery, bounded recovery exhaustion, deleted-child/restart replay, paid denial, and one synthetic single-use paid approval.
- Final seven-run matrix on bundle SHA-256 `e8553ce477384e4eccdbca6a558a6bcf3313b5147b87f170242a21edf73fc341` passes normal, stall, empty, cancellation, compaction, and three repeated unattended normal runs.
- Empty output reaches durable `blocked`, its wake is acknowledged, and the parent resumes without another human message.
- Running-child cancellation closes the owned provider request while an unrelated sentinel remains alive; both test-owned processes are then cleaned exactly.
- Compaction completes through the real summarize endpoint while the worker is in flight; the recovered result survives and wakes the parent once.
- Every run keeps the real OpenCode database at 2,351 sessions and the real worker store at 93 records. Only local zero-cost fake models are requested.
- Repeated-run bounds: RSS 673,336–772,176 KiB; FDs 85–89; inotify FDs exactly 2; sandbox bytes 228,569,797–228,571,230; CPU at most 1,966 ticks; wall time at most 37 seconds; no orphan process.
- Evidence: ignored `.omo/evidence/20261105-worker-runtime-final/`.

### Garmin incident follow-up

- Exact incident candidate: bundle SHA-256 `c92b1a28597e44cdab5fca2267d6095904399e73ac9c0f978197b6b5ee411112`; final source fingerprint `c70084556802d8361db12677a8421c14de3e5199ce14b02d85eeff389d3757d8`.
- Final affected-subsystem gate: 1,291 pass, 0 fail, 3,614 assertions across 132 files; scoped OpenCode typecheck exits 0.
- Real OpenCode 1.19.3 incident: four exact empty workers are durable `blocked` and acknowledged; each result is retrieved before the next action; two provider failures plus two failed probes produce one halt; the fifth dispatch produces no provider request or worker record; the root exits definitively.
- `session.idle` was observed through the isolated OpenCode QA SSE attach probe. The real DB stayed at 2,379 sessions and the real worker store at 155 records; isolated processes stopped.
- Final eight-scenario matrix passes. Repeated normal bounds: RSS 685,008-793,180 KiB, FDs 83-87, inotify FDs 2, sandbox bytes 228,592,684-228,598,170, CPU <=2,115 ticks, wall <=39 seconds, no orphan process.
- Evidence: ignored `.omo/evidence/20261105-blocked-worker-incident/`.

### Codex

- Source/generated focused tests pass.
- Installer verification passes with nine command links and the real `~/.codex/config.toml` unchanged.
- Real `codex app-server` with the local mock model completes and emits `hook/started` / `hook/completed` for the plugin.
- Full `bun run test:codex`: 520 pass, 0 fail.
- Evidence: ignored `.omo/evidence/20261103-codex-slice-e/`.

### Senpi

- Real local Senpi driver passes with `isolationCertified=true`, `realSenpiUntouched=true`, and `realOmoUntouched=true`.
- Focused descriptor/build/RPC reruns pass.
- Full `bun run test:senpi`: 5,809 pass, 0 fail, 4 platform skips, 49,948 assertions across 673 files. Evidence-path resolver: 10 pass.
- Evidence: ignored `.omo/evidence/omo-senpi-adapter/20261103-stabilization-slice-e/`.

### Reproducible release

- Two clean builds from commit `eaba2c2de` produce identical artifact SHA-256 `47949e129764ebc8748fd02fe3b1b2ebb7059a459d8cb726e9038960b635b969`.
- Their manifests are identical after normalizing the intentionally different output path.
- Both builds start and finish with a clean tracked tree.
- The final merged Slice E commit will receive a fresh release-candidate manifest before deployment.

## Current decision and next actions

1. Commit only the Garmin incident source, regression harness, and checkpoint updates; keep evidence ignored.
2. Push the branch and open a follow-up PR against `release/canonical-20261029`.
3. Verify exact merge base, intended diff, CLA, CI, and merge readiness; merge with a merge commit only if every required check passes.
4. Build and verify the exact merged follow-up commit with rollback target `4ed0ee31d`.
5. Stop before production deployment. This incident request explicitly prohibits deployment.
6. Do not rewrite production Git history, merge to `dev`, bypass guards, allow unbounded retries, or contact a real paid provider.

## Separate housekeeping and deferred work

- Fork history divergence remains separate: `origin/dev` is 6,429 commits behind local production `dev`. No stabilization operation may force-push, rewrite, synchronize, or mutate that history.
- Deferred, non-blocking features: per-child TUI model/token/cost display, aggregate accounting without double counting, a shared 150k-token context governor, upgrade automation, and obsolete-worktree cleanup.
- Historical worktrees, original incident evidence, and the unfinished guard candidate remain preserved.
