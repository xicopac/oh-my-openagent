# OMO Stabilization State

Last updated: 2026-11-08 Europe/Madrid
Status: Slices A-E and both incident follow-ups are implemented and verified. The provider-quota change, the final build-toolchain fixes, and the consolidated nine-scenario runtime matrix are green on one reproducible candidate bundle. The final release candidate is prepared for delivery; it is not pushed, merged, or deployed by this task. Production remains on the Garmin-fix release.

## Git and release state

- Canonical release base and rollback target: `d4e2979b80de9d04768f380828bfca4b428276ae`.
- Integrated merge commits: PR #1 `876cff5e0`, PR #2 `61f887117`, PR #3 `d4e2979b8`, PR #5 `4ed0ee31d`.
- PR #4 is included exactly once: original #4 head `63e83c488`, integrated #3 head `1dbe9fcfe`, and the release head share tree `d408007c6b21230dea0713e9cd62575cea4e9abe`.
- Slice E PR #5 merged as `4ed0ee31d3c5676397b88507ff724f94a19d55fb`; its merge tree exactly matches verified feature head `ffef6e1023e3990317ce8165ea22b8a12b522a90`.
- The Garmin follow-up merged as PR #8 `0ca44477e2518301015cd0bc88435eed0239cea0`; its verified deployed bundle is `cef322b80a5310e2ac4aa1b9b7b0b92d459cba3899dc011d9b4d3400a32249c4` (6,542,814 bytes).
- The previously deployed Slice E commit `4ed0ee31d3c5676397b88507ff724f94a19d55fb` remains the rollback predecessor for `0ca44477e`; its bundle is `e8553ce477384e4eccdbca6a558a6bcf3313b5147b87f170242a21edf73fc341`.
- Active Slice E worktree: `/srv/dev/omo-canonical-release-rc-wt/fix/stabilize-slice-e-release-gate`.
- Active branch: `fix/stabilize-slice-e-release-gate`; Garmin commits `187574414` / `026dda5fe` were merged by PR #8, and provider-quota commits `b57364031`, `9b051b463`, `90db34fa8`, `89a94aaf5` follow it.
- Final build/harness commits: `48276ceed` (pin nested Bun and local TypeScript), `80f5180f3` (include provider quota in the matrix), `d38c1d037` (attach the idle probe after the incident question state).
- Slice E commits before the final runtime checkpoint: `707b6b4d8` (durable plan/state) and `eaba2c2de` (reproducible adapter builds).
- Production plugin: `/srv/dev/oh-my-openagent`. Its live bundle is the Garmin-fix artifact `cef322b8...` from merge `0ca44477e`; the provider-quota candidate is not deployed. Its source, Git history, configuration, and unrelated dirty files were not changed by this task.
- This task explicitly prohibits production deployment and does not authorize source/configuration mutation, Git-history rewriting, guard bypasses, or real paid-provider traffic.

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
- The build now supplies a temporary `bun` shim for nested package scripts, so `bun run <script>` cannot fall through to a host Bun, and it resolves the declaration compiler from the lockfile-pinned `node_modules/.bin/tsc` instead of a PATH wrapper.
- Codex cache installs remove cache-local build-only `node_modules` after dependency/skill preparation; Codex 0.166 no longer rejects npm shims or workspace symlinks before hooks execute.
- Generated Senpi ESM fixtures create their own module boundary and no longer inherit unrelated ancestor `/tmp/package.json` metadata.
- `script/release-candidate.ts` requires a clean checkout, validates the rollback ancestor, runs the pinned build, rechecks cleanliness, and emits a versioned artifact plus deterministic manifest with commit, Bun/Node, lockfile, generated artifacts, evidence hashes, and rollback target.
- `script/qa/worker-runtime-matrix/` is the one committed, sequential real-OpenCode runtime gate for normal, stall, empty, provider quota, the repeated-empty incident, cancellation, compaction, and repeated unattended scenarios. The idle SSE probe attaches immediately before the incident abort so it observes the production idle transition instead of an earlier instance lifecycle stream.

