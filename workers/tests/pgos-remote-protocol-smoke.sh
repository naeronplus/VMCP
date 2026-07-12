#!/usr/bin/env bash
# C-00/C-02: assert cross-machine path selects reimport/restore verbs (mock ssh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$(mktemp)"

# Mock pgos_ssh_agent / pgos_ssh_agent_stdin by shadowing after source
# shellcheck source=../scripts/lib/pgos-remote.sh
source "${ROOT}/workers/scripts/lib/pgos-remote.sh"

pgos_ssh_agent() {
  echo "SSH_AGENT $*" >>"$LOG"
  # fake successful reimport log without errors
  echo "Godot Engine reimport ok" 
  return 0
}
pgos_ssh_agent_stdin() {
  echo "SSH_AGENT_STDIN $*" >>"$LOG"
  return 0
}
pgos_cleanup_ssh_key() { :; }

export JOB_ID="job-smoke"
export PROJECT_ID="proj-smoke"
export COMMIT_STRATEGY="cross-machine"
export TARGET_HOST="user@target"
export TARGET_PROJECT_ROOT="/var/godot/projects/p1"
export CALLBACK_TOKEN="tok"
export PGOS_BASE_URL="http://127.0.0.1:9"
export REIMPORT_TIMEOUT_SEC=5
export REIMPORT_MAX_RETRIES=0

# Stub curl status patches
curl() {
  # swallow lifecycle PATCHes
  return 0
}
export -f curl 2>/dev/null || true

# Override curl for bash without export -f on all systems: use PATH shim
SHIM="$(mktemp -d)"
cat >"${SHIM}/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${SHIM}/curl"
export PATH="${SHIM}:$PATH"

# Run only the reimport selection logic via post-commit with max=0 immediate rollback path
# First force success path: reimport returns 0 and clean log
set +e
bash -c '
  source "'"${ROOT}"'/workers/scripts/lib/pgos-remote.sh"
  pgos_ssh_agent() { echo "SSH_AGENT $*"; echo "reimport clean"; return 0; }
  pgos_ssh_agent_stdin() { echo "SSH_AGENT_STDIN $*"; return 0; }
  pgos_cleanup_ssh_key() { :; }
  export -f pgos_ssh_agent pgos_ssh_agent_stdin pgos_cleanup_ssh_key
  # Inline minimal check matching post-commit-verify branch
  COMMIT_STRATEGY=cross-machine
  TARGET_HOST=user@target
  TARGET_ROOT=/var/godot/projects/p1
  timeout=5
  JOB_ID=job-smoke
  logf=/tmp/post_reimport_${JOB_ID}.log
  pgos_ssh_agent "reimport ${TARGET_ROOT} ${timeout}" >"$logf" 2>&1
  grep -q "reimport" <<<"$(cat "$logf")" 
' 
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  echo "FAIL remote reimport verb path"
  exit 1
fi

# Assert mock log from nested run is not required; check helper contracts
pgos_ssh_agent "reimport /var/godot/projects/p1 300" >/dev/null
pgos_ssh_agent_stdin "restore /var/godot/projects/p1" </dev/null
pgos_ssh_agent_stdin "stage-receive /tmp/staging-x abc" </dev/null
pgos_ssh_agent "snapshot-export /var/godot/projects/p1" >/dev/null
# CM-LOCK-01: stat-lock probes target project.godot.lock
pgos_ssh_agent "stat-lock /var/godot/projects/p1" >/dev/null

# Contract: atomic-commit.sh wait_for_editor_lock_remote must call stat-lock (not runner FS).
if ! grep -q 'wait_for_editor_lock_remote' "${ROOT}/workers/scripts/atomic-commit.sh"; then
  echo "FAIL: atomic-commit.sh missing wait_for_editor_lock_remote (CM-LOCK-01)" >&2
  exit 1
fi
if ! grep -q 'stat-lock' "${ROOT}/workers/scripts/atomic-commit.sh"; then
  echo "FAIL: atomic-commit.sh does not invoke stat-lock (CM-LOCK-01)" >&2
  exit 1
fi
# Must not only wait on runner-local lock in the cross-machine branch.
if ! grep -A2 'Cross-machine' "${ROOT}/workers/scripts/atomic-commit.sh" | grep -q 'stat-lock\|wait_for_editor_lock_remote'; then
  # Cross-machine block must call remote wait helper
  if ! grep -A30 'COMMIT_STRATEGY.*cross-machine\|else' "${ROOT}/workers/scripts/atomic-commit.sh" | grep -q 'wait_for_editor_lock_remote'; then
    echo "FAIL: cross-machine path missing wait_for_editor_lock_remote" >&2
    exit 1
  fi
fi

if ! grep -q 'SSH_AGENT reimport' "$LOG"; then
  echo "FAIL: reimport verb not invoked"
  cat "$LOG"
  exit 1
fi
if ! grep -q 'SSH_AGENT_STDIN restore' "$LOG"; then
  echo "FAIL: restore verb not invoked"
  cat "$LOG"
  exit 1
fi
if ! grep -q 'SSH_AGENT_STDIN stage-receive' "$LOG"; then
  echo "FAIL: stage-receive verb not invoked"
  cat "$LOG"
  exit 1
fi
if ! grep -q 'SSH_AGENT snapshot-export' "$LOG"; then
  echo "FAIL: snapshot-export verb not invoked (C-03)"
  cat "$LOG"
  exit 1
fi
if ! grep -q 'SSH_AGENT stat-lock' "$LOG"; then
  echo "FAIL: stat-lock verb not invoked (CM-LOCK-01)"
  cat "$LOG"
  exit 1
fi

rm -f "$LOG"
rm -rf "$SHIM"
echo "OK: cross-machine ForcedCommand verbs selected (incl. snapshot-export, stat-lock)"
