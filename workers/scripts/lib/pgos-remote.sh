#!/usr/bin/env bash
# Cross-machine SSH helpers for ForcedCommand commit-agent-once verbs (C-00).
# Ephemeral key lifecycle (H-11): write-only materialization, secure delete, no PEM logs.
# shellcheck shell=bash

pgos_ssh_key_file() {
  echo "/tmp/pgos-ssh-key-${JOB_ID:?JOB_ID required}"
}

pgos_known_hosts_file() {
  echo "/tmp/pgos_known_hosts_${JOB_ID:?JOB_ID required}"
}

# Secure-delete a single path (shred when available; else zero-fill + rm).
# Never prints file contents.
pgos_secure_delete_file() {
  local f="${1:-}"
  [[ -n "$f" && -e "$f" ]] || return 0

  # Best-effort: remove world readability first
  chmod 600 "$f" 2>/dev/null || true

  if command -v shred >/dev/null 2>&1; then
    # -u remove, -z final zero pass, -n 1 overwrite
    shred -u -z -n 1 "$f" 2>/dev/null || true
  fi

  if [[ -e "$f" ]]; then
    local sz=0
    sz=$(wc -c <"$f" 2>/dev/null | tr -d '[:space:]' || echo 0)
    if [[ "${sz:-0}" =~ ^[0-9]+$ ]] && [[ "$sz" -gt 0 ]] && command -v dd >/dev/null 2>&1; then
      dd if=/dev/zero of="$f" bs="$sz" count=1 conv=notrunc status=none 2>/dev/null \
        || dd if=/dev/zero of="$f" bs="$sz" count=1 conv=notrunc 2>/dev/null \
        || : >"$f"
    else
      : >"$f"
    fi
    rm -f "$f" 2>/dev/null || true
  fi

  # Legacy path without job id (older scripts)
  return 0
}

# Materialize ephemeral key to disk (mode 600). Never logs PEM.
# Registers EXIT/ERR/INT/TERM cleanup unless PGOS_SSH_KEEP_KEY=1 (see trap helper).
pgos_materialize_ssh_key() {
  local key
  key="$(pgos_ssh_key_file)"

  if [[ -f "$key" ]]; then
    chmod 600 "$key" 2>/dev/null || true
    pgos_register_ssh_key_cleanup
    return 0
  fi

  if [[ -z "${SSH_PRIVATE_KEY_PEM:-}" ]]; then
    return 1
  fi

  # Write key material without echoing it
  umask 077
  printf '%s\n' "$SSH_PRIVATE_KEY_PEM" >"$key"
  chmod 600 "$key"
  # Drop PEM from environment of this shell after materializing to file
  # (file is the sole source for subsequent ssh calls in this process tree).
  unset SSH_PRIVATE_KEY_PEM
  export SSH_PRIVATE_KEY_PEM=""

  pgos_register_ssh_key_cleanup
  return 0
}

# Install trap that cleans key/known_hosts unless PGOS_SSH_KEEP_KEY=1.
# Safe to call multiple times (idempotent).
pgos_register_ssh_key_cleanup() {
  # shellcheck disable=SC2317
  _pgos_ssh_key_trap() {
    # Intermediate scripts (atomic-commit success → post-commit) may set KEEP=1
    if [[ "${PGOS_SSH_KEEP_KEY:-0}" == "1" ]]; then
      return 0
    fi
    pgos_cleanup_ssh_key
  }
  trap _pgos_ssh_key_trap EXIT ERR INT TERM
}

pgos_ssh_opts() {
  SSH_OPTS=(
    -o StrictHostKeyChecking=accept-new
    -o "UserKnownHostsFile=$(pgos_known_hosts_file)"
    -o IdentitiesOnly=yes
    -o BatchMode=yes
    -o ConnectTimeout=30
  )
  local key
  key="$(pgos_ssh_key_file)"

  if [[ ! -f "$key" ]]; then
    if ! pgos_materialize_ssh_key; then
      echo "pgos-remote: no SSH key file and SSH_PRIVATE_KEY_PEM unset (job=${JOB_ID:-?})" >&2
      return 1
    fi
  else
    chmod 600 "$key" 2>/dev/null || true
    pgos_register_ssh_key_cleanup
  fi

  # Pass identity path only — never log or print key body
  SSH_OPTS+=(-i "$key")
}

# Remove ephemeral key + per-job known_hosts. Idempotent. Never logs PEM.
pgos_cleanup_ssh_key() {
  local key hosts
  # JOB_ID may be unset in some cleanup paths — best-effort
  if [[ -n "${JOB_ID:-}" ]]; then
    key="$(pgos_ssh_key_file 2>/dev/null || true)"
    hosts="$(pgos_known_hosts_file 2>/dev/null || true)"
  else
    key=""
    hosts=""
  fi

  if [[ -n "$key" ]]; then
    pgos_secure_delete_file "$key"
  fi
  # Glob leftover keys for this job pattern if JOB_ID known
  if [[ -n "${JOB_ID:-}" ]]; then
    for f in /tmp/pgos-ssh-key-"${JOB_ID}" /tmp/pgos-ssh-key-"${JOB_ID}".*; do
      [[ -e "$f" ]] && pgos_secure_delete_file "$f"
    done
  fi

  if [[ -n "$hosts" && -f "$hosts" ]]; then
    rm -f "$hosts" 2>/dev/null || true
  fi
  # Legacy known_hosts without job suffix
  if [[ -f /tmp/pgos_known_hosts ]]; then
    rm -f /tmp/pgos_known_hosts 2>/dev/null || true
  fi

  # Clear in-process PEM if still present (never print)
  unset SSH_PRIVATE_KEY_PEM 2>/dev/null || true
  export SSH_PRIVATE_KEY_PEM=""

  # Do not echo key paths with existence that might confuse logs with material —
  # a single neutral status line is OK.
  if [[ "${PGOS_SSH_CLEANUP_QUIET:-0}" != "1" ]]; then
    echo "pgos-remote: ephemeral SSH key cleanup complete"
  fi
}

# Assert key file is gone (for tests / post-job checks). Exit 1 if present.
pgos_assert_ssh_key_absent() {
  local key
  key="$(pgos_ssh_key_file)"
  if [[ -e "$key" ]]; then
    echo "pgos-remote: ERROR key file still present after cleanup" >&2
    return 1
  fi
  return 0
}

# ssh TARGET_HOST with ForcedCommand-safe original command: verb + args only
pgos_ssh_agent() {
  : "${TARGET_HOST:?TARGET_HOST required}"
  pgos_ssh_opts || return 1
  ssh "${SSH_OPTS[@]}" "$TARGET_HOST" "$*"
}

# Pipe stdin to remote verb (stage-receive / restore archive)
pgos_ssh_agent_stdin() {
  : "${TARGET_HOST:?TARGET_HOST required}"
  pgos_ssh_opts || return 1
  ssh "${SSH_OPTS[@]}" "$TARGET_HOST" "$*"
}
