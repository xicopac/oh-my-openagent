# Worker reliability architecture

Status: target architecture and migration contract

Canonical baseline: `4d1961c7e45223590768cce43093a839198eb28a`

This document defines which component is allowed to decide worker lifecycle, recovery, authorization, wake delivery, and process cleanup. It also records the current split ownership that stabilization must remove. It is intentionally narrower than the general orchestration guide: this is the reliability contract for delegated OpenCode work.

## Required invariants

1. Every accepted worker reaches exactly one terminal outcome: completed, failed, cancelled, or blocked.
2. A worker result is durable before its child session or process is aborted or deleted.
3. A terminal outcome produces one durable parent-wake obligation. Delivery is idempotent and survives plugin restart.
4. Stall detection runs independently of parent model activity and uses bounded timers.
5. An assignment has a bounded, deduplicated attempt sequence. A completed attempt is never repeated.
6. Free eligible workers are selected before paid workers.
7. Every paid attempt has an explicit, scoped, single-use authorization for its effective provider/model. A retry or fallback that changes model requires another decision.
8. Equivalent operations receive the same authorization regardless of native tool, shell wrapper, interactive shell, MCP bridge, or recovery path.
9. Only task-owned process scopes can be terminated. Cancellation cannot use broad process-name matching.
10. One component owns each decision. Other components may observe and emit signals, but cannot independently cancel, retry, terminalize, or wake.

## Current execution paths

### Background task

```text
task tool
  -> createDelegateTask() model/category/free-first resolution
  -> paid consent + resource-governor decisions
  -> executeBackgroundTask()
  -> BackgroundManager.launch()
       -> second resource-governor authorization
       -> durable DISPATCHED record
       -> concurrency queue
       -> session.create
       -> durable STARTING record
       -> promptAsync
       -> durable RUNNING record
  -> OpenCode events + BackgroundManager 3-second polling
  -> completion/error/cancel/block path
       -> fetch child messages
       -> durable terminal record
       -> abort/cleanup child
       -> in-memory parent-wake queue
       -> promptAsync parent wake
       -> completed child session deletion after retention delay
```

Primary files:

- `packages/omo-opencode/src/tools/delegate-task/tools.ts`
- `packages/omo-opencode/src/tools/delegate-task/background-task.ts`
- `packages/omo-opencode/src/features/background-agent/manager.ts`
- `packages/omo-opencode/src/features/background-agent/worker-record.ts`
- `packages/omo-opencode/src/features/background-agent/parent-wake-*.ts`

The durable worker record is a useful base, but it is not yet an authoritative ledger. `save()` overwrites a JSON record without compare-and-set semantics. Terminal outcome and notification state are separate updates. The wake itself lives in memory; `notificationDeliveredAt` can be written after prompt dispatch even though no durable acknowledgement proves the parent produced or consumed a follow-up turn.

### Synchronous task

```text
task tool
  -> createDelegateTask() model/category/free-first resolution
  -> paid consent + resource-governor decisions
  -> executeSyncTask()
       -> reserve concurrency and descendant slot
       -> session.create
       -> register child side effects
       -> sendSyncPrompt()
       -> pollSyncSession()
       -> fetchSyncResult()
       -> return result directly to parent tool call
       -> abort and schedule child-session deletion
```

Primary files:

- `packages/omo-opencode/src/tools/delegate-task/sync-task.ts`
- `packages/omo-opencode/src/tools/delegate-task/sync-task-runner.ts`
- `packages/omo-opencode/src/tools/delegate-task/sync-session-poller.ts`
- `packages/omo-opencode/src/tools/delegate-task/sync-task-fallback.ts`

This path does not use the durable background worker ledger or parent-wake outbox. It has its own poll timeout, assistant-turn budget, fallback loop, result fetch, cleanup, and session deletion. A plugin restart cannot reconstruct the in-flight synchronous tool call from the background ledger.

## Current lifecycle and recovery ownership

