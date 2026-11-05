# Worker runtime reliability matrix

This gate drives the real local OpenCode server with the candidate plugin bundle and
a local fake OpenAI-compatible provider. Each case receives an isolated home, XDG
tree, database, worker store, ports, and process group.

Run the complete sequential matrix with:

```bash
bash script/qa/worker-runtime-matrix/matrix.sh
```

The cases cover normal completion, a stalled provider with bounded free recovery,
an empty provider response, explicit background cancellation, compaction while a
worker is in flight, and three repeated unattended normal runs. The suite rejects
real-store mutation, paid or unknown model requests, missing terminal states,
human-message-dependent wake-up, orphan processes, unbounded wall time, and
material growth in RSS, file descriptors, inotify descriptors, or evidence size.

Evidence is written only beneath the ignored `.omo/evidence/` tree.
