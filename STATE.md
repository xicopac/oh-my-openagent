# OMO Stabilization State

Last updated: 2026-11-05 Europe/Madrid
Status: Slices A-E are merged into `release/canonical-20261029`. The exact merged Slice E artifact passed final preflight, was deployed atomically, and passed the post-deployment real OpenCode smoke test.

## Git and release state

- Canonical release base and rollback target: `d4e2979b80de9d04768f380828bfca4b428276ae`.
- Integrated merge commits: PR #1 `876cff5e0`, PR #2 `61f887117`, PR #3 `d4e2979b8`.
- PR #4 is included exactly once: original #4 head `63e83c488`, integrated #3 head `1dbe9fcfe`, and the release head share tree `d408007c6b21230dea0713e9cd62575cea4e9abe`.
- Slice E PR #5 merged as `4ed0ee31d3c5676397b88507ff724f94a19d55fb`; its merge tree exactly matches verified feature head `ffef6e1023e3990317ce8165ea22b8a12b522a90`.
- `origin/release/canonical-20261029` and the verified release worktree both resolve to `4ed0ee31d3c5676397b88507ff724f94a19d55fb`.
- Slice E commits before the final runtime checkpoint: `707b6b4d8` (durable plan/state) and `eaba2c2de` (reproducible adapter builds).
- Production plugin: `/srv/dev/oh-my-openagent`. Its source, Git history, configuration, and unrelated dirty files were not changed; only the ignored runtime bundle `dist/index.js` was replaced atomically.
- The user explicitly authorized an atomic, rollback-capable deployment of the exact merged green artifact. This does not authorize rewriting or synchronizing production Git history, deploying to `dev`, bypassing checks, or contacting a real paid provider.

## Core reliability architecture now implemented

- Terminal worker records are first-writer-wins and persist outcome, bounded result/error, attempt/event identity, and a pending wake outbox before child teardown.
- Wake delivery is monotonic `pending -> dispatched -> acknowledged`. Startup replays unacknowledged terminal events without repeating completed work.
- The watchdog is the single live stall detector; the recovery coordinator is the single retry/exhaustion authority. The removed liveness integration no longer independently retries, blocks, cancels, or wakes.
- The independent watchdog timer runs without parent LLM activity. Bounded free recovery either completes or terminalizes `blocked` and wakes the parent.
- Initial dispatch, background/sync fallback, and recovery evaluate the effective model through the same cost boundary. Unknown cost is paid; unattended fallback/recovery is free-only; exact paid approval is single-use and identity-bound.
- Tool authorization classifies normalized effect rather than transport spelling. Native `apply_patch`, wrappers, opaque shell paths, substitutions, and redirections fail closed consistently.
- Task process ownership terminates only exact recorded task scopes. Cleanup is idempotent and does not enumerate unrelated processes.
- A provider-completed empty assistant turn gets a 15-second event-settle grace, then terminalizes `blocked` and wakes the parent instead of polling forever.
- Sync execution still returns through its attached tool call rather than the durable background outbox. This is a documented future simplification, not a demonstrated release blocker.

## Slice E implementation

- Package metadata and every tracked generator enforce exact Bun 1.4.3 before writing.
- Build concurrency is bounded by `OMO_BUILD_JOBS`.
- Declared Codex, native, service-auth, and Senpi generated artifacts were regenerated under Bun 1.4.3 and proved byte-stable.
- Codex cache installs remove cache-local build-only `node_modules` after dependency/skill preparation; Codex 0.166 no longer rejects npm shims or workspace symlinks before hooks execute.
- Generated Senpi ESM fixtures create their own module boundary and no longer inherit unrelated ancestor `/tmp/package.json` metadata.
- `script/release-candidate.ts` requires a clean checkout, validates the rollback ancestor, runs the pinned build, rechecks cleanliness, and emits a versioned artifact plus deterministic manifest with commit, Bun/Node, lockfile, generated artifacts, evidence hashes, and rollback target.
- `script/qa/worker-runtime-matrix/` is the one committed, sequential real-OpenCode runtime gate for normal, stall, empty, cancellation, compaction, and repeated unattended scenarios.

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
- Exact merged commit `4ed0ee31d` produced artifact SHA-256 `e8553ce477384e4eccdbca6a558a6bcf3313b5147b87f170242a21edf73fc341` (6,536,818 bytes) under Bun 1.4.3; the clean-tree verifier recorded rollback target `d4e2979b80de9d04768f380828bfca4b428276ae`.
- The versioned deployed artifact is `/srv/dev/omo-releases/oh-my-openagent/4ed0ee31d3c5676397b88507ff724f94a19d55fb/index.js`; its hash is byte-identical to `/srv/dev/oh-my-openagent/dist/index.js`.
- The previous live bundle is preserved at `/srv/dev/omo-releases/oh-my-openagent/rollback-e5b545d70b0686bbb560381c46ed7005d4953e06939e66190f581f44f032f94a/index.js`.
- Post-deployment real OpenCode smoke passed normal completion, durable acknowledged wake, autonomous parent continuation, free local fake-provider enforcement, unchanged real stores, and no orphan processes. Evidence: ignored `.omo/evidence/20261105-production-deploy/normal/`.

## Current decision and next actions

1. Stabilization Slice E and its production bundle deployment are complete; future OpenCode launches load the verified bundle. No OpenCode process was running during deployment, so no unrelated Codex/tmux process was restarted.
2. Keep production Git history and source untouched. Roll back by atomically restoring the preserved `e5b545d7...` bundle only if a post-release incident demonstrates the need.
3. Wiki.js publication remains an operational-documentation follow-up: the required local helpers are root-owned mode `0700`, and passwordless sudo is unavailable. Draft SOP/change text is preserved in ignored `.omo/evidence/20261105-production-deploy/` without reading or exposing credentials.
4. Do not reconcile `dev`, deploy another commit, or contact a real paid provider as part of this completed stabilization release.

## Separate housekeeping and deferred work

- Fork history divergence remains separate: `origin/dev` is 6,429 commits behind local production `dev`. No stabilization operation may force-push, rewrite, synchronize, or mutate that history.
- Deferred, non-blocking features: per-child TUI model/token/cost display, aggregate accounting without double counting, a shared 150k-token context governor, upgrade automation, and obsolete-worktree cleanup.
- Historical worktrees, original incident evidence, and the unfinished guard candidate remain preserved.
