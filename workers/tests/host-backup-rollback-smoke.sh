#!/usr/bin/env bash
# TEST-01 scenario 6: S3 disabled / unavailable → host backup restore (target.bak-{jobId}).
# Drives real post-commit-verify.sh do_rollback() — no inlined rollback logic.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; rm -f "/tmp/pgos-ssh-key-${JOB_ID:-x}" 2>/dev/null || true' EXIT

export JOB_ID="job-host-bak-$$"
export PROJECT_ID="proj-host-bak"
export COMMIT_STRATEGY="cross-machine"
export TARGET_HOST="user@target.example"
export TARGET_PROJECT_ROOT="/var/godot/projects/p1-host-bak"
export CALLBACK_TOKEN="tok"
export PGOS_BASE_URL="http://127.0.0.1:9"
export REIMPORT_TIMEOUT_SEC=5
export REIMPORT_MAX_RETRIES=0
# Scenario 6: no S3 presign — host backup is sole restore path
unset PRESIGN_SNAPSHOT_GET
export PGOS_SSH_KEEP_KEY=0
export PGOS_SSH_CLEANUP_QUIET=1
export PGOS_CALLBACK_MAX_RETRIES=1
export PGOS_CALLBACK_BACKOFF_SEC=0
export PGOS_REMOTE_VERIFY=1

export PGOS_SMOKE_LOG="$WORK/calls.log"
: >"$PGOS_SMOKE_LOG"

printf 'FAKE_OPENSSH_PRIVATE_KEY\n' >"/tmp/pgos-ssh-key-${JOB_ID}"
chmod 600 "/tmp/pgos-ssh-key-${JOB_ID}"

mkdir -p "$WORK/bin"

cat >"$WORK/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LOG="${PGOS_SMOKE_LOG:?}"
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
  reimport*)
    echo "reimport failed simulated" >&2
    exit 1
    ;;
  restore*)
    if [[ "${remote_cmd}" == *".bak-"* ]]; then
      echo "SSH_BACKUP_RESTORE $remote_cmd" >>"$LOG"
      exit 0
    fi
    echo "SSH_RESTORE_STDIN $remote_cmd" >>"$LOG"
    cat >/dev/null
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$WORK/bin/ssh"

cat >"$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LOG="${PGOS_SMOKE_LOG:?}"
echo "CURL $*" >>"$LOG"
prev=""
for a in "$@"; do
  if [[ "$prev" == "-d" ]]; then
    echo "PATCH_BODY $a" >>"$LOG"
  fi
  prev="$a"
done
if printf '%s\n' "$*" | grep -q -- '-X PATCH'; then
  echo "200"
  exit 0
fi
echo "404"
exit 0
EOF
chmod +x "$WORK/bin/curl"

export PATH="$WORK/bin:$PATH"

set +e
bash "${ROOT}/workers/scripts/post-commit-verify.sh"
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  echo "FAIL: expected non-zero exit after reimport failure + host backup rollback"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'SSH_BACKUP_RESTORE' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: host backup restore verb not invoked (expected target.bak-${JOB_ID})"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if grep -q 'CURL_GET_OK\|SSH_RESTORE_STDIN' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: S3 restore path must not run when PRESIGN_SNAPSHOT_GET unset"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'ROLLBACK' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: ROLLBACK status not patched"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'host backup' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: rollback detail should mention host backup"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

echo "OK: scenario 6 — host backup restore when S3 presign absent (real post-commit-verify.sh)"