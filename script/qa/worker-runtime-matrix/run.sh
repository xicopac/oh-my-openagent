#!/usr/bin/env bash
set -uo pipefail

SCENARIO="${1:-${OMO_RUNTIME_SCENARIO:-normal}}"
case "$SCENARIO" in
  normal|stall|empty|cancel|compact) ;;
  *) printf 'unknown scenario: %s\n' "$SCENARIO" >&2; exit 2 ;;
esac

REPO="${OMO_REPO:-$(GIT_MASTER=1 git rev-parse --show-toplevel)}"
PLUGIN_DIST="${PLUGIN_DIST:-$REPO/dist/index.js}"
OPENCODE="${OPENCODE:-/home/xicopac/.opencode/bin/opencode}"
NODE="${NODE:-$(command -v node)}"
HARNESS="$REPO/script/qa/worker-runtime-matrix"
EVID="${EVID:-$REPO/.omo/evidence/$(date +%Y%m%d)-worker-runtime-matrix/$SCENARIO}"
mkdir -p /tmp/opencode "$EVID"
SANDBOX=$(mktemp -d "/tmp/opencode/omo-worker-matrix.$SCENARIO.XXXXXX")
PROJECT="$SANDBOX/project"
HOME_DIR="$SANDBOX/home"
GOV_DIR="$HOME_DIR/.omo/governance"
WORKER_DIR="$HOME_DIR/.omo/workers"
DB="$SANDBOX/data/opencode/matrix.db"
FAKE_PID=""
LAUNCH_PID=""
OPENCODE_PID=""
SENTINEL_PID=""
ROOT_SESSION=""
FAILS=0
START_SECONDS=$(date +%s)
OMO_LOG="${TMPDIR:-/tmp}/oh-my-opencode.log"
OMO_LOG_OFFSET=$(wc -c <"$OMO_LOG" 2>/dev/null || printf '0')

mkdir -p "$PROJECT/.omo" "$HOME_DIR" "$SANDBOX/config/opencode" "$SANDBOX/data/opencode"   "$SANDBOX/cache/oh-my-opencode" "$SANDBOX/state"
printf '%s\n' "# Worker runtime matrix: $SCENARIO" >"$PROJECT/README.md"
GIT_MASTER=1 git -C "$PROJECT" init -q
GIT_MASTER=1 git -C "$PROJECT" add -- README.md
GIT_MASTER=1 git -C "$PROJECT" -c user.name='OMO Runtime QA'   -c user.email='omo-runtime-qa@example.invalid' commit -qm 'Initialize runtime fixture'

note() { printf '%s\n' "$*" | tee -a "$SANDBOX/summary.txt"; }
fail() { FAILS=$((FAILS + 1)); note "FAIL: $*"; }
pass() { note "PASS: $*"; }

