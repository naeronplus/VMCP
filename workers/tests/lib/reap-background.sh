#!/usr/bin/env bash
# Reap background PIDs before shell exit.
# Git Bash under Node child_process.spawnSync waits for background jobs
# before running EXIT traps — explicit kill+wait prevents verify:r3 hangs.
# node.exe on Windows may ignore SIGTERM; use bounded wait + SIGKILL.
reap_bg_pid() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  if command -v timeout >/dev/null 2>&1; then
    timeout 3 wait "$pid" 2>/dev/null || true
  else
    local i=0
    while kill -0 "$pid" 2>/dev/null && [[ "$i" -lt 30 ]]; do
      sleep 0.1
      i=$((i + 1))
    done
  fi
  kill -9 "$pid" 2>/dev/null || true
  if command -v timeout >/dev/null 2>&1; then
    timeout 2 wait "$pid" 2>/dev/null || true
  else
    wait "$pid" 2>/dev/null || true
  fi
}