## Garmin repeated-empty-worker incident follow-up

- The old `empty` case was a false negative: it used one child and accepted any terminal plus any parent response. It did not reproduce idle unanswered-question history, repeated empty siblings, exact retrieval, causal acknowledgement, recovery entry/probes/halt, or definitive exit.
- Production metadata showed a durable empty-output terminal wake delayed about 5h23m until parent reactivation. The staged 45s/90s source-drift conclusion was corrected: both the Slice E source and bundle use the intentional 5s/15s thresholds.
- Root causes were unbounded unanswered-question wake deferral, non-causal acknowledgement, empty terminals bypassing fallback/recovery evidence, request-start clearing failure evidence, escrow settlement mutating the wrong sibling trace, failed duplicate reuse, silent wake-delivery exhaustion, and misleading generic blocked status.
- The exact incident harness now binds bundle/source fingerprints, drives the real HTTP session API and SSE stream in isolated XDG/HOME/DB state, retrieves four exact terminal results, proves two failures and two bounded probes, requires halt rejection with no fifth worker, and requires a model-visible definitive exit.
- Garmin source, production configuration/source/bundle/service, real providers, and paid models remain untouched.

## Provider-quota incident follow-up (2026-11-07/08)

- A delegated provider can return quota exhaustion instead of an assistant turn. The lifecycle now preserves that as a distinct terminal class instead of collapsing it into generic empty-output or inactivity text.
- Structured `providerError` and `terminalReasonCode=provider_quota_exhausted` persist atomically with the blocked terminal record and wake outbox. `providerError` carries provider/model, code, exact message, `retryable=false`, and `quotaExhausted=true`; a canonical `insufficient_quota` code is used when OpenCode's retry envelope omits the raw code.
- Quota terminalization now wins the in-memory race: `claimTerminalTask` performs a synchronous first-writer claim before awaiting result capture in `failCrashedTask` and the terminal `session.error` path.
- Fallback excludes the exhausted provider but still permits a different authorized free provider from the configured chain. The exhausted provider receives exactly one request; no paid/unknown model is dispatched without explicit approval.
- Parent wake text and all-complete summaries render the structured provider error. `background_output` and task status serve the same durable fields after the child session is gone.
- The delegation recovery scope authorizes exactly the worker-runtime harness invocations (`run.sh <known-scenario>` and `matrix.sh`) while traversal, `-c`, extra arguments, and compound mutations remain denied.
- The harness now implements the `provider-quota` scenario: isolated real OpenCode 1.19.3, local fake provider returning HTTP 429 `Free usage exceeded, subscribe to Go` with `retry-after: 60`, exact bundle/source binding, one-request ledger, durable/wake/retrieval assertions, no recovery probe, unchanged real stores, and cleanup receipts.
- The Bun 1.4.3 build boundary now propagates the running pinned executable into nested build steps and the Senpi generator instead of resolving a host Bun on PATH.
- Evidence: ignored `.omo/evidence/20261107-provider-quota-incident/` (`green/`, `negative-control/`, `focused/`, `RESOLUTION_20261108.md`).

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

### Provider-quota follow-up

- Final focused scope on Bun 1.4.3: 291 pass, 0 fail, 975 assertions across 12 files.
- Wider affected suites: background-agent 883 pass; delegation-first + background-task 303 pass; Senpi build-extension 24 pass.
- Scoped `packages/omo-opencode` typecheck exits 0 (the `script/` tsconfig still reports its pre-existing missing-markdown-module declarations; no `script/` source error is introduced).
- Candidate bundle: SHA-256 `26de42383d292a14935e18b175c542297df1248999222ab14c28b7c82795306d` (6,551,869 bytes), source fingerprint `0ba3f5ba7190435543fbae3cbda9ff38dac9f87cc725bf1cecb1987fc8ed8e41`.
- Real OpenCode 1.19.3 `provider-quota`: exactly one request to the exhausted `openai/gpt-fake-free`; durable `blocked` terminal with `provider_quota_exhausted` and the exact message; structured `providerError`; monotonic acknowledged wake; `background_output` retrieval; autonomous parent resume; definitive root exit; no recovery probe; only local free fake models; real DB unchanged at 2,391 sessions and worker store at 278 records; no orphan process.
- Negative control `empty` on the same bundle still produces `BLOCKED: assistant turn completed with no output` with no `providerError`.
- Evidence: ignored `.omo/evidence/20261107-provider-quota-incident/`.