| Component | Detects | Acts today | Problem |
|---|---|---|---|
| `BackgroundManager` | idle, deleted session, error, empty/aborted turn, stale task, missing status | completes, fails, blocks, cancels, retries fallback, persists, wakes, deletes session | Session executor is also a policy authority and persistence/wake owner. |
| Delegation watchdog | request/response/progress/tool deadlines | reclaims, cancels, selects retry, relaunches, blocks | Correct place for deadline policy, but not the only acting supervisor. |
| Worker liveness supervisor | ACK, heartbeat, progress, process exit | calls reclaim and can request blocked wake | Described as detector-only but still participates in recovery and wake decisions. |
| Runtime fallback first-prompt watchdog | no first assistant progress | aborts the child and dispatches a fallback prompt in the same session | Competes with delegation watchdog and does not share its recovery episode or dispatch authorization. |
| Runtime fallback event handlers | provider retry/error/quota signals | abort and dispatch fallback prompts | Separate attempt/dedupe state and model switching. |
| Background fallback handler | child session error/retry | requeues one background task on fallback model | Separate attempt state from delegation recovery. |
| Sync task loop | prompt/poll errors | retries prompt or creates a fallback session | Separate attempt state; inner fallback can occur after the outer paid decision. |
| External watchdog script | server/process symptoms | supervises/restarts outside the plugin | Must remain operational supervision only; it cannot own worker retry policy. |

The `cancelIssued` set in delegation-first reduces duplicate cancellation, but effect deduplication does not establish single ownership. Two authorities can still select different models, issue prompts in different sessions, record incompatible attempt state, or wake at different times.

## Current authorization ownership

Initial `task` dispatch performs free-first selection and a paid-consent check in `tools.ts`. Background launch can then perform a resource-governor check in `BackgroundManager.authorizeLaunch()`. Recovery relaunch has a separate authorization adapter. Sync fallback, background fallback, and runtime fallback have their own model-transition code.

This creates three risks:

- Authorization can describe the initially selected model while a later fallback executes another model.
- A path without a consent registry or effective price can behave differently from a path that has both.
- Equivalent mutation operations can be classified differently. On OpenCode 1.19.3, `apply_patch` is the native mutation tool, while the canonical classifier only names `edit` and `write`; unknown tools and unknown shell commands default to control.

The target is one pure dispatch decision:

```text
authorizeDispatch({
  rootSession,
  assignment,
  attempt,
  workerIdentity,
  effectiveProviderModel,
  pricing,
  reason,
  approval
}) -> ALLOW_FREE | ALLOW_PAID(consumptionToken) | BLOCK(reason)
```

The caller must consume any paid token atomically with attempt creation. If the effective model changes, the old decision is invalid.

Tool authorization similarly starts from normalized effect, not tool spelling:

```text
control | metadata | narrow_read | broad_read | mutation | test_build | delegation
```

Unknown or opaque execution is mutation/broad by default, never control. A caller-provided marker cannot make a source mutation safe. Policy may authorize mechanical writes to explicit OMO state/evidence paths, but source and configuration mutations remain subject to the same root/worker decision.

## Target ownership

### Worker coordinator

One coordinator owns:

- assignment and attempt identity;
- admission and dispatch authorization;
- state transitions;
- deadline evaluation and stall classification;
- retry selection and exhaustion;
- terminal compare-and-set;
- durable terminal outbox creation.

It exposes signal methods such as `onSessionCreated`, `onPromptAccepted`, `onProviderResponse`, `onProgress`, `onSessionMissing`, `onProcessExit`, `onEmptyTurn`, and `onCancelRequested`. Signal producers do not decide the outcome.

### OpenCode session executor

The background/sync adapter owns mechanical work only:

- create, prompt, inspect, abort, and delete child sessions;
- return normalized observations to the coordinator;
- capture bounded result/error payloads;
- never select a retry model or terminal outcome by itself.

Sync and background are delivery modes over the same assignment/attempt ledger. Sync returns the durable terminal payload directly when its caller remains attached. Background relies on the terminal outbox.

### Durable ledger and outbox

Each assignment record contains:

- assignment id and parent/root identity;
- immutable attempt ids and effective models;
- authorization decision/consumption reference;
- current nonterminal state and timestamps;
- final outcome, reason, and bounded result;
- terminal event id;
- wake outbox state and acknowledgement evidence.

Only a compare-and-set from a nonterminal state may write the terminal event. Duplicate events return the existing outcome. Cleanup is permitted only after that write succeeds.

Outbox states are `pending`, `dispatched`, and `acknowledged`. `dispatched` is not terminal delivery. Startup reconciliation retries `pending` and stale `dispatched` entries with the same event id. Parent-side injection/dedupe uses that event id, so replay cannot duplicate completed work.

