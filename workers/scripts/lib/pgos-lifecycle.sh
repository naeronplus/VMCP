#!/usr/bin/env bash
# Heartbeat lifecycle helpers — PID must live in the same GHA step (C-01).
# shellcheck shell=bash

PGOS_HEARTBEAT_PID=""

pgos_start_heartbeat() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  bash "${script_dir}/heartbeat.sh" &
  PGOS_HEARTBEAT_PID=$!
  export PGOS_HEARTBEAT_PID
}

pgos_stop_heartbeat() {
  if [[ -n "${PGOS_HEARTBEAT_PID:-}" ]]; then
    kill "${PGOS_HEARTBEAT_PID}" 2>/dev/null || true
    if command -v timeout >/dev/null 2>&1; then
      timeout 5 wait "${PGOS_HEARTBEAT_PID}" 2>/dev/null || true
    else
      local i=0
      while kill -0 "${PGOS_HEARTBEAT_PID}" 2>/dev/null && [[ "$i" -lt 50 ]]; do
        sleep 0.1
        i=$((i + 1))
      done
    fi
    kill -9 "${PGOS_HEARTBEAT_PID}" 2>/dev/null || true
    wait "${PGOS_HEARTBEAT_PID}" 2>/dev/null || true
    PGOS_HEARTBEAT_PID=""
  fi
}

pgos_heartbeat_trap() {
  # shellcheck disable=SC2317
  _pgos_lifecycle_cleanup() {
    pgos_stop_heartbeat
    # H-11 final safety net: always secure-delete ephemeral key at end of pipeline step
    if declare -F pgos_cleanup_ssh_key >/dev/null 2>&1; then
      PGOS_SSH_KEEP_KEY=0
      export PGOS_SSH_KEEP_KEY
      pgos_cleanup_ssh_key
    fi
  }
  trap _pgos_lifecycle_cleanup EXIT ERR INT TERM
}
