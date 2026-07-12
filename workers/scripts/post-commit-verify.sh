#!/usr/bin/env bash
# Post-commit reimport; rollback from S3 snapshot on failure (§4.1 step 8)
# Cross-machine: reimport + restore via commit-agent ForcedCommand verbs (C-02, C-03).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgos-s3.sh
source "${SCRIPT_DIR}/lib/pgos-s3.sh"
# shellcheck source=lib/pgos-remote.sh
source "${SCRIPT_DIR}/lib/pgos-remote.sh"

TARGET_ROOT="${TARGET_PROJECT_ROOT:-/var/godot/projects/${PROJECT_ID}}"
timeout="${REIMPORT_TIMEOUT_SEC:-300}"
max="${REIMPORT_MAX_RETRIES:-2}"
delays=(10 30)
attempt=0

: "${CALLBACK_TOKEN:?CALLBACK_TOKEN required}"
: "${PGOS_BASE_URL:?PGOS_BASE_URL required}"

# H-11: always secure-delete ephemeral key after post-commit (success or failure)
PGOS_SSH_KEEP_KEY=0
export PGOS_SSH_KEEP_KEY
pgos_register_ssh_key_cleanup

curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
  -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"POST_COMMIT_VERIFY"}'

run_reimport() {
  local logf="/tmp/post_reimport_${JOB_ID}.log"
  if [[ "${COMMIT_STRATEGY}" == "cross-machine" ]]; then
    # Default-on remote verify. Break-glass only: PGOS_REMOTE_VERIFY=0 (unsafe — documents wrong FS).
    if [[ "${PGOS_REMOTE_VERIFY:-1}" == "0" ]]; then
      echo "WARNING: PGOS_REMOTE_VERIFY=0 — verifying on runner filesystem (unsafe for cross-machine)" >&2
      set +e
      timeout "$timeout" godot --headless --editor --quit --path "$TARGET_ROOT" >"$logf" 2>&1
      local code=$?
      set -e
      echo "$code"
      return 0
    fi
    : "${TARGET_HOST:?TARGET_HOST required for cross-machine reimport}"
    set +e
    pgos_ssh_agent "reimport ${TARGET_ROOT} ${timeout}" >"$logf" 2>&1
    local code=$?
    set -e
    echo "$code"
    return 0
  fi
  set +e
  timeout "$timeout" godot --headless --editor --quit --path "$TARGET_ROOT" >"$logf" 2>&1
  local code=$?
  set -e
  echo "$code"
}

do_rollback() {
  local detail="post-commit reimport failed"
  local restored=0

  if [[ "${COMMIT_STRATEGY}" == "cross-machine" ]]; then
    : "${TARGET_HOST:?TARGET_HOST required for cross-machine rollback}"
    ARCHIVE="/tmp/snapshot-restore-${JOB_ID}.tar.gz"
    if [[ -n "${PRESIGN_SNAPSHOT_GET:-}" ]]; then
      snap_code="$(pgos_curl_get "$PRESIGN_SNAPSHOT_GET" "$ARCHIVE" || echo 000)"
      if [[ "$snap_code" == "200" ]]; then
        if pgos_ssh_agent_stdin "restore ${TARGET_ROOT}" <"$ARCHIVE"; then
          echo "Remote restored from S3 snapshot archive"
          restored=1
        fi
      fi
    fi
    if [[ $restored -eq 0 ]]; then
      BACKUP="${TARGET_ROOT}.bak-${JOB_ID}"
      if pgos_ssh_agent "restore ${TARGET_ROOT} ${BACKUP}"; then
        echo "Remote restored from host backup ${BACKUP}"
        restored=1
      fi
    fi
    if [[ $restored -eq 0 ]]; then
      detail="post-commit reimport failed; remote restore also failed"
    else
      detail="post-commit reimport failed; restored remote snapshot"
    fi
  else
    if [[ -n "${PRESIGN_SNAPSHOT_GET:-}" ]]; then
      RESTORE_DIR="/tmp/rollback-${JOB_ID}"
      ARCHIVE="/tmp/snapshot-restore-${JOB_ID}.tar.gz"
      if pgos_download_and_extract "$PRESIGN_SNAPSHOT_GET" "$RESTORE_DIR" "$ARCHIVE"; then
        rm -rf "$TARGET_ROOT"
        mkdir -p "$(dirname "$TARGET_ROOT")"
        cp -a "$RESTORE_DIR" "$TARGET_ROOT"
        echo "Restored from S3 snapshot"
        restored=1
      elif [[ -d "${TARGET_ROOT}.bak-${JOB_ID}" ]]; then
        rm -rf "$TARGET_ROOT"
        mv "${TARGET_ROOT}.bak-${JOB_ID}" "$TARGET_ROOT"
        echo "Restored from local backup fallback"
        restored=1
      fi
    elif [[ -d "${TARGET_ROOT}.bak-${JOB_ID}" ]]; then
      rm -rf "$TARGET_ROOT"
      mv "${TARGET_ROOT}.bak-${JOB_ID}" "$TARGET_ROOT"
      restored=1
    fi
    if [[ $restored -eq 1 ]]; then
      detail="post-commit reimport failed; restored snapshot"
    else
      detail="post-commit reimport failed; restore unavailable"
    fi
  fi

  # Escape detail for JSON (minimal)
  detail="${detail//\"/\\\"}"
  curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
    -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"status\":\"ROLLBACK\",\"errorCode\":\"E002\",\"errorDetail\":\"${detail}\"}"
}

while true; do
  code="$(run_reimport)"
  logf="/tmp/post_reimport_${JOB_ID}.log"
  if [[ "$code" -eq 0 ]] && ! grep -qi 'uid://.*error\|Failed to load resource' "$logf" 2>/dev/null; then
    curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
      -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"status":"COMPLETED"}'
    exit 0
  fi
  if [[ $attempt -ge $max ]]; then
    echo "Post-commit reimport failed — rolling back"
    do_rollback
    exit 1
  fi
  sleep "${delays[$attempt]:-30}"
  attempt=$((attempt + 1))
done
