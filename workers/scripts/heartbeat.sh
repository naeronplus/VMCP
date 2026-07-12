#!/usr/bin/env bash
set -euo pipefail
INTERVAL="${HEARTBEAT_INTERVAL:-15}"
while true; do
  curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/heartbeat" \
    -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{}' || true
  sleep "$INTERVAL"
done
