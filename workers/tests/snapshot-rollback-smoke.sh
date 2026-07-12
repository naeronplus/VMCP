#!/usr/bin/env bash
# C-03 integration: drive real post-commit-verify.sh —
# reimport fail → S3 snapshot GET → restore stdin on target (plan §6.2.5).
# No inlined do_rollback — PATH-mocked ssh/curl only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; rm -f "/tmp/snapshot-restore-${JOB_ID:-x}.tar.gz" "/tmp/post_reimport_${JOB_ID:-x}.log" "/tmp/pgos-ssh-key-${JOB_ID:-x}" 2>/dev/null || true' EXIT

export JOB_ID="job-rollback-$$"
export PROJECT_ID="proj-rollback"
export COMMIT_STRATEGY="cross-machine"
export TARGET_HOST="user@target.example"
export TARGET_PROJECT_ROOT="/var/godot/projects/p1-c03-rollback"
export CALLBACK_TOKEN="tok"
export PGOS_BASE_URL="http://127.0.0.1:9"
export REIMPORT_TIMEOUT_SEC=5
export REIMPORT_MAX_RETRIES=0
export PRESIGN_SNAPSHOT_GET="https://s3.example/snapshot-get"
export PGOS_SSH_KEEP_KEY=0
export PGOS_SSH_CLEANUP_QUIET=1
export PGOS_CALLBACK_MAX_RETRIES=1
export PGOS_CALLBACK_BACKOFF_SEC=0
export PGOS_REMOTE_VERIFY=1

export PGOS_SMOKE_LOG="$WORK/calls.log"
: >"$PGOS_SMOKE_LOG"

# Fake S3 archive content served on GET
ARCHIVE_SRC="$WORK/s3-snapshot.tar.gz"
printf '\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03' >"$ARCHIVE_SRC"
printf 'fake-snapshot-for-rollback' >>"$ARCHIVE_SRC"
printf '\x00\x00\x00\x00\x00\x00\x00\x00' >>"$ARCHIVE_SRC"
export PGOS_SMOKE_ARCHIVE_SRC="$ARCHIVE_SRC"
export PGOS_SMOKE_RESTORE_CAPTURE="$WORK/restore-stdin.bin"

mkdir -p "$WORK/bin"

# Ephemeral key for real pgos_ssh_opts
printf 'FAKE_OPENSSH_PRIVATE_KEY\n' >"/tmp/pgos-ssh-key-${JOB_ID}"
chmod 600 "/tmp/pgos-ssh-key-${JOB_ID}"

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
    # Host-backup form (restore target backup_path) must NOT run when S3 primary works
    if [[ "${remote_cmd}" == *" bak"* ]] || [[ "${remote_cmd}" == *".bak-"* ]]; then
      echo "SSH_BACKUP_RESTORE $remote_cmd" >>"$LOG"
      exit 1
    fi
    # stdin form: capture archive bytes
    if [[ -n "${PGOS_SMOKE_RESTORE_CAPTURE:-}" ]]; then
      cat >"$PGOS_SMOKE_RESTORE_CAPTURE"
    else
      cat >/dev/null
    fi
    echo "SSH_RESTORE_STDIN $remote_cmd" >>"$LOG"
    exit 0
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

# pgos_curl_get: curl -sS -o DEST -w '%{http_code}' URL
if printf '%s\n' "$*" | grep -q '%{http_code}'; then
  # Parse -o dest and final URL
  dest=""
  url=""
  prev=""
  for a in "$@"; do
    if [[ "$prev" == "-o" ]]; then
      dest="$a"
    fi
    if [[ "$a" == http* ]]; then
      url="$a"
    fi
    prev="$a"
  done
  if [[ -n "$dest" && -n "${PGOS_SMOKE_ARCHIVE_SRC:-}" && -f "${PGOS_SMOKE_ARCHIVE_SRC}" ]]; then
    if [[ "$url" == *"snapshot-get"* ]] || [[ "$url" == "${PRESIGN_SNAPSHOT_GET:-}" ]]; then
      cp "${PGOS_SMOKE_ARCHIVE_SRC}" "$dest"
      echo "CURL_GET_OK $url -> $dest" >>"$LOG"
      echo "200"
      exit 0
    fi
  fi
  # Lifecycle PATCH status capture
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
fi

exit 0
EOF
chmod +x "$WORK/bin/curl"

export PATH="$WORK/bin:$PATH"

set +e
bash "${ROOT}/workers/scripts/post-commit-verify.sh"
rc=$?
set -e

# post-commit-verify exits 1 after rollback on reimport failure — expected
if [[ $rc -eq 0 ]]; then
  echo "FAIL: expected non-zero exit after forced reimport failure + rollback"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'reimport' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: reimport verb not invoked"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'CURL_GET_OK' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: PRESIGN_SNAPSHOT_GET not fetched from S3"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'SSH_RESTORE_STDIN' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: restore stdin verb not invoked"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if grep -q 'SSH_BACKUP_RESTORE' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: host backup restore invoked while S3 primary should succeed"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if [[ ! -s "${PGOS_SMOKE_RESTORE_CAPTURE}" ]]; then
  echo "FAIL: restore stdin empty (S3 archive not piped)"
  exit 1
fi

# Compare captured stdin to served archive
if ! cmp -s "${PGOS_SMOKE_RESTORE_CAPTURE}" "${ARCHIVE_SRC}"; then
  echo "FAIL: restore stdin bytes do not match S3 archive"
  exit 1
fi

if ! grep -q 'ROLLBACK' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: ROLLBACK status not patched"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'E002' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: E002 not emitted on post-commit rollback"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'restored remote snapshot' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: rollback detail should indicate remote S3 restore"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

echo "OK: C-03 S3-primary rollback restores target via restore stdin (real post-commit-verify.sh)"
