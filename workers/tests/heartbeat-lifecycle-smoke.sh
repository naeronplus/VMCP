#!/usr/bin/env bash
# C-01: heartbeat continues across a simulated long commit/verify window.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PGOS_TEST_PORT:-18765}"
COUNT_FILE="$(mktemp)"
echo 0 >"$COUNT_FILE"

# Minimal HTTP server counting PATCH /heartbeat
python3 - <<PY &
import http.server, json, pathlib, sys
count_path = pathlib.Path(r"${COUNT_FILE}")
port = int("${PORT}")

class H(http.server.BaseHTTPRequestHandler):
    def do_PATCH(self):
        n = int(count_path.read_text() or "0") + 1
        count_path.write_text(str(n))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')
    def log_message(self, *args):
        pass

http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT
sleep 0.5

export PGOS_BASE_URL="http://127.0.0.1:${PORT}"
export JOB_ID="00000000-0000-4000-8000-000000000001"
export CALLBACK_TOKEN="test-token"
export HEARTBEAT_INTERVAL=1

# shellcheck source=../scripts/lib/pgos-lifecycle.sh
source "${ROOT}/workers/scripts/lib/pgos-lifecycle.sh"
pgos_heartbeat_trap
pgos_start_heartbeat

# Simulate generation + commit + verify window
sleep 5

pgos_stop_heartbeat
COUNT="$(cat "$COUNT_FILE")"
rm -f "$COUNT_FILE"

if [[ "$COUNT" -lt 3 ]]; then
  echo "FAIL: expected >=3 heartbeats in ~5s with interval=1, got ${COUNT}"
  exit 1
fi
echo "OK: ${COUNT} heartbeats during simulated pipeline window"
