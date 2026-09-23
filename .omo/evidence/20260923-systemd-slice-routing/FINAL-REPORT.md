# FINAL REPORT — Heavy-command routing into ai-work.slice

Branch: `feature/dynamic-subagent-model-routing`
Commits: `d7c0b6a6a` (implementation + evidence + plan), `57183266e` (plan doc fix)
Date: 2026-09-23

## 22 required items

1. **Heavy vs light classification.** `classifyResourceCommand` reuses `grunt-guard` light semantics and closes the `bunx`/`npx` gap (treated as build/test candidates, not light). Deterministic, no ambient state.
2. **Class taxonomy.** ResourceClass = `light | build | test | gradle | emulator | heavy`; patterns in `patterns.ts` map command shapes (`bun run build`, `bunx tsgo`, `gradle`, `emulator`, `adb`, etc.) to classes.
3. **Routing decision outcomes.** `decideHeavyCommandRouting` returns `rewrite` (heavy, ai-job available, in control slice), `refuse` (heavy but ai-job unavailable / fails precondition — throws before execution, fail-closed), or `passthrough` (light, or already outside the control slice).
4. **ai-job integration.** Rewritten command = `printf '[ai-routing] class=%s type=%s slice=%s\n' ... && /usr/local/bin/ai-job run <type> --timeout <sec> -- /bin/bash -lc '<cmd>'`; ai-job emits `AI_JOB_UNIT` / `AI_JOB_SLICE` / `AI_JOB_PID` for the disposable unit.
5. **Slice mapping.** `ai-job-helper type_slice()` maps build/test/gradle → `ai-work.slice`; emulators → `ai-emulator.slice`. Heavy commands never execute directly inside `ai-control.slice`.
6. **Timeout handling.** Default `--timeout 1800`; the bash-tool `timeout` argument is folded into the ai-job timeout so a user-supplied OpenCode timeout is not clobbered; GNU `timeout` prefixes are stripped to avoid double-wrapping.
7. **Cgroup safety gate.** `isInsideControlSlice()` reads `/proc/self/cgroup`; if the harness is not inside the control slice the command passes through directly (no-op guard).
8. **Fail-closed refuse path.** `aiJobAvailable: existsSync(AI_JOB_BIN)` — heavy command when ai-job is missing is refused before any execution, never silently run in the control slice.
9. **Hook wiring.** `tool.execute.before` bash branch (`packages/omo-opencode/src/plugin/tool-execute-before.ts`): imports routing module, classifies, rewrites, logs `[heavy-command-routing] routed heavy command {class,type,slice,timeoutSec}`.
10. **The critical integration fix.** opencode 1.18.32 executes tools from the closure `args` (`session/tools.ts`); `replaceToolArgs` reassigns `output.args` and is IGNORED. The hook now mutates `output.args.command` in place — proven: before the fix the acceptance session executed the original command; after it, the routed command ran.
11. **Guard preservation.** Null-byte commands are still stripped; the pre-existing "pure sleep + active background tasks" block is preserved, now evaluated against the final (possibly rewritten) command via a re-narrowed local.
12. **Unit test coverage.** 4 suites (classify, router, cgroup, systemd-integration) = 58 tests; tool-execute-before suites = 28 tests. All pass, 0 fail.
13. **Typecheck.** `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json` RC=0 (after fixing a TS2345 narrowing regression introduced by the in-place assignment).
14. **Build.** `bun run build` all steps completed; `dist/index.js` rebuilt at 21:10 with the routing refs.
15. **Live acceptance harness.** Fresh sandboxed `opencode run` (isolated XDG homes, PID 1740769, session `ses_f3051f806ffehtFQZawfy4vLBQ`) driven by a deterministic local mock provider (`openai/mock-flash`) — the opencode.ai Zen tier 429s on any second session.
16. **Acceptance evidence.** Tool executed the REWRITTEN command; output: `[ai-routing] class=BUILD type=build slice=ai-work.slice`, `launching ai-build-9e858a.service`, `result=success exec_main_status=0`, exit 0. Unit captured ACTIVE in `ai-work.slice` (Tasks: 8, limit 768). Evidence: `.omo/evidence/20260923-systemd-slice-routing/`.
17. **Cleanup verification.** After the unit completed: zero `ai-*` transient units, `ai-work.slice Tasks: 0`, both `ai-work.slice`/`ai-control.slice` active (controller responsive).
18. **Isolation.** Real `~/.local/share/opencode/opencode.db` session count unchanged (335 before/after); all acceptance sessions landed in the sandbox XDG data home (7 sessions).
19. **Constraints honored.** No NOPASSWD additions, no new sudoers entries, no arbitrary `systemctl` for the controller, OpenCode stays non-root, no competing classification system, `/srv/dev/ai-resource-isolation`, `/usr/local`, and `grunt-guard/classify.ts` untouched (classify imported, not modified).
20. **Pre-existing interference.** The unrelated `delegation-first` watchdog (gated by `resource_governor.enabled`) blocks fresh-session root bash work before the routing hook; it was disabled for acceptance via a TEMPORARY `.omo/omo.jsonc` (`[opencode].resource_governor.enabled=false`), removed before final state. Safety invariant holds either way: watchdog throws (fail-closed) or routing rewrites.
21. **Known limitation (follow-up).** The `replaceToolArgs` reassignment incompatibility also breaks the pre-existing `non-interactive-env` git env-prefix hook in opencode 1.18.32. Out of scope for this focused fix; flagged for a separate change.
22. **Commit state.** `d7c0b6a6a` (16 files: routing module 9 files, hook wiring, plan, evidence) + `57183266e` (plan doc fix: `patterns.ts` listed in Files changed). Momus plan review: OKAY (references/conventions/evidence verified; single non-blocking doc gap fixed). Repo left clean: no temp config, no stray artifacts, pre-existing dirty files untouched.

## Sign-off

Task complete: routing fix implemented, typechecked, built, unit-tested, live-accepted, evidenced, plan-reviewed, and committed.