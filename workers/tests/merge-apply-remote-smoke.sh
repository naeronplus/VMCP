#!/usr/bin/env bash
# H-02 / H-02-WORKFLOW-SSH: remote merge-apply path via ForcedCommand + complete callback.
# Mocks ssh (pgos_ssh_agent_stdin) and curl; asserts complete POST shape (no real network).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; rm -f "/tmp/pgos-ssh-key-${JOB_ID:-x}" 2>/dev/null || true' EXIT

export PGOS_SMOKE_LOG="$WORK/calls.log"
: >"$PGOS_SMOKE_LOG"
export PGOS_SSH_CLEANUP_QUIET=1

mkdir -p "$WORK/bin"

# Mock ssh used by real pgos_ssh_agent_stdin (from pgos-remote.sh)
cat >"$WORK/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LOG="${PGOS_SMOKE_LOG:?}"
# Parse: ssh [opts...] host remote-command...
args=("$@")
i=0
n=${#args[@]}
host=""
remote_cmd=""
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
# Drain patch JSON on stdin (merge-apply verb)
cat >/dev/null || true
echo "SSH host=${host:-?} cmd=${remote_cmd:-}" >>"$LOG"
case "${remote_cmd:-}" in
  merge-apply*)
    # Single JSON line matching commit-agent merge-apply stdout contract
    echo '{"ok":true,"mergedHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","path":"scenes/player.tscn"}'
    exit 0
    ;;
  *)
    echo "unexpected remote cmd: ${remote_cmd:-}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$WORK/bin/ssh"

# Mock curl for POST /merge-outbox/:id/complete
cat >"$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LOG="${PGOS_SMOKE_LOG:?}"
echo "CURL $*" >>"$LOG"
prev=""
body=""
for a in "$@"; do
  if [[ "$prev" == "-d" ]]; then
    body="$a"
    echo "POST_BODY $a" >>"$LOG"
  fi
  prev="$a"
done
# Fail closed if -f and we want success path — always 0 here
if printf '%s\n' "$*" | grep -q 'merge-outbox'; then
  if [[ -z "$body" ]]; then
    echo "curl: missing -d body for complete" >&2
    exit 22
  fi
  if ! printf '%s' "$body" | grep -q 'mergedHash'; then
    echo "curl: complete body missing mergedHash" >&2
    exit 22
  fi
  echo "CURL_COMPLETE_OK" >>"$LOG"
  exit 0
fi
exit 0
EOF
chmod +x "$WORK/bin/curl"

export PATH="$WORK/bin:$PATH"

export JOB_ID="job-merge-remote-$$"
export PROJECT_ID="proj-merge"
export OUTBOX_ID="outbox-merge-smoke-1"
export TARGET_HOST="user@target.example"
# Non-local root so merge-apply.sh takes remote ForcedCommand path
export PROJECT_ROOT="/var/godot/projects/remote-game-not-on-runner"
export REL_PATH="scenes/player.tscn"
export PATCH_FILE="$WORK/patch.json"
export PGOS_BASE_URL="http://127.0.0.1:9"
export CALLBACK_TOKEN="tok-merge-complete"
export PGOS_SSH_KEEP_KEY=0

# Ephemeral key so real pgos_ssh_opts does not need SSH_PRIVATE_KEY_PEM
printf 'FAKE_OPENSSH_PRIVATE_KEY\n' >"/tmp/pgos-ssh-key-${JOB_ID}"
chmod 600 "/tmp/pgos-ssh-key-${JOB_ID}" 2>/dev/null || true

cat >"$PATCH_FILE" <<'EOF'
{
  "nodes": [
    {
      "path": "Root/Player",
      "properties": { "position": "Vector2(10, 0)" }
    }
  ]
}
EOF

set +e
out="$(bash "${ROOT}/workers/scripts/merge-apply.sh" 2>"$WORK/stderr.log")"
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  echo "FAIL: merge-apply.sh exited $rc on remote path"
  cat "$WORK/stderr.log" || true
  cat "$PGOS_SMOKE_LOG" || true
  exit 1
fi

if ! echo "$out" | grep -q 'mergedHash'; then
  echo "FAIL: stdout missing mergedHash JSON"
  echo "$out"
  exit 1
fi

if ! grep -q 'merge-apply' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: ssh mock never saw merge-apply verb"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'merge-outbox/outbox-merge-smoke-1/complete' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: complete callback URL not POSTed"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'POST_BODY {"mergedHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: complete callback body shape wrong (expected mergedHash from agent JSON)"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

if ! grep -q 'CURL_COMPLETE_OK' "$PGOS_SMOKE_LOG"; then
  echo "FAIL: complete callback did not succeed"
  cat "$PGOS_SMOKE_LOG"
  exit 1
fi

# Negative: without TARGET_HOST and non-local root → fail
unset TARGET_HOST
set +e
bash "${ROOT}/workers/scripts/merge-apply.sh" >/dev/null 2>"$WORK/neg.err"
neg_rc=$?
set -e
if [[ $neg_rc -eq 0 ]]; then
  echo "FAIL: expected failure when TARGET_HOST unset and root not local"
  exit 1
fi
if ! grep -qi 'TARGET_HOST' "$WORK/neg.err"; then
  echo "FAIL: negative path should mention TARGET_HOST"
  cat "$WORK/neg.err"
  exit 1
fi

echo "merge-apply-remote-smoke: ALL OK"
