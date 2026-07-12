#!/usr/bin/env bash
# Cross-machine SSH helpers for ForcedCommand commit-agent-once verbs (C-00).
# Never uses remote shell or scp — only verb argv + optional stdin.
# shellcheck shell=bash

pgos_ssh_key_file() {
  echo "/tmp/pgos-ssh-key-${JOB_ID:?JOB_ID required}"
}

pgos_known_hosts_file() {
  echo "/tmp/pgos_known_hosts_${JOB_ID:?JOB_ID required}"
}

pgos_ssh_opts() {
  # Populate global SSH_OPTS array for this job
  SSH_OPTS=(
    -o StrictHostKeyChecking=accept-new
    -o "UserKnownHostsFile=$(pgos_known_hosts_file)"
    -o IdentitiesOnly=yes
    -o BatchMode=yes
    -o ConnectTimeout=30
  )
  local key
  key="$(pgos_ssh_key_file)"
  if [[ -n "${SSH_PRIVATE_KEY_PEM:-}" ]]; then
    if [[ ! -f "$key" ]]; then
      printf '%s\n' "$SSH_PRIVATE_KEY_PEM" >"$key"
      chmod 600 "$key"
    fi
    SSH_OPTS+=(-i "$key")
  elif [[ -f "$key" ]]; then
    SSH_OPTS+=(-i "$key")
  fi
}

pgos_cleanup_ssh_key() {
  local key hosts
  key="$(pgos_ssh_key_file 2>/dev/null || true)"
  hosts="$(pgos_known_hosts_file 2>/dev/null || true)"
  if [[ -n "$key" && -f "$key" ]]; then
    if command -v shred >/dev/null 2>&1; then
      shred -u "$key" 2>/dev/null || rm -f "$key"
    else
      : >"$key"
      rm -f "$key"
    fi
  fi
  if [[ -n "$hosts" && -f "$hosts" ]]; then
    rm -f "$hosts"
  fi
}

# ssh TARGET_HOST with ForcedCommand-safe original command: verb + args only
pgos_ssh_agent() {
  : "${TARGET_HOST:?TARGET_HOST required}"
  pgos_ssh_opts
  # shellcheck disable=SC2086
  ssh "${SSH_OPTS[@]}" "$TARGET_HOST" "$*"
}

# Pipe stdin to remote verb (stage-receive / restore archive)
pgos_ssh_agent_stdin() {
  : "${TARGET_HOST:?TARGET_HOST required}"
  pgos_ssh_opts
  # shellcheck disable=SC2086
  ssh "${SSH_OPTS[@]}" "$TARGET_HOST" "$*"
}
