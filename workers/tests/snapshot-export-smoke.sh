#!/usr/bin/env bash
# C-03: drive real atomic-commit.sh for cross-machine pre-commit snapshot.
# No inlined logic — PATH-mocked ssh/curl only (plan §6.2.3 + §6.2.5).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; rm -rf "/tmp/staging-${JOB_ID:-x}" "/tmp/pre-snapshot-${JOB_ID:-x}.tar.gz" "/tmp/pgos-ssh-key-${JOB_ID:-x}" 2>/dev/null || true' EXIT

export PGOS_SMOKE_LOG="$WORK/calls.log"
: >"$PGOS_SMOKE_LOG"
export PGOS_SSH_CLEANUP_QUIET=1
export PGOS_CALLBACK_MAX_RETRIES=1
export PGOS_CALLBACK_BACKOFF_SEC=0

mkdir -p "$WORK/bin"

# Mock ssh used by real pgos_ssh_agent / pgos_ssh_agent_stdin
cat >"$WORK/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LOG="${PGOS_SMOKE_LOG:?}"
MODE="${PGOS_SMOKE_SSH_MODE:-ok}"
# Parse: ssh [opts...] host remote-command...
args=("$@")
i=0
n=${#args[@]}
while [[ $i -lt $n ]]; do
  a="${args[$i]}"
  case "$a" in
    -o|-i|-p|-l|-F|-E)
      i=$((i + 2))
      ;;
    -*)
      i=$((i + 1))
      ;;
    *)
      host="$a"
      i=$((i + 1))
      remote_cmd="${args[*]:$i}"
      break
      ;;
  esac
done
echo "SSH host=${host:-?} cmd=${remote_cmd:-}" >>"$LOG"
case "${remote_cmd:-}" in
  stat-lock*)
    echo "unlocked"
    exit 0
    ;;
  snapshot-export*)
    if [[ "$MODE" == "export-fail" ]]; then
      echo "snapshot-export simulated failure" >&2
      exit 1
    fi
    if [[ "$MODE" == "export-empty" ]]; then
      # empty stdout → worker treats as empty archive
      exit 0
    fi
    # Minimal non-empty gzip payload (fake tar.gz)
    printf '\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03'
    printf 'fake-snapshot'
    printf '\x00\x00\x00\x00\x00\x00\x00\x00'
    exit 0
    ;;
  stage-receive*)
    cat >/dev/null || true
    exit 0
    ;;
  commit*)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$WORK/bin/ssh"

# Mock curl used by pgos_upload_file (PUT) and pgos_patch_job_status (PATCH + http_code)
cat >"$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LOG="${PGOS_SMOKE_LOG:?}"
MODE="${PGOS_SMOKE_CURL_MODE:-ok}"
echo "CURL $*" >>"$LOG"

# S3 presigned PUT
if printf '%s\n' "$*" | grep -q -- '-X PUT'; then
  echo "CURL_PUT $*" >>"$LOG"
  if [[ "$MODE" == "put-fail" ]]; then
    echo "curl: simulated PUT failure" >&2
    exit 22
  fi
  exit 0
fi

# Lifecycle PATCH with status code capture
if printf '%s\n' "$*" | grep -q '%{http_code}'; then
  # Capture JSON body after -d for assertions
  prev=""
  for a in "$@"; do
    if [[ "$prev" == "-d" ]]; then
      echo "PATCH_BODY $a" >>"$LOG"
    fi
    prev="$a"
  done
  echo "200"
  exit 0
fi

exit 0
EOF
chmod +x "$WORK/bin/curl"

export PATH="$WORK/bin:$PATH"

setup_job_env() {
  local suffix="$1"
  export JOB_ID="job-snap-${suffix}-$$"
  export PROJECT_ID="proj-snap"
  export COMMIT_STRATEGY="cross-machine"
  export TARGET_HOST="user@target.example"
  export TARGET_PROJECT_ROOT="/var/godot/projects/p1-c03-smoke"
  export CALLBACK_TOKEN="tok"
  export PGOS_BASE_URL="http://127.0.0.1:9"
  export FENCING_TOKEN="fence-token"
  export PRESIGN_SNAPSHOT_PUT="https://s3.example/snapshot-put"
  export PGOS_SSH_KEEP_KEY=0

  # Fresh staging payload (generated assets)
  rm -rf "/tmp/staging-${JOB_ID}"
  mkdir -p "/tmp/staging-${JOB_ID}"
  echo "new-asset" >"/tmp/staging-${JOB_ID}/file.txt"

  # Ephemeral key so real pgos_ssh_opts does not need SSH_PRIVATE_KEY_PEM
  printf 'FAKE_OPENSSH_PRIVATE_KEY\n' >"/tmp/pgos-ssh-key-${JOB_ID}"
  chmod 600 "/tmp/pgos-ssh-key-${JOB_ID}"

  # Runner-local target tree must NOT be required / used for cross-machine snapshot
  rm -rf "${TARGET_PROJECT_ROOT}" 2>/dev/null || true
}

