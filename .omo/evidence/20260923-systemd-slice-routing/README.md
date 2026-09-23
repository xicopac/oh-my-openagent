# Heavy-command routing: live acceptance evidence

Date: 2026-09-23. Branch: `feature/dynamic-subagent-model-routing`.

## What was tested

A fresh, isolated `opencode run` process (PID 1740769, session `ses_f3051f806ffehtFQZawfy4vLBQ`) was
launched against the rebuilt plugin dist (`dist/index.js`, built 2026-09-23 21:10, includes
`heavy-command-routing` + the in-place mutation fix below). A deterministic local mock provider
(`openai/mock-flash`, `/tmp/opencode/mock-provider.mjs`) drove the session and emitted exactly one
`bash` tool call with `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json`.

Purpose: prove that a heavy command issued through OpenCode's normal bash tool is transparently
rewritten and executed inside an `ai-job` transient unit under `ai-work.slice`, while the OpenCode
process itself stays in `ai-control.slice`.

The pre-existing `delegation-first` watchdog (a separate feature in the working tree, gated by
`resource_governor.enabled`) blocks root bash work in a fresh session before our routing hook runs.
It was disabled for this acceptance run via a TEMPORARY project config
(`.omo/omo.jsonc` -> `[opencode].resource_governor.enabled=false`), then removed. No repo config
files were changed permanently.

## What was observed

1. Acceptance OpenCode process remained in the control slice:
   `0::/ai.slice/ai-control.slice/run-r38b24cb4276649b99ef03e690af355c6.scope`.
2. The bash tool event (see `acceptance-tool-event.json`) shows the REWRITTEN command executed:
   `printf '[ai-routing] class=%s type=%s slice=%s\n' BUILD build ai-work.slice && /usr/local/bin/ai-job run build --timeout 1800 -- /bin/bash -lc 'bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json'`
   with output:
   ```
   [ai-routing] class=BUILD type=build slice=ai-work.slice
   ai-job: launching ai-build-9e858a.service (type=build timeout=1800s background=0)
   AI_JOB_UNIT=ai-build-9e858a.service
   AI_JOB_SLICE=ai-work.slice
   ai-job: unit ai-build-9e858a.service finished: result=success exec_main_status=0
   ```
   Exit 0.
3. While the unit ran it was ACTIVE under `ai-work.slice` (captured in `systemd-unit-active-capture.txt`):
   `ai-build-9e858a.service ... active running /bin/bash -lc "bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json"`,
   `ai-work.slice Tasks: 8 (limit: 768)`.
4. Plugin hook log (`plugin-log-routing-excerpt.txt`):
   `[heavy-command-routing] routed heavy command {"class":"build","type":"build","slice":"ai-work.slice","timeoutSec":1800,...}`.
5. After the unit completed, zero `ai-*` transient units remained and `ai-work.slice Tasks` returned
   to 0; `ai-work.slice`/`ai-control.slice` still `active` (controller responsive).
6. Isolation (`isolation-proof.txt`): real `~/.local/share/opencode/opencode.db` session count
   unchanged (335 before and after); all acceptance sessions landed in the sandbox XDG data home
   (7 sessions).

## Critical integration finding (fixed in this change)

opencode 1.18.32 executes tools from the closure `args` passed to `tool.execute` (see
`packages/opencode/src/session/tools.ts`: `plugin.trigger("tool.execute.before", ..., { args })`
then `item.execute(args, ctx)`). `replaceToolArgs()` REASSIGNS `output.args` to a new object, which
opencode ignores, so the rewrite was silently lost. The routing hook now MUTATES
`output.args.command` in place (same object opencode reads). Verified: with the previous
`replaceToolArgs` call, the acceptance tool event executed the ORIGINAL command and no unit was
created; after the in-place fix, the rewritten command executed inside `ai-build-9e858a.service`.

Note: this incompatibility also affects the pre-existing `non-interactive-env` git prefix hook and
other `replaceToolArgs` call sites in opencode 1.18.32. Those are out of scope for this focused
routing fix and are flagged for a separate follow-up.

## Why it is enough

- The exact enforcement property is proven on a real OpenCode session: a command classified HEAVY
  (build) was intercepted at `tool.execute.before`, rewritten, and executed inside a disposable
  unit under `ai-work.slice`, never in `ai-control.slice`.
- Unit/typecheck gates: 58 pass / 0 fail across `classify/router/cgroup/systemd-integration` tests;
  `tsgo --noEmit -p packages/omo-opencode/tsconfig.json` RC=0; `bun run build` completes.

## What was omitted

- Raw model/auth tokens and the mock provider internals were not copied (no secrets present).
- The `delegation-first` watchdog behavior is documented above but not exercised here.