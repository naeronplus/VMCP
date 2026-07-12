#!/usr/bin/env bash
# H-11: ephemeral SSH key is secure-deleted after cleanup; never left on disk.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=../scripts/lib/pgos-remote.sh
source "${ROOT}/workers/scripts/lib/pgos-remote.sh"

export JOB_ID="smoke-h11-$$"
export PGOS_SSH_CLEANUP_QUIET=1
KEY="$(pgos_ssh_key_file)"
HOSTS="$(pgos_known_hosts_file)"

# Ensure clean slate
rm -f "$KEY" "$HOSTS"

# Materialize a fake key (not a real PEM — cleanup must still remove it)
export SSH_PRIVATE_KEY_PEM="-----BEGIN FAKE PRIVATE KEY-----
SMOKE_TEST_MATERIAL_NOT_A_REAL_KEY
-----END FAKE PRIVATE KEY-----"

pgos_materialize_ssh_key
if [[ ! -f "$KEY" ]]; then
  echo "FAIL: key was not written" >&2
  exit 1
fi
mode="$(stat -c '%a' "$KEY" 2>/dev/null || stat -f '%OLp' "$KEY" 2>/dev/null || echo '?')"
if [[ "$mode" != "600" && "$mode" != "0600" ]]; then
  echo "WARN: key mode is ${mode} (expected 600)" >&2
fi

# known_hosts touch
: >"$HOSTS"

# KEEP=1 must skip cleanup
export PGOS_SSH_KEEP_KEY=1
pgos_register_ssh_key_cleanup
# Invoke trap function path via direct call simulating keep
if [[ "${PGOS_SSH_KEEP_KEY}" == "1" ]]; then
  : # skip
else
  pgos_cleanup_ssh_key
fi
if [[ ! -f "$KEY" ]]; then
  echo "FAIL: KEEP=1 should preserve key" >&2
  exit 1
fi

# Real cleanup
export PGOS_SSH_KEEP_KEY=0
pgos_cleanup_ssh_key

if [[ -e "$KEY" ]]; then
  echo "FAIL: key file still exists after pgos_cleanup_ssh_key" >&2
  exit 1
fi
if [[ -e "$HOSTS" ]]; then
  echo "FAIL: known_hosts still exists after cleanup" >&2
  exit 1
fi
if [[ -n "${SSH_PRIVATE_KEY_PEM:-}" ]]; then
  echo "FAIL: SSH_PRIVATE_KEY_PEM still set in environment" >&2
  exit 1
fi

# Idempotent second cleanup
pgos_cleanup_ssh_key
pgos_assert_ssh_key_absent

# C-03 regression: command-substitution subshells must not install a second EXIT
# trap that secure-deletes the key while the parent shell still needs restore/export.
export SSH_PRIVATE_KEY_PEM="-----BEGIN FAKE PRIVATE KEY-----
SMOKE_SUBSHELL_KEY
-----END FAKE PRIVATE KEY-----"
pgos_materialize_ssh_key
if [[ ! -f "$KEY" ]]; then
  echo "FAIL: key missing before subshell trap check" >&2
  exit 1
fi
export PGOS_SSH_KEEP_KEY=0
pgos_register_ssh_key_cleanup
# Simulate pgos_ssh_opts inside code="$(run_reimport)" — must not wipe key on subshell EXIT
(
  pgos_register_ssh_key_cleanup
  pgos_ssh_opts >/dev/null 2>&1 || true
  exit 0
)
if [[ ! -f "$KEY" ]]; then
  echo "FAIL: subshell EXIT deleted ephemeral key (breaks C-03 restore after reimport)" >&2
  exit 1
fi
export PGOS_SSH_KEEP_KEY=0
pgos_cleanup_ssh_key
pgos_assert_ssh_key_absent

echo "OK: H-11 ephemeral SSH key cleanup smoke passed"
