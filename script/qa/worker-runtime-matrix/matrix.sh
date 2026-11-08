#!/usr/bin/env bash
set -uo pipefail

REPO="${OMO_REPO:-$(GIT_MASTER=1 git rev-parse --show-toplevel)}"
PLUGIN_DIST="${PLUGIN_DIST:-$REPO/dist/index.js}"
EVID_ROOT="${EVID_ROOT:-$REPO/.omo/evidence/$(date +%Y%m%d)-worker-runtime-matrix}"
RUNNER="$REPO/script/qa/worker-runtime-matrix/run.sh"
FAILS=0
mkdir -p "$EVID_ROOT"

note() { printf '%s\n' "$*" | tee -a "$EVID_ROOT/matrix-summary.txt"; }
fail() { FAILS=$((FAILS + 1)); note "FAIL: $*"; }
pass() { note "PASS: $*"; }

run_case() {
  local scenario="$1"
  local label="$2"
  local timeout_seconds="${3:-140}"
  local evidence="$EVID_ROOT/$label"
  note "RUN scenario=$scenario label=$label"
  if systemd-run --user --scope --quiet -p CPUQuota=75% \
    timeout --signal=TERM --kill-after=10s "${timeout_seconds}s" \
    env OMO_REPO="$REPO" PLUGIN_DIST="$PLUGIN_DIST" EVID="$evidence" \
      EXPECTED_PLUGIN_SHA256="$PLUGIN_SHA256" EXPECTED_SOURCE_FINGERPRINT="$SOURCE_FINGERPRINT" \
    bash "$RUNNER" "$scenario" 2>&1 | tee "$EVID_ROOT/$label.console.txt"; then
    pass "scenario=$scenario label=$label"
  else
    fail "scenario=$scenario label=$label"
  fi
}

PLUGIN_SHA256=$(sha256sum "$PLUGIN_DIST" | awk '{print $1}')
SOURCE_FINGERPRINT=$(cd "$REPO" && find packages/omo-opencode/src -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')
note "plugin_dist=$PLUGIN_DIST sha256=$PLUGIN_SHA256"
note "source_fingerprint=$SOURCE_FINGERPRINT"
note "started_at=$(date --iso-8601=seconds)"

run_case normal normal-1
run_case stall stall
run_case empty empty
run_case provider-quota provider-quota
run_case incident repeated-empty-incident 360
run_case cancel cancel
run_case compact compact
run_case normal normal-2
run_case normal normal-3

mapfile -t NORMAL_METRICS < <(
  for label in normal-1 normal-2 normal-3; do
    sed -n 's/^metrics //p' "$EVID_ROOT/$label/summary.txt" | tail -1
  done
)
if [ "${#NORMAL_METRICS[@]}" -ne 3 ]; then
  fail "missing repeated-normal metrics"
else
  printf '%s\n' "${NORMAL_METRICS[@]}" >"$EVID_ROOT/repeated-normal-metrics.txt"
  read -r RSS_MIN RSS_MAX FD_MIN FD_MAX INOTIFY_MIN INOTIFY_MAX BYTES_MIN BYTES_MAX CPU_MAX WALL_MAX < <(
    printf '%s\n' "${NORMAL_METRICS[@]}" | awk '
      {
        for (i = 1; i <= NF; i++) {
          split($i, pair, "=")
          value[pair[1], NR] = pair[2] + 0
        }
      }
      END {
        keys[1] = "rss_kb"; keys[2] = "fd_count"; keys[3] = "inotify_fds"; keys[4] = "sandbox_bytes"
        for (k = 1; k <= 4; k++) {
          name = keys[k]
          min = value[name, 1]; max = value[name, 1]
          for (r = 2; r <= NR; r++) {
            if (value[name, r] < min) min = value[name, r]
            if (value[name, r] > max) max = value[name, r]
          }
          printf "%d %d ", min, max
        }
        cpu = 0; wall = 0
        for (r = 1; r <= NR; r++) {
          if (value["cpu_ticks", r] > cpu) cpu = value["cpu_ticks", r]
          if (value["wall_seconds", r] > wall) wall = value["wall_seconds", r]
        }
        printf "%d %d\n", cpu, wall
      }
    '
  )
  [ "$RSS_MAX" -le $((RSS_MIN * 2 + 32768)) ] \
    && pass "repeated RSS bounded min=$RSS_MIN max=$RSS_MAX KiB" \
    || fail "repeated RSS growth min=$RSS_MIN max=$RSS_MAX KiB"
  [ $((FD_MAX - FD_MIN)) -le 16 ] \
    && pass "repeated fd usage stable min=$FD_MIN max=$FD_MAX" \
    || fail "repeated fd growth min=$FD_MIN max=$FD_MAX"
  [ $((INOTIFY_MAX - INOTIFY_MIN)) -le 4 ] \
    && pass "repeated inotify usage stable min=$INOTIFY_MIN max=$INOTIFY_MAX" \
    || fail "repeated inotify growth min=$INOTIFY_MIN max=$INOTIFY_MAX"
  [ "$BYTES_MAX" -le $((BYTES_MIN * 2 + 1048576)) ] \
    && pass "repeated sandbox artifact size bounded min=$BYTES_MIN max=$BYTES_MAX bytes" \
    || fail "repeated sandbox artifact growth min=$BYTES_MIN max=$BYTES_MAX bytes"
  [ "$CPU_MAX" -le 50000 ] \
    && pass "per-run CPU bounded max_ticks=$CPU_MAX" \
    || fail "per-run CPU exceeded bound max_ticks=$CPU_MAX"
  [ "$WALL_MAX" -lt 140 ] \
    && pass "per-run wall time bounded max_seconds=$WALL_MAX" \
    || fail "per-run wall time exceeded bound max_seconds=$WALL_MAX"
fi

if pgrep -af 'opencode serve .*omo-worker-matrix|worker-runtime-matrix/fake-provider\.mjs' \
  >"$EVID_ROOT/orphan-processes.txt" 2>&1; then
  fail "runtime-matrix process remained after the suite"
else
  pass "no runtime-matrix process remained after the suite"
fi

note "finished_at=$(date --iso-8601=seconds)"
note "fails=$FAILS"
sha256sum "$EVID_ROOT"/*.console.txt "$EVID_ROOT"/*/summary.txt \
  >"$EVID_ROOT/SHA256SUMS" 2>/dev/null || true

if [ "$FAILS" -ne 0 ]; then
  echo "WORKER_RUNTIME_MATRIX_SUITE_FAILED fails=$FAILS" >&2
  exit 1
fi
echo "WORKER_RUNTIME_MATRIX_SUITE_OK"
