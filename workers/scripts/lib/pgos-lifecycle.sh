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
    wait "${PGOS_HEARTBEAT_PID}" 2>/dev/null || true
    PGOS_HEARTBEAT_PID=""
  fi
}

pgos_heartbeat_trap() {
  # shellcheck disable=SC2317
  _pgos_lifecycle_cleanup() {
    pgos_stop_heartbeat
    if declare -F pgos_cleanup_ssh_key >/dev/null 2>&1; then
      pgos_cleanup_ssh_key
    fi
  }
  trap _pgos_lifecycle_cleanup EXIT INT TERM
}
