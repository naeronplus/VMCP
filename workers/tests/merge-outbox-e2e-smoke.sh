#!/usr/bin/env bash
# TEST-01 scenario 8 / plan §7.2 — remote merge outbox end-to-end mock:
#   dispatch envelope contracts → merge-apply remote path → complete callback shape
# No live orchestrator, SSH host, or secrets required.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ── 1. Static: dispatch envelope + workflow + verb surface ────────────

MERGE_YML="${ROOT}/.github/workflows/merge_apply.yml"
DISPATCH="${ROOT}/packages/orchestrator/src/services/merge-outbox-dispatch.ts"
WORKER="${ROOT}/packages/orchestrator/src/workers/merge-outbox-worker.ts"
MAIN_GO="${ROOT}/packages/commit-agent/cmd/agent/main.go"
APPLY_SH="${ROOT}/workers/scripts/merge-apply.sh"

[[ -f "$MERGE_YML" ]] || fail "missing merge_apply.yml"
[[ -f "$DISPATCH" ]] || fail "missing merge-outbox-dispatch.ts"
[[ -f "$WORKER" ]] || fail "missing merge-outbox-worker.ts"
[[ -f "$MAIN_GO" ]] || fail "missing commit-agent main.go"
[[ -f "$APPLY_SH" ]] || fail "missing merge-apply.sh"

grep -q 'secretJwe' "$MERGE_YML" || fail "merge_apply.yml missing secretJwe input"
grep -q 'resolve-secrets.sh' "$MERGE_YML" || fail "merge_apply.yml missing resolve-secrets step"
grep -q 'buildMergeApplyDispatchEnvelope' "$DISPATCH" || fail "dispatch missing buildMergeApplyDispatchEnvelope"
grep -q 'secretJwe' "$DISPATCH" || fail "dispatch missing secretJwe in workflow inputs"
grep -q 'createDirectDispatchJwe' "$DISPATCH" || fail "dispatch must seal via createDirectDispatchJwe"
grep -q 'secretJwe' "$WORKER" || fail "merge-outbox-worker must pass secretJwe"
grep -q 'buildMergeApplyDispatchEnvelope' "$WORKER" || fail "worker must use dispatch envelope"
grep -q 'cmdMergeApply\|"merge-apply"' "$MAIN_GO" || fail "commit-agent missing merge-apply verb"
grep -q 'pgos_ssh_agent_stdin' "$APPLY_SH" || fail "merge-apply.sh missing ForcedCommand path"
grep -q 'merge-outbox' "$APPLY_SH" && grep -q '/complete' "$APPLY_SH" || fail "merge-apply.sh missing complete callback"

# Guard: no raw private key field names as bare workflow inputs in merge_apply.yml
if grep -Eiq 'sshPrivateKey|SSH_PRIVATE_KEY:' "$MERGE_YML"; then
  fail "merge_apply.yml must not accept raw SSH private key inputs"
fi

echo "OK: static envelope → workflow → verb contracts"

# ── 2. Orchestrator unit tests: envelope completeness ─────────────────

if command -v node >/dev/null 2>&1; then
  set +e
  (
    cd "${ROOT}/packages/orchestrator"
    node --import tsx --test tests/merge-outbox-dispatch.test.ts
  ) >"$WORK/dispatch-test.out" 2>&1
  d_rc=$?
  set -e
  if [[ $d_rc -ne 0 ]]; then
    cat "$WORK/dispatch-test.out" >&2
    fail "merge-outbox-dispatch.test.ts failed"
  fi
  echo "OK: merge-outbox-dispatch unit tests"
else
  fail "node required for dispatch unit tests"
fi

# ── 3. Apply + complete (reuse remote smoke — mock ssh/curl) ──────────

REMOTE_SMOKE="${ROOT}/workers/tests/merge-apply-remote-smoke.sh"
[[ -f "$REMOTE_SMOKE" ]] || fail "missing merge-apply-remote-smoke.sh"

set +e
bash "$REMOTE_SMOKE" >"$WORK/remote.out" 2>&1
r_rc=$?
set -e
if [[ $r_rc -ne 0 ]]; then
  cat "$WORK/remote.out" >&2
  fail "merge-apply-remote-smoke.sh failed (apply → complete)"
fi
grep -q 'ALL OK' "$WORK/remote.out" || fail "remote smoke missing ALL OK marker"
echo "OK: remote apply → complete callback"

# ── 4. Inline chain: env as if resolve-secrets produced TARGET_HOST ───
# (extra assert that merge-apply.sh accepts resolved env shape)

export PGOS_SMOKE_LOG="$WORK/chain.log"
: >"$PGOS_SMOKE_LOG"
mkdir -p "$WORK/bin"

cat >"$WORK/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "SSH $*" >>"${PGOS_SMOKE_LOG:?}"
cat >/dev/null || true
echo '{"ok":true,"mergedHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","path":"scenes/main.tscn"}'
exit 0
EOF
chmod +x "$WORK/bin/ssh"

cat >"$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "CURL $*" >>"${PGOS_SMOKE_LOG:?}"
prev=""
for a in "$@"; do
  if [[ "$prev" == "-d" ]]; then
    echo "BODY $a" >>"$PGOS_SMOKE_LOG"
  fi
  prev="$a"
done
exit 0
EOF
chmod +x "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"

export JOB_ID="job-merge-e2e-$$"
export OUTBOX_ID="outbox-e2e-chain-1"
export TARGET_HOST="user@target.example"
export PROJECT_ROOT="/var/godot/projects/e2e-remote-not-local"
export REL_PATH="scenes/main.tscn"
export PATCH_FILE="$WORK/patch.json"
export PGOS_BASE_URL="http://127.0.0.1:9"
export CALLBACK_TOKEN="tok-e2e-complete"
export PGOS_SSH_KEEP_KEY=0
printf 'FAKE_KEY\n' >"/tmp/pgos-ssh-key-${JOB_ID}"
chmod 600 "/tmp/pgos-ssh-key-${JOB_ID}" 2>/dev/null || true

cat >"$PATCH_FILE" <<'EOF'
{"nodes":[{"path":"Root/Player","properties":{"position":"Vector2(1, 2)"}}]}
EOF

set +e
bash "$APPLY_SH" >"$WORK/apply.out" 2>"$WORK/apply.err"
a_rc=$?
set -e
rm -f "/tmp/pgos-ssh-key-${JOB_ID}" 2>/dev/null || true

if [[ $a_rc -ne 0 ]]; then
  cat "$WORK/apply.err" >&2
  cat "$WORK/apply.out" >&2
  fail "inline merge-apply chain exited $a_rc"
fi

grep -q 'merge-apply' "$PGOS_SMOKE_LOG" || fail "chain did not invoke merge-apply via ssh"
grep -q 'merge-outbox/outbox-e2e-chain-1/complete' "$PGOS_SMOKE_LOG" || fail "chain missing complete URL"
grep -q 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' "$PGOS_SMOKE_LOG" || fail "chain complete body missing agent mergedHash"

echo "OK: inline resolve-env → apply → complete"
echo "merge-outbox-e2e-smoke: ALL OK"