stop_runtime() {
  if [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
    kill -TERM "$OPENCODE_PID" 2>/dev/null || true
  fi
  if [ -n "$LAUNCH_PID" ] && [ "$LAUNCH_PID" != "$OPENCODE_PID" ]     && kill -0 "$LAUNCH_PID" 2>/dev/null; then
    kill -TERM "$LAUNCH_PID" 2>/dev/null || true
  fi
  if [ -n "$FAKE_PID" ] && kill -0 "$FAKE_PID" 2>/dev/null; then
    kill -TERM "$FAKE_PID" 2>/dev/null || true
  fi
  for _ in $(seq 1 50); do
    local any_alive=0
    [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null && any_alive=1
    [ -n "$FAKE_PID" ] && kill -0 "$FAKE_PID" 2>/dev/null && any_alive=1
    [ "$any_alive" -eq 0 ] && break
    sleep 0.1
  done
  if [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
    kill -KILL "$OPENCODE_PID" 2>/dev/null || true
  fi
  if [ -n "$FAKE_PID" ] && kill -0 "$FAKE_PID" 2>/dev/null; then
    kill -KILL "$FAKE_PID" 2>/dev/null || true
  fi
  [ -n "$LAUNCH_PID" ] && wait "$LAUNCH_PID" 2>/dev/null || true
  [ -n "$FAKE_PID" ] && wait "$FAKE_PID" 2>/dev/null || true
}

stop_sentinel() {
  if [ -n "$SENTINEL_PID" ] && kill -0 "$SENTINEL_PID" 2>/dev/null; then
    kill -TERM "$SENTINEL_PID" 2>/dev/null || true
    wait "$SENTINEL_PID" 2>/dev/null || true
  fi
}

capture_evidence() {
  cp "$SANDBOX/fake.log" "$EVID/fake-provider.log" 2>/dev/null || true
  cp "$SANDBOX/opencode.log" "$EVID/opencode.log" 2>/dev/null || true
  cp "$SANDBOX/summary.txt" "$EVID/summary.txt" 2>/dev/null || true
  tail -c "+$((OMO_LOG_OFFSET + 1))" "$OMO_LOG" >"$EVID/plugin.log" 2>/dev/null || true
  [ -f "$SANDBOX/compact-response.json" ]     && cp "$SANDBOX/compact-response.json" "$EVID/compact-response.json" 2>/dev/null || true
}

cleanup() {
  stop_runtime
  stop_sentinel
  if [ -d "$SANDBOX" ]; then capture_evidence; fi
  case "$SANDBOX" in
    /tmp/opencode/omo-worker-matrix.*) rm -rf -- "$SANDBOX" ;;
    *) printf 'refusing unexpected sandbox cleanup: %s\n' "$SANDBOX" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

real_db_count() {
  sqlite3 "$HOME/.local/share/opencode/opencode.db" 'select count(*) from session;' 2>/dev/null || printf 'unavailable'
}
real_worker_count() {
  find "$HOME/.omo/workers" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l
}

REAL_BEFORE=$(real_db_count)
REAL_WORKERS_BEFORE=$(real_worker_count)
note "scenario=$SCENARIO"
note "sandbox=$SANDBOX"
note "plugin_dist=$PLUGIN_DIST sha256=$(sha256sum "$PLUGIN_DIST" | awk '{print $1}')"
note "real_db_sessions_before=$REAL_BEFORE"
note "real_worker_records_before=$REAL_WORKERS_BEFORE"

cat >"$PROJECT/.omo/omo.jsonc" <<'JSON'
{
  "[opencode]": {
    "categories": {
      "quick": { "model": "openai/gpt-fake-free" }
    },
    "resource_governor": {
      "consent": {
        "require_paid_escalation": false,
        "require_hard_budget_increase": false
      },
      "watchdog": {
        "dispatch_timeout_ms": 3000,
        "request_start_timeout_ms": 3000,
        "provider_response_timeout_ms": 3000,
        "quiet_stall_threshold_ms": 4500,
        "wedged_threshold_ms": 7000
      }
    }
  }
}
JSON

MODELS_JSON='{"gpt-fake-free":{"tool_call":true,"cost":{"input":0,"output":0,"cache":{"read":0,"write":0}},"limit":{"context":200000,"output":8192}}}'
ALT_MODELS_JSON='{"nemotron-3-ultra-free":{"tool_call":true,"cost":{"input":0,"output":0,"cache":{"read":0,"write":0}},"limit":{"context":200000,"output":8192}}}'
CACHE_MODELS='{"openai":[{"id":"gpt-fake-free","cost":{"input":0,"output":0,"cache":{"read":0,"write":0}},"tool_call":true}],"opencode":[{"id":"nemotron-3-ultra-free","cost":{"input":0,"output":0,"cache":{"read":0,"write":0}},"tool_call":true}]}'

printf '%s' '{"openai":{"type":"api","key":"fake-key"},"opencode":{"type":"api","key":"fake-key"}}' >"$SANDBOX/data/opencode/auth.json"
printf '%s' '{"connected":["openai","opencode"],"updatedAt":"2026-11-05T00:00:00.000Z"}'   >"$SANDBOX/cache/oh-my-opencode/connected-providers.json"
printf '%s' "{\"connected\":[\"openai\",\"opencode\"],\"updatedAt\":\"2026-11-05T00:00:00.000Z\",\"models\":$CACHE_MODELS}"   >"$SANDBOX/cache/oh-my-opencode/provider-models.json"

OMO_REPO="$REPO" OMO_RUNTIME_SCENARIO="$SCENARIO" FAKE_LLM_LOG="$SANDBOX/fake.log"   setsid "$NODE" "$HARNESS/fake-provider.mjs" >"$SANDBOX/fake-stdout.log" 2>&1 &
FAKE_PID=$!
for _ in $(seq 1 80); do
  FAKE_PORT=$(sed -n 's/^FAKE_PORT=//p' "$SANDBOX/fake-stdout.log" 2>/dev/null | head -1)
  [ -n "$FAKE_PORT" ] && break
  sleep 0.1
done
if [ -z "${FAKE_PORT:-}" ]; then fail "fake provider did not start"; exit 1; fi
pass "fake provider on port $FAKE_PORT"

cat >"$SANDBOX/config/opencode/opencode.jsonc" <<JSONC
{
  "plugin": ["file://$PLUGIN_DIST"],
  "model": "openai/gpt-fake-free",
  "provider": {
    "openai": {
      "options": {"apiKey":"fake-key","baseURL":"http://127.0.0.1:$FAKE_PORT/v1","timeout":60000},
      "models": $MODELS_JSON
    },
    "opencode": {
      "npm": "@ai-sdk/openai",
      "options": {"apiKey":"fake-key","baseURL":"http://127.0.0.1:$FAKE_PORT/v1","timeout":60000},
      "models": $ALT_MODELS_JSON
    }
  },
  "agent": {
    "build": {"model":"openai/gpt-fake-free"},
    "explore": {"model":"openai/gpt-fake-free"},
    "sisyphus": {"model":"openai/gpt-fake-free"},
    "sisyphus-junior": {"model":"openai/gpt-fake-free"}
  },
  "permission": {"bash":"allow","task":"allow"}
}
JSONC

PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
setsid env -u OPENCODE -u OPENCODE_PID -u OPENCODE_CONFIG_DIR   -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u OPENROUTER_API_KEY -u GEMINI_API_KEY   HOME="$HOME_DIR" OPENCODE_TEST_HOME="$HOME_DIR"   XDG_DATA_HOME="$SANDBOX/data" XDG_CONFIG_HOME="$SANDBOX/config"   XDG_CACHE_HOME="$SANDBOX/cache" XDG_STATE_HOME="$SANDBOX/state"   OPENCODE_CONFIG_DIR="$SANDBOX/config/opencode" OPENCODE_DB="$DB"   OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1   OPENCODE_DISABLE_TELEMETRY=1 OMO_DISABLE_POSTHOG=1   /bin/bash -lc "cd '$PROJECT' && exec '$OPENCODE' serve --hostname 127.0.0.1 --port $PORT --print-logs --log-level INFO"   >"$SANDBOX/opencode.log" 2>&1 &
LAUNCH_PID=$!

for _ in $(seq 1 120); do
  curl -sf --max-time 1 "http://127.0.0.1:$PORT/global/health" >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -sf --max-time 1 "http://127.0.0.1:$PORT/global/health" >/dev/null 2>&1; then
  fail "isolated opencode server did not become healthy"
  exit 1
fi
pass "isolated opencode server healthy on port $PORT"

OPENCODE_PID=$(for p in $(pgrep -f "serve --hostname 127.0.0.1 --port $PORT" 2>/dev/null); do
  [ "$(cat "/proc/$p/comm" 2>/dev/null)" = "opencode" ] && { printf '%s' "$p"; break; }
done)
[ -n "$OPENCODE_PID" ] && pass "isolated opencode pid=$OPENCODE_PID" || fail "isolated opencode pid not found"

ROOT_SESSION=$(curl -sf -X POST "http://127.0.0.1:$PORT/session?directory=$PROJECT"   -H 'content-type: application/json' -d "{\"title\":\"worker matrix $SCENARIO\"}" | jq -r '.id // empty')
if [ -z "$ROOT_SESSION" ]; then fail "root session could not be created"; exit 1; fi
pass "root session $ROOT_SESSION"

curl -sf -X POST "http://127.0.0.1:$PORT/session/$ROOT_SESSION/prompt_async?directory=$PROJECT"   -H 'content-type: application/json'   -d "{\"parts\":[{\"type\":\"text\",\"text\":\"AUTONOMOUS_ROOT_PROBE scenario=$SCENARIO\"}]}" >/dev/null || {
    fail "root prompt could not be dispatched"; exit 1;
  }
pass "single root prompt dispatched (no further human messages)"

if [ "$SCENARIO" = "cancel" ]; then
  sleep 180 &
  SENTINEL_PID=$!
  pass "unrelated sentinel process started pid=$SENTINEL_PID"
fi

for _ in $(seq 1 240); do
  grep -q 'child=true' "$SANDBOX/fake.log" 2>/dev/null && break
  sleep 0.25
done
grep -q 'child=true' "$SANDBOX/fake.log" 2>/dev/null   && pass "child provider request observed" || fail "child provider request not observed"

if [ "$SCENARIO" = "compact" ]; then
  curl -sf -X POST "http://127.0.0.1:$FAKE_PORT/control/expect-summary" >/dev/null     || fail "could not arm fake compaction response"
  COMPACT_STATUS=$(curl -sS --max-time 30 -o "$SANDBOX/compact-response.json" -w '%{http_code}'     -X POST "http://127.0.0.1:$PORT/session/$ROOT_SESSION/summarize?directory=$PROJECT"     -H 'content-type: application/json'     -d '{"providerID":"openai","modelID":"gpt-fake-free","auto":true}' || printf '000')
  if [ "$COMPACT_STATUS" = "200" ]; then
    pass "real OpenCode summarize endpoint completed during in-flight worker"
  else
    fail "OpenCode summarize endpoint status=$COMPACT_STATUS"
  fi
fi

for _ in $(seq 1 320); do
  if [ "$SCENARIO" = "cancel" ]; then
    grep -q 'cancellation_confirmed' "$SANDBOX/fake.log" 2>/dev/null && break
  else
    grep -q 'parent_resumed' "$SANDBOX/fake.log" 2>/dev/null && break
  fi
  sleep 0.25
done

WORKER_TERMINALS=$(python3 - "$WORKER_DIR" <<'PY'
import json, os, sys
root = sys.argv[1]
found = []
if os.path.isdir(root):
    for name in sorted(os.listdir(root)):
        if not name.endswith(".json"):
            continue
        try:
            record = json.load(open(os.path.join(root, name), encoding="utf-8"))
        except Exception:
            continue
        outcome = record.get("terminalOutcome")
        if outcome:
            found.append(f"{record.get('workerID')}:{outcome}:{record.get('wakeState', 'legacy')}:{record.get('result', '')}")
print("\n".join(found))
PY
)
note "worker_terminals=$(printf '%s' "$WORKER_TERMINALS" | tr '\n' ';')"

case "$SCENARIO" in
  normal)
    [[ "$WORKER_TERMINALS" == *":completed:"* && "$WORKER_TERMINALS" == *"CHILD_COMPLETED"* ]]       && pass "normal worker completed durably" || fail "normal worker did not complete durably"
    ;;
  stall|compact)
    [[ "$WORKER_TERMINALS" == *":completed:"* && "$WORKER_TERMINALS" == *"CHILD_RECOVERED"* ]]       && pass "$SCENARIO worker recovered and completed durably" || fail "$SCENARIO worker did not recover durably"
    ;;
  empty)
    if [[ "$WORKER_TERMINALS" == *":completed:"* || "$WORKER_TERMINALS" == *":failed:"* || "$WORKER_TERMINALS" == *":blocked:"* ]]; then
      pass "empty response reached a defined terminal state"
    else
      fail "empty response left no defined terminal state"
    fi
    grep -q 'empty_response' "$SANDBOX/fake.log" 2>/dev/null       && pass "provider emitted an empty response" || fail "empty response was not exercised"
    ;;
  cancel)
    [[ "$WORKER_TERMINALS" == *":cancelled:"* ]]       && pass "explicit background cancellation persisted cancelled state"       || fail "explicit cancellation did not persist cancelled state"
    grep -q 'cancellation_confirmed' "$SANDBOX/fake.log" 2>/dev/null       && pass "root continued after cancellation without another human message"       || fail "root did not continue after cancellation"
    grep -q 'held_connection_closed label=cancel-child-' "$SANDBOX/fake.log" 2>/dev/null       && pass "cancellation released the worker-owned provider request"       || fail "worker-owned provider request remained open after cancellation"
    if [ -n "$SENTINEL_PID" ] && kill -0 "$SENTINEL_PID" 2>/dev/null; then
      pass "cancellation left the unrelated sentinel process alive"
    else
      fail "cancellation affected the unrelated sentinel process"
    fi
    ;;
