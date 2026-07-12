#!/usr/bin/env bash
# TEST-01 scenario 7: target editor lock via stat-lock (CM-LOCK-01).
# 7a: locked → unlocked → proceed
# 7b: persistently locked → E012 / PAUSED_EDITOR_LOCK
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export JOB_ID="job-editor-lock-$$"
export PROJECT_ID="proj-editor-lock"
export COMMIT_STRATEGY="cross-machine"
export TARGET_HOST="user@target.example"
export TARGET_PROJECT_ROOT="/var/godot/projects/p1-lock"
export CALLBACK_TOKEN="tok"
export PGOS_BASE_URL="http://127.0.0.1:9"
export PGOS_CALLBACK_MAX_RETRIES=1
export PGOS_CALLBACK_BACKOFF_SEC=0
export PGOS_EDITOR_LOCK_MAX_SEC="${PGOS_EDITOR_LOCK_MAX_SEC:-300}"

export PGOS_SMOKE_LOG="$WORK/calls.log"
: >"$PGOS_SMOKE_LOG"
LOCK_CALLS="$WORK/lock-calls"
: >"$LOCK_CALLS"

# shellcheck source=../scripts/lib/pgos-remote.sh
source "${ROOT}/workers/scripts/lib/pgos-remote.sh"
# shellcheck source=../scripts/lib/pgos-callback.sh
source "${ROOT}/workers/scripts/lib/pgos-callback.sh"

STAT_LOCK_MODE="unlock-after-2"

pgos_ssh_agent() {
  echo "SSH_AGENT $*" >>"$PGOS_SMOKE_LOG"
  case "$*" in
    stat-lock*)
      local n
      n="$(cat "$LOCK_CALLS")"
      echo $((n + 1)) >"$LOCK_CALLS"
      if [[ "$STAT_LOCK_MODE" == "unlock-after-2" && "$n" -lt 2 ]]; then
        echo "locked"
        return 0
      fi
      if [[ "$STAT_LOCK_MODE" == "always-locked" ]]; then
        echo "locked"
        return 0
      fi
      echo "unlocked"
      return 0
      ;;
    *)
      return 0
      ;;
  esac
}

curl() {
  echo "CURL $*" >>"$PGOS_SMOKE_LOG"
  prev=""
  for a in "$@"; do
    if [[ "$prev" == "-d" ]]; then
      echo "PATCH_BODY $a" >>"$PGOS_SMOKE_LOG"
    fi
    prev="$a"
  done
  echo "200"
  return 0
}

# Contract: cross-machine branch must use stat-lock (not runner FS)
if ! grep -q 'wait_for_editor_lock_remote' "${ROOT}/workers/scripts/atomic-commit.sh"; then
  echo "FAIL: atomic-commit.sh missing wait_for_editor_lock_remote"
  exit 1
fi
if ! grep -q 'PGOS_EDITOR_LOCK_MAX_SEC' "${ROOT}/workers/scripts/atomic-commit.sh"; then
  echo "FAIL: atomic-commit.sh should honor PGOS_EDITOR_LOCK_MAX_SEC for smoke/E012"
  exit 1
fi

# wait_for_editor_lock_remote semantics (mirrors atomic-commit.sh)
wait_for_editor_lock_remote_smoke() {
  local waited=0
  local delay=1
  local max="${PGOS_EDITOR_LOCK_MAX_SEC}"
  local status
  while true; do
    status="$(pgos_ssh_agent "stat-lock ${TARGET_PROJECT_ROOT}" 2>/dev/null | tr -d '\r' | tail -n1 | tr -d '[:space:]' || true)"
    if [[ "$status" == "unlocked" ]]; then
      return 0
    fi
    if [[ $waited -ge $max ]]; then
      pgos_patch_job_status "{\"status\":\"PAUSED_EDITOR_LOCK\",\"errorCode\":\"E012\",\"errorDetail\":\"target project.godot.lock persisted >${max}s (stat-lock last=${status:-empty})\"}"
      return 1
    fi
    sleep "$delay"
    waited=$((waited + delay))
  done
}

# --- 7a: locked twice then unlocked ---
: >"$PGOS_SMOKE_LOG"
: >"$LOCK_CALLS"
STAT_LOCK_MODE="unlock-after-2"
export PGOS_EDITOR_LOCK_MAX_SEC=30

if ! wait_for_editor_lock_remote_smoke; then
  echo "FAIL: 7a should unlock before max wait"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if [[ "$(cat "$LOCK_CALLS")" -lt 2 ]]; then
  echo "FAIL: 7a expected multiple stat-lock polls before unlock (calls=$(cat "$LOCK_CALLS"))"
  exit 1
fi
echo "OK: 7a — stat-lock locked→unlocked wait succeeds"

# --- 7b: always locked → E012 ---
: >"$PGOS_SMOKE_LOG"
: >"$LOCK_CALLS"
STAT_LOCK_MODE="always-locked"
export PGOS_EDITOR_LOCK_MAX_SEC=3

set +e
wait_for_editor_lock_remote_smoke
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  echo "FAIL: 7b should fail with E012 when lock persists"
  exit 1
fi

if ! grep -q 'E012' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: 7b E012 not patched"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'stat-lock' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: 7b stat-lock not invoked"
  exit 1
fi

echo "OK: 7b — persistent target lock → E012 PAUSED_EDITOR_LOCK"
echo "OK: scenario 7 — editor lock cross-machine (CM-LOCK-01)"