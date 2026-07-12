#!/usr/bin/env bash
# M-05 / M-06: pgos_callback_patch validates HTTP status.
# Uses Node (not python) for the mock server so CI/Windows Git Bash work.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=lib/reap-background.sh
source "$(dirname "$0")/lib/reap-background.sh"
# shellcheck source=../scripts/lib/pgos-callback.sh
source "${ROOT}/workers/scripts/lib/pgos-callback.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node required for mock HTTP server" >&2
  exit 1
fi

PORT="${PGOS_CALLBACK_TEST_PORT:-18766}"
MODE_FILE="$(mktemp)"
HITS_FILE="$(mktemp)"
echo "403" >"$MODE_FILE"
echo "0" >"$HITS_FILE"

MODE_FILE="$MODE_FILE" HITS_FILE="$HITS_FILE" PORT="$PORT" node - <<'NODE' &
const http = require("http");
const fs = require("fs");
const modePath = process.env.MODE_FILE;
const hitsPath = process.env.HITS_FILE;
const port = Number(process.env.PORT);

const server = http.createServer((req, res) => {
  if (req.method !== "PATCH") {
    res.writeHead(405);
    res.end();
    return;
  }
  let n = Number(fs.readFileSync(hitsPath, "utf8") || "0") + 1;
  fs.writeFileSync(hitsPath, String(n));
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const mode = fs.readFileSync(modePath, "utf8").trim();
    let code = 500;
    if (mode === "403") code = 403;
    else if (mode === "500_once") code = n === 1 ? 500 : 200;
    else if (mode === "200") code = 200;
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(code === 200 ? '{"ok":true}' : '{"error":true}');
  });
});
server.listen(port, "127.0.0.1");
const shutdown = () => {
  try { server.close(); } catch (_) {}
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
NODE
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  # Windows/Git Bash: ensure node exits
  kill -9 "$SERVER_PID" 2>/dev/null || true
  rm -f "$MODE_FILE" "$HITS_FILE"
}
trap cleanup EXIT
sleep 0.4

export PGOS_BASE_URL="http://127.0.0.1:${PORT}"
export JOB_ID="00000000-0000-4000-8000-000000000099"
export CALLBACK_TOKEN="test-token"
export PGOS_CALLBACK_MAX_RETRIES=3
export PGOS_CALLBACK_BACKOFF_SEC=0

# --- 403 must fail (no retry) ---
echo "403" >"$MODE_FILE"
echo "0" >"$HITS_FILE"
set +e
pgos_patch_job_status '{"status":"VALIDATING"}'
RC403=$?
set -e
if [[ "$RC403" -eq 0 ]]; then
  echo "FAIL: expected non-zero on HTTP 403" >&2
  exit 1
fi
HITS403="$(cat "$HITS_FILE")"
if [[ "$HITS403" -lt 1 ]]; then
  echo "FAIL: mock server received no requests (got hits=${HITS403})" >&2
  exit 1
fi
# 403 must not be retried as 5xx
if [[ "$HITS403" -gt 1 ]]; then
  echo "FAIL: 403 should not retry, hits=${HITS403}" >&2
  exit 1
fi
echo "OK: 403 → exit ${RC403} (hits=${HITS403})"

# --- 500 then 200 retries to success ---
echo "500_once" >"$MODE_FILE"
echo "0" >"$HITS_FILE"
set +e
pgos_patch_job_status '{"status":"VALIDATING"}'
RC5=$?
set -e
if [[ "$RC5" -ne 0 ]]; then
  echo "FAIL: expected success after 500→200 retry, got ${RC5}" >&2
  exit 1
fi
HITS="$(cat "$HITS_FILE")"
if [[ "$HITS" -lt 2 ]]; then
  echo "FAIL: expected at least 2 attempts, got ${HITS}" >&2
  exit 1
fi
echo "OK: 500 then 200 after ${HITS} attempts"

# --- heartbeat consecutive 403 → exit 1 ---
echo "403" >"$MODE_FILE"
echo "0" >"$HITS_FILE"
export HEARTBEAT_INTERVAL=0
export HEARTBEAT_MAX_CONSECUTIVE_FAILURES=3
export PGOS_CALLBACK_MAX_RETRIES=1

set +e
if command -v timeout >/dev/null 2>&1; then
  timeout 20 bash "${ROOT}/workers/scripts/heartbeat.sh"
  HB_RC=$?
