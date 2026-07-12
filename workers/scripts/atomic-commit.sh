#!/usr/bin/env bash
# Atomic commit with fencing token + S3 snapshot (§4.1, §4.3)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgos-s3.sh
source "${SCRIPT_DIR}/lib/pgos-s3.sh"

STAGING="/tmp/staging-${JOB_ID}"
TARGET_ROOT="${TARGET_PROJECT_ROOT:-/var/godot/projects/${PROJECT_ID}}"
FENCING_TOKEN="${FENCING_TOKEN:-}"

: "${CALLBACK_TOKEN:?CALLBACK_TOKEN required}"
: "${PGOS_BASE_URL:?PGOS_BASE_URL required}"

curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
  -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"COMMITTING\",\"fencingToken\":\"${FENCING_TOKEN}\"}"

# Pre-commit snapshot to S3
if [[ -d "$TARGET_ROOT" && -n "${PRESIGN_SNAPSHOT_PUT:-}" ]]; then
  pgos_upload_dir_tarball "$TARGET_ROOT" "$PRESIGN_SNAPSHOT_PUT" "/tmp/snapshot-${JOB_ID}.tar.gz"
  echo "Pre-commit snapshot uploaded to S3"
fi

wait_for_editor_lock() {
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

wait_for_editor_lock

if [[ "${COMMIT_STRATEGY}" == "same-machine" ]]; then
  TMP_LIVE="${TARGET_ROOT}.staging-${JOB_ID}"
  rm -rf "$TMP_LIVE"
  mkdir -p "$(dirname "$TARGET_ROOT")"
  cp -a "$STAGING" "$TMP_LIVE"
  if [[ -d "$TARGET_ROOT" ]]; then
    BACKUP="${TARGET_ROOT}.bak-${JOB_ID}"
    mv "$TARGET_ROOT" "$BACKUP"
  fi
  mv "$TMP_LIVE" "$TARGET_ROOT"
  echo "same-machine atomic mv complete"
else
  : "${TARGET_HOST:?TARGET_HOST required for cross-machine — set job metadata.targetHost}"
  REMOTE_TMP="/tmp/staging-${JOB_ID}"
  tar -C "$STAGING" -czf "/tmp/staging-${JOB_ID}.tar.gz" .
  SUM=$(sha256sum "/tmp/staging-${JOB_ID}.tar.gz" | awk '{print $1}')

  SSH_OPTS=(
    -o StrictHostKeyChecking=accept-new
    -o UserKnownHostsFile=/tmp/pgos_known_hosts
    -o IdentitiesOnly=yes
    -o BatchMode=yes
    -o ConnectTimeout=30
  )
  if [[ -n "${SSH_PRIVATE_KEY_PEM:-}" ]]; then
    KEY_FILE="/tmp/pgos-ssh-key-${JOB_ID}"
    printf '%s\n' "$SSH_PRIVATE_KEY_PEM" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    SSH_OPTS+=(-i "$KEY_FILE")
  fi

  scp "${SSH_OPTS[@]}" "/tmp/staging-${JOB_ID}.tar.gz" "${TARGET_HOST}:${REMOTE_TMP}.tar.gz"
  ssh "${SSH_OPTS[@]}" "$TARGET_HOST" "mkdir -p ${REMOTE_TMP} && tar -xzf ${REMOTE_TMP}.tar.gz -C ${REMOTE_TMP} && echo ${SUM} > ${REMOTE_TMP}.sha256"
  REMOTE_SUM=$(ssh "${SSH_OPTS[@]}" "$TARGET_HOST" "sha256sum ${REMOTE_TMP}.tar.gz | awk '{print \$1}'")
  if [[ "$REMOTE_SUM" != "$SUM" ]]; then
    curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
      -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"checksum mismatch after transfer"}'
    exit 1
  fi
  export PGOS_COMMIT_NONCE="${JOB_ID}-$(date +%s)"
  export PGOS_JOB_ID="$JOB_ID"
  export PGOS_LOCK_KEY="${PGOS_LOCK_KEY:-}"
  export PGOS_LOCK_OWNER="${PGOS_LOCK_OWNER:-}"
  export PGOS_REQUIRE_FENCING=true
  if ! ssh "${SSH_OPTS[@]}" "$TARGET_HOST" "commit ${FENCING_TOKEN} ${REMOTE_TMP} ${TARGET_ROOT}"; then
    curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
      -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"status":"COMMIT_FAILED","errorCode":"E004","errorDetail":"agent commit failed or fencing rejected"}'
    exit 1
  fi
fi