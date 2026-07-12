#!/usr/bin/env bash
# PGOS worker callback HTTP helpers (M-05 / M-06).
# Validates HTTP status on lifecycle PATCH; retries 5xx; hard-fails 401/403.
# shellcheck shell=bash

# Max attempts for transient failures (5xx / network). Default 3.
: "${PGOS_CALLBACK_MAX_RETRIES:=3}"
# Initial backoff seconds (doubles each retry).
: "${PGOS_CALLBACK_BACKOFF_SEC:=1}"

# pgos_callback_http_code PATH JSON_BODY
# Prints HTTP status code to stdout; body discarded (never log secrets).
# Exit 0 always from this low-level helper — callers interpret the code.
pgos_callback_http_code() {
  local path="$1"
  local body="$2"
  local url code
  : "${PGOS_BASE_URL:?PGOS_BASE_URL required for callbacks}"
  : "${CALLBACK_TOKEN:?CALLBACK_TOKEN required for callbacks}"
  url="${PGOS_BASE_URL}${path}"
  # -sS: silent + show errors; write body to /dev/null; emit only status
  code="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      -X PATCH "$url" \
      -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$body" 2>/dev/null || echo "000"
  )"
  # curl may append 000 after real output on failure; take last 3 digits
  if [[ "$code" =~ ([0-9]{3})$ ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo "000"
  fi
}

# pgos_callback_patch PATH JSON_BODY
# - 2xx → return 0
# - 401/403 → log status only, return 1 (no retry)
# - 5xx / 000 → retry up to PGOS_CALLBACK_MAX_RETRIES with exponential backoff
# - other 4xx → return 1 immediately
pgos_callback_patch() {
  local path="$1"
  local body="$2"
  local attempt=0
  local backoff="${PGOS_CALLBACK_BACKOFF_SEC}"
  local max="${PGOS_CALLBACK_MAX_RETRIES}"
  local code

  if [[ -z "${path:-}" ]]; then
    echo "pgos_callback_patch: path required" >&2
    return 1
  fi

  while [[ $attempt -lt $max ]]; do
    attempt=$((attempt + 1))
    code="$(pgos_callback_http_code "$path" "$body")"

    if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
      return 0
    fi

    if [[ "$code" == "401" || "$code" == "403" ]]; then
      echo "pgos_callback_patch: HTTP ${code} auth rejected for ${path} (attempt ${attempt})" >&2
      return 1
    fi

    if [[ "$code" =~ ^5[0-9][0-9]$ || "$code" == "000" ]]; then
      if [[ $attempt -ge $max ]]; then
        echo "pgos_callback_patch: HTTP ${code} for ${path} after ${attempt} attempts" >&2
        return 1
      fi
      echo "pgos_callback_patch: HTTP ${code} for ${path}; retry ${attempt}/${max} in ${backoff}s" >&2
      sleep "$backoff"
      backoff=$((backoff * 2))
      continue
    fi

    # Other client errors (400, 404, 409, …) — no retry
    echo "pgos_callback_patch: HTTP ${code} for ${path} (no retry)" >&2
    return 1
  done

  echo "pgos_callback_patch: exhausted retries for ${path}" >&2
  return 1
}

# pgos_patch_job_status JSON_BODY
# PATCH /api/v1/jobs/:id/status
pgos_patch_job_status() {
  local body="$1"
  : "${JOB_ID:?JOB_ID required}"
  pgos_callback_patch "/api/v1/jobs/${JOB_ID}/status" "$body"
}

# pgos_patch_job_heartbeat [JSON_BODY]
# PATCH /api/v1/jobs/:id/heartbeat
pgos_patch_job_heartbeat() {
  local body="${1:-{}}"
  : "${JOB_ID:?JOB_ID required}"
  # Optional fencing token body when provided via env
  if [[ -n "${FENCING_TOKEN:-}" && "$body" == "{}" ]]; then
    body="{\"fencingToken\":\"${FENCING_TOKEN}\"}"
  fi
  pgos_callback_patch "/api/v1/jobs/${JOB_ID}/heartbeat" "$body"
}
