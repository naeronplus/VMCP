#!/usr/bin/env bash
# Atomic commit with fencing token + S3 snapshot (§4.1, §4.3)
# Cross-machine: ForcedCommand verbs only (C-00) — no scp/remote shell.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgos-s3.sh
source "${SCRIPT_DIR}/lib/pgos-s3.sh"
# shellcheck source=lib/pgos-remote.sh
source "${SCRIPT_DIR}/lib/pgos-remote.sh"

STAGING="/tmp/staging-${JOB_ID}"
TARGET_ROOT="${TARGET_PROJECT_ROOT:-/var/godot/projects/${PROJECT_ID}}"
FENCING_TOKEN="${FENCING_TOKEN:-}"

: "${CALLBACK_TOKEN:?CALLBACK_TOKEN required}"
: "${PGOS_BASE_URL:?PGOS_BASE_URL required}"

# Always clean up ephemeral SSH key for cross-machine jobs (H-11)
trap 'pgos_cleanup_ssh_key' EXIT INT TERM

curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
  -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"COMMITTING\",\"fencingToken\":\"${FENCING_TOKEN}\"}"

# Pre-commit snapshot to S3 (same-machine local tree; cross-machine skip if no local tree)
if [[ "${COMMIT_STRATEGY}" == "same-machine" ]]; then
  if [[ -d "$TARGET_ROOT" && -n "${PRESIGN_SNAPSHOT_PUT:-}" ]]; then
    pgos_upload_dir_tarball "$TARGET_ROOT" "$PRESIGN_SNAPSHOT_PUT" "/tmp/snapshot-${JOB_ID}.tar.gz"
    echo "Pre-commit snapshot uploaded to S3"
  fi
elif [[ -n "${PRESIGN_SNAPSHOT_PUT:-}" && -d "$TARGET_ROOT" ]]; then
  # Optional: runner may not have target tree; snapshot is best-effort for local copy only
  pgos_upload_dir_tarball "$TARGET_ROOT" "$PRESIGN_SNAPSHOT_PUT" "/tmp/snapshot-${JOB_ID}.tar.gz" || true
  echo "Pre-commit snapshot uploaded to S3 (if local tree present)"
fi

wait_for_editor_lock_local() {
  local lockfile="${TARGET_ROOT}/project.godot.lock"
  local waited=0
  local delay=5
  local max=300
  while [[ -f "$lockfile" ]]; do
    if [[ $waited -ge $max ]]; then
      curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
        -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
        -H "Content-Type: application/json" \
        -d '{"status":"PAUSED_EDITOR_LOCK","errorCode":"E012","errorDetail":"project.godot.lock persisted >5m"}'
      exit 1
    fi
    sleep "$delay"
    waited=$((waited + delay))
    delay=$((delay * 2))
    if [[ $delay -gt 60 ]]; then delay=60; fi
  done
}

if [[ "${COMMIT_STRATEGY}" == "same-machine" ]]; then
  wait_for_editor_lock_local
  TMP_LIVE="${TARGET_ROOT}.staging-${JOB_ID}"
  rm -rf "$TMP_LIVE"
  mkdir -p "$(dirname "$TARGET_ROOT")"
  cp -a "$STAGING" "$TMP_LIVE"
  if [[ -d "$TARGET_ROOT" ]]; then
    BACKUP="${TARGET_ROOT}.bak-${JOB_ID}"
    rm -rf "$BACKUP"
    mv "$TARGET_ROOT" "$BACKUP"
  fi
  mv "$TMP_LIVE" "$TARGET_ROOT"
  echo "same-machine atomic mv complete"
else
  # Cross-machine: do NOT wait on runner-local project.godot.lock (wrong filesystem).
  : "${TARGET_HOST:?TARGET_HOST required for cross-machine — set job metadata.targetHost}"
  REMOTE_TMP="/tmp/staging-${JOB_ID}"
  ARCHIVE="/tmp/staging-${JOB_ID}.tar.gz"
  tar -C "$STAGING" -czf "$ARCHIVE" .
  SUM=$(sha256sum "$ARCHIVE" | awk '{print $1}')

  # Optional: upload staging tarball as S3 snapshot of *new* content is not the rollback snapshot.
  # Rollback uses PRESIGN_SNAPSHOT_GET from pre-commit of previous live tree when available.

  if ! pgos_ssh_agent_stdin "stage-receive ${REMOTE_TMP} ${SUM}" <"$ARCHIVE"; then
    curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
      -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"stage-receive failed or checksum mismatch"}'
    exit 1
  fi

  # Lock owner/key primarily from authorized_keys environment= (provision-time, C-05).
  # Approach B: also pass lock key/owner as commit args (agent prefers args when present).
  NONCE="${JOB_ID}-$(date +%s 2>/dev/null || node -e "console.log(Date.now())")"
  if [[ -n "${PGOS_LOCK_KEY:-}" && -n "${PGOS_LOCK_OWNER:-}" ]]; then
    if ! pgos_ssh_agent commit "${FENCING_TOKEN}" "${REMOTE_TMP}" "${TARGET_ROOT}" \
      "${PGOS_LOCK_KEY}" "${PGOS_LOCK_OWNER}" "${NONCE}"; then
      curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
        -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
        -H "Content-Type: application/json" \
        -d '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"agent commit failed or fencing rejected"}'
      exit 1
    fi
  else
    if ! pgos_ssh_agent commit "${FENCING_TOKEN}" "${REMOTE_TMP}" "${TARGET_ROOT}"; then
      curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
        -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
        -H "Content-Type: application/json" \
        -d '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"agent commit failed or fencing rejected"}'
      exit 1
    fi
  fi
  echo "cross-machine commit complete via commit-agent-once"
fi