esac

if [ "$SCENARIO" = "compact" ]; then
  grep -q 'compaction_summary' "$SANDBOX/fake.log" 2>/dev/null     && pass "fake provider served the real compaction request"     || fail "compaction provider request was not observed"
fi

if [ "$SCENARIO" != "cancel" ]; then
  [[ "$WORKER_TERMINALS" == *":acknowledged:"* ]]     && pass "terminal wake was acknowledged after parent output"     || fail "terminal wake was not acknowledged"
  grep -q 'parent_resumed' "$SANDBOX/fake.log" 2>/dev/null     && pass "parent resumed without another human message"     || fail "parent did not resume autonomously"
fi

REQUESTED_MODELS=$(sed -n 's/.* model=\([^ ]*\).*/\1/p' "$SANDBOX/fake.log" | sort -u | paste -sd, -)
if [ "$REQUESTED_MODELS" = "gpt-fake-free" ]   || [ "$REQUESTED_MODELS" = "gpt-fake-free,nemotron-3-ultra-free" ]; then
  pass "provider ledger contains only configured free fake models"
else
  fail "unexpected provider models requested: ${REQUESTED_MODELS:-none}"
fi

REAL_AFTER=$(real_db_count)
REAL_WORKERS_AFTER=$(real_worker_count)
[ "$REAL_BEFORE" = "$REAL_AFTER" ] && pass "real opencode DB unchanged" || fail "real opencode DB changed"
[ "$REAL_WORKERS_BEFORE" = "$REAL_WORKERS_AFTER" ] && pass "real worker store unchanged" || fail "real worker store changed"