### Final consolidated release candidate

- Build boundary fix: nested package scripts previously fell through to the host Bun 1.3.14 even when the parent build ran under 1.4.3; the Codex installer correctly rejected that toolchain, but the host `ai-job` wrapper masked the non-zero status. The build now prepends a temporary `bun` shim for the running executable and runs declarations from `node_modules/.bin/tsc`.
- Harness fix: the incident SSE probe now attaches immediately before the abort, after the unanswered-question state exists. This observes the actual `session.idle` transition instead of an earlier per-instance lifecycle stream that can close during startup.
- The committed matrix now includes `provider-quota`, so the final gate runs normal, stall, empty, provider quota, repeated-empty incident, cancellation, compaction, and three repeated unattended normal runs.
- Final nine-scenario matrix on bundle `26de4238...` / source fingerprint `0ba3f5ba...`: all scenarios pass, `fails=0`; repeated bounds RSS 688,888-779,116 KiB, FDs 85-87, inotify FDs 2, sandbox bytes 228,616,879-228,618,340, CPU <=2,810 ticks, wall <=48 seconds, no orphan process. Real store counts stayed at 2,391 sessions / 278 worker records; only local free fake models were requested.
- Evidence: ignored `.omo/evidence/20261108-final-runtime-matrix-v2/`.
- Two clean release-candidate builds at code commit `d38c1d037` produce byte-identical artifact SHA-256 `26de42383d292a14935e18b175c542297df1248999222ab14c28b7c82795306d` (6,551,869 bytes), with identical manifests after normalizing the intentional output path.
- Final manifest identity: Bun 1.4.3, Node 26.3.0, lockfile `fa2976ce...`, rollback target `0ca44477e` (current production). The candidate is not deployed.
- Evidence: ignored `.omo/evidence/20261108-final-rc-a/`, `.omo/evidence/20261108-final-rc-b/`.

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
- Current production is the Garmin fix `0ca44477e` with live SHA-256 `cef322b80a5310e2ac4aa1b9b7b0b92d459cba3899dc011d9b4d3400a32249c4`; the preserved rollback is `e8553ce4...`. The provider-quota candidate has not replaced it.

## Current decision and next actions

1. Push the verified follow-up branch and open a reviewer-readable PR against `release/canonical-20261029` when delivery is authorized.
2. Verify the intended diff, CLA, CI, review, and merge readiness; merge with a merge commit only after every required check passes.
3. Rebuild the exact merged commit with current production `0ca44477e` as rollback target and recheck the artifact hash before any deployment decision.
4. Stop before production deployment. Do not reconcile `dev`, mutate production source/configuration, bypass guards, allow unbounded retries, or contact a real paid provider.
5. Wiki.js publication for the PR #5/Garmin deployment records remains a separate operational-documentation follow-up; the root-owned helper access is still unavailable.
6. A host `tsc` wrapper process from the pre-fix PATH failure remains outside the release artifact and test ownership; it should be terminated during host cleanup. The fixed build no longer invokes that wrapper.

## Separate housekeeping and deferred work

- Fork history divergence remains separate: `origin/dev` is 6,429 commits behind local production `dev`. No stabilization operation may force-push, rewrite, synchronize, or mutate that history.
- Deferred, non-blocking features: per-child TUI model/token/cost display, aggregate accounting without double counting, a shared 150k-token context governor, upgrade automation, and obsolete-worktree cleanup.
- Historical worktrees, original incident evidence, and the unfinished guard candidate remain preserved.