### Supervisor timer

One unref'd timer scans coordinator deadlines. It makes no model calls and performs no unbounded filesystem or database scan. Its cadence is derived from the nearest deadline with a lower bound that prevents busy polling. Disposal stops it before session/process cleanup.

Runtime fallback may remain as a root-session provider feature, but child sessions must delegate fallback decisions to the worker coordinator. The first-prompt watchdog cannot independently abort or re-prompt a registered child.

### Process owner

`task-process-ownership` remains the exclusive process termination service. The coordinator requests cleanup by exact assignment/session ownership id. Repeated cleanup requests are idempotent. Session lifecycle hooks may signal cleanup needs, but they do not directly enumerate or kill unrelated processes.

## Terminal and restart protocol

```text
observation
  -> coordinator validates current attempt
  -> optional bounded result capture
  -> terminal compare-and-set
  -> persist terminal payload + outbox event
  -> release concurrency/paid slot/process ownership
  -> abort/delete child session when policy permits
  -> outbox dispatcher wakes parent
  -> parent acknowledgement marks outbox acknowledged
```

On startup:

1. Load non-pruned assignment records.
2. Replay terminal outbox entries that are pending or stale-dispatched.
3. Reconcile nonterminal attempts against OpenCode session existence and observable output.
4. Reattach a demonstrably live attempt; otherwise terminalize it as blocked after the configured orphan deadline.
5. Never create a replacement for an assignment with a completed terminal event.

## Migration sequence

1. Close the demonstrated authorization equivalence gaps (`apply_patch`, opaque shell execution, legitimate diagnostics).
2. Add terminal compare-and-set and durable outbox semantics behind existing manager APIs.
3. Put background and sync attempts into the same ledger.
4. Route watchdog, liveness, empty-turn, deletion, and process-exit signals to the coordinator.
5. Disable secondary child fallback/retry authority after parity tests pass.
6. Unify effective-model authorization for initial, retry, relaunch, resume, and fallback dispatch.
7. Add the repeated real OpenCode fake-provider regression gate.
8. Add clean-build release manifests and atomic deploy/rollback tooling. Deployment requires separate human approval.

Each migration step must preserve the prior production behavior until the replacement passes real isolated OpenCode scenarios. No step may add a new fallback layer to conceal a broken owner.

## Runtime acceptance matrix

The controlled local provider must exercise these scenarios sequentially:

| Scenario | Required observation |
|---|---|
| Normal completion | One completed outcome, durable result, one acknowledged wake. |
| Stall before first response | Coordinator detects deadline without parent activity; bounded retry or blocked outcome. |
| Stall mid-response | Partial output is preserved; retry policy is bounded and deduplicated. |
| Empty assistant response | No indefinite running task; failed or blocked terminal outcome. |
| Worker/session disappearance | Durable blocked/failed result and parent wake survive deletion. |
| Plugin restart | Live attempt reattaches or expires once; terminal outbox replays once. |
| Cancellation | Exact owned resources released; unrelated processes remain alive. |
| Parent idle | Parent starts a follow-up turn without a human message. |
| Authorization denial | No child session/provider request is created. |
| Paid model without approval | Zero paid-route requests. |
| Retry exhaustion | One blocked outcome; no abandoned running attempt. |
| Repeated unattended runs | Stable process count, memory, CPU, watchers, and evidence growth. |

The harness must isolate HOME and every XDG directory, use only local fake providers, compare the real OpenCode database session count before and after, enforce per-scenario timeouts, and prove all spawned processes exited. Heavy suites run sequentially and stop when sustained package temperature reaches 90°C.

## Release boundary

Source, build, and deployment are separate states:

```text
clean Git commit + lockfile + pinned toolchain
  -> verified build
  -> immutable versioned artifact + manifest
  -> explicitly authorized atomic deployment
```

The manifest records commit, clean-tree assertion, Bun/OpenCode versions, bundle hash and size, QA artifact hashes, and rollback target. Production must not load a mutable development checkout once the versioned release path is introduced. Rollback switches to a previous immutable artifact; it never rebuilds in production.

## Non-goals

- No new generic multi-harness abstraction.
- No automatic paid fallback.
- No unbounded provider probing.
- No TUI accounting work in the core stabilization path.
- No production deployment as part of implementation or QA.