RSS_KB=$(awk '/VmRSS:/{print $2}' "/proc/$OPENCODE_PID/status" 2>/dev/null || printf '0')
CPU_TICKS=$(awk '{print $14+$15}' "/proc/$OPENCODE_PID/stat" 2>/dev/null || printf '0')
FD_COUNT=$(ls "/proc/$OPENCODE_PID/fd" 2>/dev/null | wc -l)
INOTIFY_FDS=$(for fd in /proc/"$OPENCODE_PID"/fd/*; do
  [ "$(readlink "$fd" 2>/dev/null)" = "anon_inode:inotify" ] && printf '1\n'
done | wc -l)
SANDBOX_BYTES=$(du -sb "$SANDBOX" 2>/dev/null | awk '{print $1}')
WALL_SECONDS=$(($(date +%s) - START_SECONDS))
note "metrics rss_kb=$RSS_KB cpu_ticks=$CPU_TICKS fd_count=$FD_COUNT inotify_fds=$INOTIFY_FDS sandbox_bytes=$SANDBOX_BYTES wall_seconds=$WALL_SECONDS"

stop_runtime
if [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
  fail "orphan OpenCode pid remains: $OPENCODE_PID"
elif pgrep -f "serve --hostname 127.0.0.1 --port $PORT" >/dev/null 2>&1; then
  fail "orphan OpenCode process remains for port $PORT"
else
  pass "isolated OpenCode process stopped"
fi
if [ -n "$FAKE_PID" ] && kill -0 "$FAKE_PID" 2>/dev/null; then
  fail "orphan fake-provider pid remains: $FAKE_PID"
else
  pass "local fake-provider process stopped"
fi
stop_sentinel
if [ -n "$SENTINEL_PID" ] && kill -0 "$SENTINEL_PID" 2>/dev/null; then
  fail "unrelated sentinel process could not be released by exact PID"
elif [ "$SCENARIO" = "cancel" ]; then
  pass "unrelated sentinel cleanup completed by exact PID"
fi

capture_evidence

if [ "$FAILS" -ne 0 ]; then
  echo "WORKER_RUNTIME_MATRIX_FAILED scenario=$SCENARIO fails=$FAILS" >&2
  exit 1
fi
echo "WORKER_RUNTIME_MATRIX_OK scenario=$SCENARIO"