assert_log_contains() {
  local needle="$1"
  local msg="$2"
  if ! grep -q -- "$needle" "$PGOS_SMOKE_LOG"; then
    echo "FAIL: $msg (missing: $needle)"
    cat "$PGOS_SMOKE_LOG"
    exit 1
  fi
}

# ── Happy path: real atomic-commit.sh ─────────────────────────────────
: >"$PGOS_SMOKE_LOG"
export PGOS_SMOKE_SSH_MODE=ok
export PGOS_SMOKE_CURL_MODE=ok
setup_job_env happy

set +e
bash "${ROOT}/workers/scripts/atomic-commit.sh"
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  echo "FAIL: atomic-commit.sh exited $rc on happy path"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

assert_log_contains 'snapshot-export' 'snapshot-export verb must run'
assert_log_contains 'stage-receive' 'stage-receive must run after snapshot'
assert_log_contains 'CURL_PUT' 'pre-commit archive must upload via PUT'
assert_log_contains 'commit' 'commit verb must run'

# Ordering: snapshot-export before stage-receive (plan §6.2.3.1)
snap_line="$(grep -n 'snapshot-export' "$PGOS_SMOKE_LOG" | head -1 | cut -d: -f1)"
stage_line="$(grep -n 'stage-receive' "$PGOS_SMOKE_LOG" | head -1 | cut -d: -f1)"
if [[ -z "$snap_line" || -z "$stage_line" || "$snap_line" -ge "$stage_line" ]]; then
  echo "FAIL: snapshot-export must precede stage-receive (snap=$snap_line stage=$stage_line)"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

# Never used runner-local tree for snapshot (path must still be absent)
if [[ -d "${TARGET_PROJECT_ROOT}" ]]; then
  echo "FAIL: runner-local TARGET_ROOT was created/used"
  exit 1
fi

# ── Failure: snapshot-export verb fails → COMMIT_FAILED + E004 ────────
: >"$PGOS_SMOKE_LOG"
export PGOS_SMOKE_SSH_MODE=export-fail
export PGOS_SMOKE_CURL_MODE=ok
setup_job_env exportfail

set +e
bash "${ROOT}/workers/scripts/atomic-commit.sh"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  echo "FAIL: expected atomic-commit failure when snapshot-export fails"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi
assert_log_contains 'COMMIT_FAILED' 'status must be COMMIT_FAILED'
assert_log_contains 'E004' 'error code E004 required'
assert_log_contains 'pre-commit snapshot-export failed' 'detail must name snapshot-export'
# Must not proceed to stage-receive after export failure
if grep -q 'stage-receive' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: stage-receive must not run after snapshot-export failure"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

# ── Failure: empty archive → COMMIT_FAILED + E004 ─────────────────────
: >"$PGOS_SMOKE_LOG"
export PGOS_SMOKE_SSH_MODE=export-empty
export PGOS_SMOKE_CURL_MODE=ok
setup_job_env empty

set +e
bash "${ROOT}/workers/scripts/atomic-commit.sh"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  echo "FAIL: expected failure on empty snapshot archive"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi
assert_log_contains 'empty archive' 'empty archive detail required'
assert_log_contains 'E004' 'E004 on empty archive'

# ── Failure: S3 upload fails → COMMIT_FAILED + E004 ───────────────────
: >"$PGOS_SMOKE_LOG"
export PGOS_SMOKE_SSH_MODE=ok
export PGOS_SMOKE_CURL_MODE=put-fail
setup_job_env putfail

set +e
bash "${ROOT}/workers/scripts/atomic-commit.sh"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  echo "FAIL: expected failure when S3 PUT fails"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi
assert_log_contains 'S3 upload failed' 'upload failure detail required'
assert_log_contains 'E004' 'E004 on upload failure'

# ── Failure: missing PRESIGN_SNAPSHOT_PUT → COMMIT_FAILED + E004 ──────
: >"$PGOS_SMOKE_LOG"
export PGOS_SMOKE_SSH_MODE=ok
export PGOS_SMOKE_CURL_MODE=ok
setup_job_env nopresign
unset PRESIGN_SNAPSHOT_PUT

set +e
bash "${ROOT}/workers/scripts/atomic-commit.sh"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  echo "FAIL: expected failure when PRESIGN_SNAPSHOT_PUT missing"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi
assert_log_contains 'presign missing' 'missing presign detail required'
assert_log_contains 'E004' 'E004 on missing presign'
# Must not call snapshot-export without a place to store the archive
if grep -q 'snapshot-export' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: snapshot-export should not run when PRESIGN_SNAPSHOT_PUT is missing"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

echo "OK: C-03 snapshot-export + upload path (real atomic-commit.sh, no runner-local tree)"