else
  bash "${ROOT}/workers/scripts/heartbeat.sh" &
  HB_PID=$!
  for _ in $(seq 1 40); do
    if ! kill -0 "$HB_PID" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  if kill -0 "$HB_PID" 2>/dev/null; then
    kill "$HB_PID" 2>/dev/null || true
    wait "$HB_PID" 2>/dev/null || true
    HB_RC=124
  else
    wait "$HB_PID"
    HB_RC=$?
  fi
fi
set -e

if [[ "$HB_RC" -eq 0 ]]; then
  echo "FAIL: heartbeat should exit non-zero on consecutive 403" >&2
  exit 1
fi
if [[ "$HB_RC" -eq 124 ]]; then
  echo "FAIL: heartbeat did not exit within timeout (still swallowing failures?)" >&2
  exit 1
fi
echo "OK: heartbeat exited ${HB_RC} after consecutive 403s"

# Static regression guards
if grep -nE '^[^#]*\|\|[[:space:]]*true' "${ROOT}/workers/scripts/heartbeat.sh"; then
  echo "FAIL: heartbeat.sh still has || true" >&2
  exit 1
fi
if ! grep -q 'pgos_patch_job_heartbeat' "${ROOT}/workers/scripts/heartbeat.sh"; then
  echo "FAIL: heartbeat.sh does not use pgos_patch_job_heartbeat" >&2
  exit 1
fi

for f in run-generation.sh atomic-commit.sh post-commit-verify.sh; do
  if grep -nE 'curl[[:space:]].*-X[[:space:]]*PATCH' "${ROOT}/workers/scripts/${f}"; then
    echo "FAIL: ${f} still has raw status PATCH curl" >&2
    exit 1
  fi
  if ! grep -q 'pgos_patch_job_status' "${ROOT}/workers/scripts/${f}"; then
    echo "FAIL: ${f} missing pgos_patch_job_status" >&2
    exit 1
  fi
done

# --- M-05: STAGING path uses pgos_patch_job_status (same retry/auth as lifecycle) ---
echo "200" >"$MODE_FILE"
echo "0" >"$HITS_FILE"
set +e
pgos_patch_job_status '{"status":"STAGING"}'
RC_STAGING=$?
set -e
if [[ "$RC_STAGING" -ne 0 ]]; then
  echo "FAIL: STAGING status PATCH should succeed on HTTP 200, got ${RC_STAGING}" >&2
  exit 1
fi
echo "OK: STAGING path via pgos_patch_job_status (hits=$(cat "$HITS_FILE"))"

# 401/403 on STAGING must fail early (auth rejected)
echo "403" >"$MODE_FILE"
echo "0" >"$HITS_FILE"
set +e
pgos_patch_job_status '{"status":"STAGING"}'
RC_STAGING_403=$?
set -e
if [[ "$RC_STAGING_403" -eq 0 ]]; then
  echo "FAIL: STAGING PATCH must fail on HTTP 403" >&2
  exit 1
fi
echo "OK: STAGING 403 → exit ${RC_STAGING_403}"

# Workflow must not use raw curl for Report STAGING (M-05)
for wf in \
  "${ROOT}/.github/workflows/godot_worker.yml" \
  "${ROOT}/workers/.github/workflows/godot_worker.yml"
do
  if [[ ! -f "$wf" ]]; then
    echo "FAIL: missing workflow ${wf}" >&2
    exit 1
  fi
  if ! grep -q 'pgos_patch_job_status' "$wf"; then
    echo "FAIL: ${wf} missing pgos_patch_job_status (M-05)" >&2
    exit 1
  fi
  if ! grep -q "pgos-callback.sh" "$wf"; then
    echo "FAIL: ${wf} does not source pgos-callback.sh (M-05)" >&2
    exit 1
  fi
  # Reject raw STAGING curl (the pre-fix pattern)
  if grep -A6 'Report STAGING' "$wf" | grep -qE 'curl[[:space:]].*-X[[:space:]]*PATCH'; then
    echo "FAIL: ${wf} Report STAGING still uses raw curl (M-05)" >&2
    exit 1
  fi
  if ! grep -A8 'Report STAGING' "$wf" | grep -q 'STAGING'; then
    echo "FAIL: ${wf} Report STAGING step missing STAGING payload" >&2
    exit 1
  fi
done
echo "OK: godot_worker.yml STAGING uses pgos_callback (root + workers mirror)"

reap_bg_pid "$SERVER_PID"
SERVER_PID=""

echo "pgos-callback-smoke: ALL OK"
