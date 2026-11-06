# Worker runtime reliability matrix

This gate drives the real local OpenCode server with the candidate plugin bundle and
a local fake OpenAI-compatible provider. Each case receives an isolated home, XDG
tree, database, worker store, ports, and process group.

Run the complete sequential matrix with:

```bash
bash script/qa/worker-runtime-matrix/matrix.sh
```

The cases cover normal completion, a stalled provider with bounded free recovery,
an empty provider response, the Garmin repeated-empty incident, explicit background
cancellation, compaction while a worker is in flight, and three repeated unattended
normal runs. The suite rejects
real-store mutation, paid or unknown model requests, missing terminal states,
human-message-dependent wake-up, orphan processes, unbounded wall time, and
material growth in RSS, file descriptors, inotify descriptors, or evidence size.

The incident case disables only the isolated live-listener shortcut, leaves the
parent idle with a real unanswered `question` tool in OpenCode history, and makes
every child/provider fallback complete without text or tool output. It requires
the parent to retrieve each exact terminal worker, enter bounded recovery, and
emit a definitive exit after recovery halt. The case binds the candidate bundle
digest to a fingerprint of the OpenCode adapter source tree.

Evidence is written only beneath the ignored `.omo/evidence/` tree.
