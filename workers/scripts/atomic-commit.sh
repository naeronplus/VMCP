#!/usr/bin/env bash
# Atomic commit with fencing token + S3 snapshot (§4.1, §4.3)
# Cross-machine: ForcedCommand verbs only (C-00) — no scp/remote shell.
# M-06: status PATCH via pgos_callback_patch
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgos-s3.sh
source "${SCRIPT_DIR}/lib/pgos-s3.sh"
# shellcheck source=lib/pgos-remote.sh
source "${SCRIPT_DIR}/lib/pgos-remote.sh"
# shellcheck source=lib/pgos-callback.sh
source "${SCRIPT_DIR}/lib/pgos-callback.sh"

STAGING="/tmp/staging-${JOB_ID}"
TARGET_ROOT="${TARGET_PROJECT_ROOT:-/var/godot/projects/${PROJECT_ID}}"
FENCING_TOKEN="${FENCING_TOKEN:-}"

: "${CALLBACK_TOKEN:?CALLBACK_TOKEN required}"
: "${PGOS_BASE_URL:?PGOS_BASE_URL required}"

# H-11: secure-delete ephemeral key on failure / non-cross-machine exit.
# After successful cross-machine commit, keep key for post-commit-verify (same pipeline).
PGOS_SSH_KEEP_KEY=0
pgos_register_ssh_key_cleanup

pgos_patch_job_status "{\"status\":\"COMMITTING\",\"fencingToken\":\"${FENCING_TOKEN}\"}"

# Pre-commit snapshot to S3 (C-03 backup hierarchy primary source)
# - same-machine: archive runner-local TARGET_ROOT
# - cross-machine: NEVER use runner-local TARGET_ROOT — snapshot live tree on target via
#   commit-agent verb snapshot-export, then upload (see cross-machine block below)
if [[ "${COMMIT_STRATEGY}" == "same-machine" ]]; then
  if [[ -d "$TARGET_ROOT" && -n "${PRESIGN_SNAPSHOT_PUT:-}" ]]; then
    pgos_upload_dir_tarball "$TARGET_ROOT" "$PRESIGN_SNAPSHOT_PUT" "/tmp/snapshot-${JOB_ID}.tar.gz"
    echo "Pre-commit snapshot uploaded to S3 (same-machine local tree)"
  fi
fi

wait_for_editor_lock_local() {
  local lockfile="${TARGET_ROOT}/project.godot.lock"
  local waited=0
  local delay=5
  local max=300
  while [[ -f "$lockfile" ]]; do
    if [[ $waited -ge $max ]]; then
      pgos_patch_job_status '{"status":"PAUSED_EDITOR_LOCK","errorCode":"E012","errorDetail":"project.godot.lock persisted >5m"}'
      exit 1
    fi
    sleep "$delay"
    waited=$((waited + delay))
    delay=$((delay * 2))
    if [[ $delay -gt 60 ]]; then delay=60; fi
  done
}

# CM-LOCK-01: probe target host project.godot.lock via commit-agent stat-lock (not runner FS).
# Same exponential backoff as local wait (5s … 60s cap, max 300s).
wait_for_editor_lock_remote() {
  local waited=0
  local delay=5
  local max="${PGOS_EDITOR_LOCK_MAX_SEC:-300}"
  local status
  while true; do
    status="$(pgos_ssh_agent "stat-lock ${TARGET_ROOT}" 2>/dev/null | tr -d '\r' | tail -n1 | tr -d '[:space:]' || true)"
    if [[ "$status" == "unlocked" ]]; then
      return 0
    fi
    if [[ $waited -ge $max ]]; then
      pgos_patch_job_status "{\"status\":\"PAUSED_EDITOR_LOCK\",\"errorCode\":\"E012\",\"errorDetail\":\"target project.godot.lock persisted >5m (stat-lock last=${status:-empty})\"}"
      exit 1
    fi
    echo "Waiting for target editor lock (stat-lock=${status:-empty} waited=${waited}s)"
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
  # Cross-machine: wait on *target* editor lock via stat-lock (CM-LOCK-01), never runner-local FS.
  : "${TARGET_HOST:?TARGET_HOST required for cross-machine — set job metadata.targetHost}"
  wait_for_editor_lock_remote
  REMOTE_TMP="/tmp/staging-${JOB_ID}"
  ARCHIVE="/tmp/staging-${JOB_ID}.tar.gz"
  tar -C "$STAGING" -czf "$ARCHIVE" .
  SUM=$(sha256sum "$ARCHIVE" | awk '{print $1}')

  # C-03 primary: pre-commit snapshot of *target live tree* via snapshot-export (not runner FS).
  # Staging tarball is NOT a rollback source. Requires PRESIGN_SNAPSHOT_PUT for primary path.
  if [[ -n "${PRESIGN_SNAPSHOT_PUT:-}" ]]; then
    PRE_SNAP="/tmp/pre-snapshot-${JOB_ID}.tar.gz"
    if ! pgos_ssh_agent "snapshot-export ${TARGET_ROOT}" >"$PRE_SNAP"; then
      pgos_patch_job_status '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"pre-commit snapshot-export failed"}'
      exit 1
    fi
    if [[ ! -s "$PRE_SNAP" ]]; then
      pgos_patch_job_status '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"pre-commit snapshot-export failed: empty archive"}'
      exit 1
    fi
    if ! pgos_upload_file "$PRE_SNAP" "$PRESIGN_SNAPSHOT_PUT"; then
      pgos_patch_job_status '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"pre-commit snapshot S3 upload failed"}'
      exit 1
    fi
    echo "Pre-commit snapshot uploaded to S3 (target snapshot-export)"
    rm -f "$PRE_SNAP"
  else
    pgos_patch_job_status '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"pre-commit snapshot presign missing (PRESIGN_SNAPSHOT_PUT)"}'
    exit 1
  fi

  if ! pgos_ssh_agent_stdin "stage-receive ${REMOTE_TMP} ${SUM}" <"$ARCHIVE"; then
    pgos_patch_job_status '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"stage-receive failed or checksum mismatch"}'
    exit 1
  fi

  # Lock owner/key primarily from authorized_keys environment= (provision-time, C-05).
  # Approach B: also pass lock key/owner as commit args (agent prefers args when present).
  NONCE="${JOB_ID}-$(date +%s 2>/dev/null || node -e "console.log(Date.now())")"
  if [[ -n "${PGOS_LOCK_KEY:-}" && -n "${PGOS_LOCK_OWNER:-}" ]]; then
    if ! pgos_ssh_agent commit "${FENCING_TOKEN}" "${REMOTE_TMP}" "${TARGET_ROOT}" \
      "${PGOS_LOCK_KEY}" "${PGOS_LOCK_OWNER}" "${NONCE}"; then
      pgos_patch_job_status '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"agent commit failed or fencing rejected"}'
      exit 1
    fi
  else
    if ! pgos_ssh_agent commit "${FENCING_TOKEN}" "${REMOTE_TMP}" "${TARGET_ROOT}"; then
      pgos_patch_job_status '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"agent commit failed or fencing rejected"}'
      exit 1
    fi
  fi
  echo "cross-machine commit complete via commit-agent-once"
  # Leave key file for post-commit-verify reimport/restore; post-commit + pipeline trap clean up.
  PGOS_SSH_KEEP_KEY=1
  export PGOS_SSH_KEEP_KEY
fi
