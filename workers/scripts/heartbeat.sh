#!/usr/bin/env bash
# Job liveness heartbeat (M-05). Failures are NOT swallowed.
# After HEARTBEAT_MAX_CONSECUTIVE_FAILURES consecutive PATCH failures, exit 1
# so the pipeline step can fail rather than silently drifting into E005.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgos-callback.sh
source "${SCRIPT_DIR}/lib/pgos-callback.sh"

INTERVAL="${HEARTBEAT_INTERVAL:-15}"
MAX_CONSEC="${HEARTBEAT_MAX_CONSECUTIVE_FAILURES:-3}"
consec=0

: "${PGOS_BASE_URL:?PGOS_BASE_URL required}"
: "${JOB_ID:?JOB_ID required}"
: "${CALLBACK_TOKEN:?CALLBACK_TOKEN required}"

while true; do
  if pgos_patch_job_heartbeat '{}'; then
    consec=0
  else
    consec=$((consec + 1))
    echo "heartbeat: failure ${consec}/${MAX_CONSEC} for job ${JOB_ID}" >&2
    if [[ "$consec" -ge "$MAX_CONSEC" ]]; then
      echo "heartbeat: exiting after ${consec} consecutive failures (auth/network)" >&2
      exit 1
    fi
  fi
  sleep "$INTERVAL"
done
