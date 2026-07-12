#!/usr/bin/env bash
# C-01: heartbeat continues across a simulated long commit/verify window.
# Uses Node mock server (python may be unavailable on Windows agents).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=lib/reap-background.sh
source "$(dirname "$0")/lib/reap-background.sh"
COUNT_FILE="$(mktemp)"
PORT_FILE="$(mktemp)"
echo 0 >"$COUNT_FILE"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node required for mock HTTP server" >&2
  exit 1
fi

COUNT_FILE="$COUNT_FILE" PORT_FILE="$PORT_FILE" PGOS_TEST_PORT="${PGOS_TEST_PORT:-}" node - <<'NODE' &
const http = require("http");
const fs = require("fs");
const countPath = process.env.COUNT_FILE;
const portFile = process.env.PORT_FILE;
const fixedPort = process.env.PGOS_TEST_PORT
  ? Number(process.env.PGOS_TEST_PORT)
  : 0;
const server = http.createServer((req, res) => {
  if (req.method === "PATCH") {
    const n = Number(fs.readFileSync(countPath, "utf8") || "0") + 1;
    fs.writeFileSync(countPath, String(n));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404);
  res.end();
});
server.on("error", (err) => {
  console.error("mock server listen failed:", err.message);
  process.exit(1);
});
server.listen(fixedPort, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : fixedPort;
  fs.writeFileSync(portFile, String(port));
});
const shutdown = () => {
  try { server.close(); } catch (_) {}
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
NODE
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true

cleanup() {
  reap_bg_pid "${PGOS_HEARTBEAT_PID:-}"
  PGOS_HEARTBEAT_PID=""
  reap_bg_pid "$SERVER_PID"
  SERVER_PID=""
  rm -f "$COUNT_FILE" "$PORT_FILE"
}
trap cleanup EXIT

# Wait for mock server to bind (port 0 = OS-assigned when PGOS_TEST_PORT unset)
PORT=""
for _ in $(seq 1 20); do
  if [[ -s "$PORT_FILE" ]]; then
    PORT="$(cat "$PORT_FILE")"
    break
  fi
  sleep 0.1
done
if [[ -z "$PORT" ]]; then
  echo "FAIL: mock HTTP server did not report listen port" >&2
  exit 1
fi

export PGOS_BASE_URL="http://127.0.0.1:${PORT}"
export JOB_ID="00000000-0000-4000-8000-000000000001"
export CALLBACK_TOKEN="test-token"
export HEARTBEAT_INTERVAL=1
export HEARTBEAT_MAX_CONSECUTIVE_FAILURES=10
export PGOS_CALLBACK_MAX_RETRIES=2
export PGOS_CALLBACK_BACKOFF_SEC=0

# shellcheck source=../scripts/lib/pgos-lifecycle.sh
source "${ROOT}/workers/scripts/lib/pgos-lifecycle.sh"
pgos_start_heartbeat
disown "${PGOS_HEARTBEAT_PID:-}" 2>/dev/null || true

# Simulate generation + commit + verify window
sleep 5

reap_bg_pid "${PGOS_HEARTBEAT_PID:-}"
PGOS_HEARTBEAT_PID=""
COUNT="$(cat "$COUNT_FILE")"

if [[ "$COUNT" -lt 3 ]]; then
  echo "FAIL: expected >=3 heartbeats in ~5s with interval=1, got ${COUNT}"
  exit 1
fi
echo "OK: ${COUNT} heartbeats during simulated pipeline window"

reap_bg_pid "$SERVER_PID"
SERVER_PID=""