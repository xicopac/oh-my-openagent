## 1. Problem (verified)

OpenCode's ordinary `bash` tool executions bypass ai-job entirely. On this machine
the OpenCode process lives in `ai-control.slice` (verified: `/proc/self/cgroup`
= `/ai.slice/ai-control.slice/run-r38b24cb...scope`). Any child it spawns
(`/bin/bash` -> `timeout` -> `bunx tsgo` -> `tsgo`) inherits ai-control.slice.

Observed failure: ai-control.slice held >100 tasks / >3GB under pressure, while
ai-work.slice sat at TasksCurrent=0. GNU `timeout 90/120` wrappers stayed alive
30-50 minutes (descendants escape GNU timeout).

Existing PATH wrappers (`/usr/local/libexec/ai-wrappers/{tsgo,bun,turbo,...}` ->
`ai-tool`) do NOT catch the failing patterns: `bunx tsgo` resolves the package
binary from bun's bin dir (not PATH), and `bun run typecheck` resolves the script
binary the same way. `ai-classify` also has gaps: no `bunx`/`npx <bin>` cases.

The only plugin-visible pre-spawn chokepoint for the built-in `bash` tool is the
`tool.execute.before` hook (`packages/omo-opencode/src/plugin/tool-execute-before.ts`),
which can mutate `output.args.command` before OpenCode spawns.

## 2. Design

Central enforcement = ONE hook block in `tool-execute-before.ts` (the existing
bash block, after null-byte sanitization). New module:

`packages/omo-opencode/src/features/heavy-command-routing/`
- `classify.ts`  -> `normalizeShellCommand()` + `classifyResourceCommand()`:
  ResourceClass = `light | build | test | gradle | emulator | heavy`.
  Deterministic, reuses grunt-guard light semantics, mirrors ai-classify classes,
  closes bunx/npx gaps.
- `router.ts`    -> `decideHeavyCommandRouting(command, deps)`:
  `{action:"direct"} | {action:"rewrite", command} | {action:"refuse", reason}`;
  `buildAiJobCommand()`; single-quote escaping.
- `cgroup.ts`    -> `isInsideControlSlice()` (reads /proc/self/cgroup, cached).
- `index.ts`     -> barrel.

### Classification (classify.ts)
1. Normalize: strip leading wrappers
   - `timeout [flags] N`  -> extract N (unit bound; GNU timeout removed because
     it is provably insufficient and cgroup membership is authoritative)
   - `env VAR=VAL ...`, `sudo`, `nice`, `nohup`, `time`  -> keep inside unit
     (env semantics preserved by the inner `bash -lc`)
   - `bash -c '...'` / `sh -c '...'`  -> unwrap for classification (kept in unit)
   - `cd <path> && cmd` / `cd <path>; cmd`  -> strip prefix for classification
2. Split on `&& | ; | \n` (naive, quote-agnostic; acceptable for routing bias).
3. Per segment, first token = tool. If ANY segment is heavy -> heavy routing.
4. Heavy tables (segment-start anchored, word-boundary aware): tsgo/tsc -> build;
   bun/bunx and npm/npx/pnpm/yarn run-script rules; turbo; gradle/gradlew;
   make/cmake/ninja/meson; cargo/go; mvn/ant/sbt/javac/cc/gcc/clang/rustc;
   jest/vitest/mocha/ava/pytest/playwright; next/vite/webpack build; emulator/
   qemu-system-*/avdmanager/sdkmanager; adb (light for devices/version/help/
   kill-server/reconnect).
5. Unknown -> light (conservative, matches CLASSIFIER.md philosophy).
6. Light set is NOT enumerated for routing: absence of a heavy match = direct.

### Routing (router.ts)
```
if (!inControlSlice)                         -> direct (not the bug environment)
if class == light                            -> direct
if class != light AND aiJobBin exists        -> rewrite
else                                         -> REFUSE (fail-closed)
```
Rewrite:
`<aiJobBin> run <type> --timeout <secs> -- /bin/bash -lc '<escaped-command>'`
- type: build|test|gradle|heavy from class; emulator -> `run emulator --timeout 0`.
- timeout: extracted GNU timeout if present; else OpenCode bash tool `timeout` arg
  (ms -> s) if present; else default 1800.
- escaped-command: single-quote escaped original command with GNU timeout wrapper
  removed; env/bash-c/cd prefixes retained inside the unit.
- Diagnostic prefix (one line, heavy only):
  `printf '[ai-routing] class=%s type=%s slice=%s\n' ... &&`
  (unit name comes from ai-job's AI_JOB_UNIT= output).
Refuse message: `[routing] HEAVY command refused: ai-job unavailable; cannot route away from ai-control.slice`.

### Fail-closed invariant
HEAVY/EMULATOR + would-run-in-ai-control + cannot route -> throw from the hook
(visible tool error, nothing spawns). Never silent execution in ai-control.

### Observability
- `log("[heavy-command-routing] ...", {class, type, slice, sessionID})` for heavy rewrites only.
- Light commands produce zero extra output.

## 3. Files changed

New:
- `packages/omo-opencode/src/features/heavy-command-routing/{classify,patterns,router,cgroup,index,classify.test,router.test,cgroup.test,systemd-integration.test}.ts`
Modified:
- `packages/omo-opencode/src/plugin/tool-execute-before.ts` (bash block wiring)
- `.omo/plans/20260923-heavy-command-routing.md` (this plan)

## 4. Verification

### Unit tests (deterministic, no infra needed)
1. `git status` -> light; 2. `grep` -> light; 3. `bunx tsgo --noEmit` -> build ->
rewrite; 4. `timeout 120 bunx tsgo` -> build (timeout stripped, unit bound 120);
5. `bash -c 'bunx tsgo'` -> build; 6. `cd repo && bun run typecheck` -> build;
7. `gradle build` / `./gradlew test` -> gradle; 8. `emulator -avd x` / `adb install`
-> emulator; `adb devices` -> light; 9. heavy + aiJobBin missing -> refuse;
10. worker-issued heavy -> rewrite (classify/route is session-agnostic);
11. root-issued heavy -> rewrite (same path); 12-15. systemd integration tests
(timeout synthetic cgroup dies, fork/reparent escape, controller alive, two
concurrent jobs independent); 16. regression: `timeout 120 bunx tsgo --noEmit`
rewrite never references ai-control.slice; integration asserts spawned unit cgroup
is ai-work.slice.

### Live acceptance (must run, record evidence under .omo/evidence/)
- `bun test` on the new module + `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json`.
- Real OpenCode session (isolated XDG sandbox, plugin pointing at local dist):
  issue `bunx tsgo --noEmit -p packages/omo-opencode/tsconfig.json` through the
  normal bash tool; prove opencode stays in ai-control.slice, typecheck unit in
  ai-work.slice, ai-work TasksCurrent>0; stop unit; zero survivors; opencode
  responsive; unit cgroup empty.
- Regression live: `timeout 120 bunx tsgo --noEmit` never appears in ai-control.slice.

## 5. Out of scope / documented limitations
- Pre-existing ai-job exit-code masking after --collect GC (front-end returns 0 on
  failure) - infra issue, documented; registry JSON retains exit_status.
- No changes to /srv/dev/ai-resource-isolation; no sudoers additions; no new
  NOPASSWD entries.
- OpenCode stays non-root; ai-control.slice keeps controller; heavy descendants
  only in ai-work/ai-emulator units.
