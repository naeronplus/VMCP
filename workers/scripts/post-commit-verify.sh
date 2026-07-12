#!/usr/bin/env bash
# Post-commit reimport; rollback from S3 snapshot on failure (§4.1 step 8)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgos-s3.sh
source "${SCRIPT_DIR}/lib/pgos-s3.sh"

TARGET_ROOT="${TARGET_PROJECT_ROOT:-/var/godot/projects/${PROJECT_ID}}"
timeout="${REIMPORT_TIMEOUT_SEC:-300}"
max="${REIMPORT_MAX_RETRIES:-2}"
delays=(10 30)
attempt=0

: "${CALLBACK_TOKEN:?CALLBACK_TOKEN required}"
: "${PGOS_BASE_URL:?PGOS_BASE_URL required}"

curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
  -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"POST_COMMIT_VERIFY"}'

while true; do
  set +e
  timeout "$timeout" godot --headless --editor --quit --path "$TARGET_ROOT" >"/tmp/post_reimport_${JOB_ID}.log" 2>&1
  code=$?
  set -e
  if [[ $code -eq 0 ]] && ! grep -qi 'uid://.*error\|Failed to load resource' "/tmp/post_reimport_${JOB_ID}.log"; then
    curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
      -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"status":"COMPLETED"}'
    exit 0
  fi
  if [[ $attempt -ge $max ]]; then
    echo "Post-commit reimport failed — rolling back from S3 snapshot"
    if [[ -n "${PRESIGN_SNAPSHOT_GET:-}" ]]; then
      RESTORE_DIR="/tmp/rollback-${JOB_ID}"
      ARCHIVE="/tmp/snapshot-restore-${JOB_ID}.tar.gz"
      if pgos_download_and_extract "$PRESIGN_SNAPSHOT_GET" "$RESTORE_DIR" "$ARCHIVE"; then
        rm -rf "$TARGET_ROOT"
        mkdir -p "$(dirname "$TARGET_ROOT")"
        cp -a "$RESTORE_DIR" "$TARGET_ROOT"
        echo "Restored from S3 snapshot"
      elif [[ -d "${TARGET_ROOT}.bak-${JOB_ID}" ]]; then
        rm -rf "$TARGET_ROOT"
        mv "${TARGET_ROOT}.bak-${JOB_ID}" "$TARGET_ROOT"
        echo "Restored from local backup fallback"
      fi
    elif [[ -d "${TARGET_ROOT}.bak-${JOB_ID}" ]]; then
      rm -rf "$TARGET_ROOT"
      mv "${TARGET_ROOT}.bak-${JOB_ID}" "$TARGET_ROOT"
    fi
    curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
      -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"status":"ROLLBACK","errorCode":"E002","errorDetail":"post-commit reimport failed; restored snapshot"}'
    exit 1
  fi
  sleep "${delays[$attempt]:-30}"
  attempt=$((attempt + 1))
done