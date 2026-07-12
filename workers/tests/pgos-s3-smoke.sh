#!/usr/bin/env bash
# Smoke test for pgos-s3.sh helpers (no live S3 required).
# Includes pgos_upload_file (C-03 target snapshot archive upload).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/reap-background.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/reap-background.sh"
# shellcheck source=../scripts/lib/pgos-s3.sh
source "${ROOT}/scripts/lib/pgos-s3.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; kill "${SRV_PID:-}" 2>/dev/null || true' EXIT

PORT="${PORT:-9876}"
BASE="http://127.0.0.1:${PORT}"

# Prefer node (available on CI + Windows runners); fall back to python3.
start_server() {
  if command -v node >/dev/null 2>&1; then
    PORT="$PORT" node - <<'NODE' &
const http = require('http');
const port = Number(process.env.PORT || 9876);
const server = http.createServer((req, res) => {
  if (req.method === 'PUT') {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200);
      res.end();
    });
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/gzip' });
    res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]));
    return;
  }
  res.writeHead(405);
  res.end();
});
server.listen(port, '127.0.0.1');
NODE
    SRV_PID=$!
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    PORT="$PORT" python3 - <<'PY' &
import http.server, socketserver, os
port = int(os.environ.get("PORT", "9876"))
class H(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        n = int(self.headers.get("Content-Length", 0))
        self.rfile.read(n)
        self.send_response(200)
        self.end_headers()
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/gzip")
        self.end_headers()
        self.wfile.write(b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff")
    def log_message(self, *a): pass
with socketserver.TCPServer(("127.0.0.1", port), H) as httpd:
    httpd.serve_forever()
PY
    SRV_PID=$!
    return 0
  fi
  echo "FAIL: need node or python3 for local HTTP mock"
  exit 1
}

start_server
# Wait for listen
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sS -o /dev/null -w '%{http_code}' "${BASE}/get" 2>/dev/null | grep -q 200; then
    break
  fi
  sleep 0.2
done

echo "payload" > "$TMP/file.txt"
pgos_curl_put "${BASE}/put" "$TMP/file.txt" "text/plain"

ARCHIVE="$TMP/archive.tgz"
mkdir -p "$TMP/src"
echo "hello" > "$TMP/src/a.txt"
tar -C "$TMP/src" -czf "$ARCHIVE" .
code=$(pgos_curl_get "${BASE}/get" "$ARCHIVE")
[[ "$code" == "200" ]] || { echo "expected 200 got $code"; exit 1; }

# C-03: pgos_upload_file uploads an existing pre-built archive
SNAP="$TMP/pre-snapshot.tar.gz"
printf '\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03fake\x00\x00\x00\x00\x00\x00\x00\x00' >"$SNAP"
pgos_upload_file "$SNAP" "${BASE}/put"
# Missing file must fail
if pgos_upload_file "$TMP/does-not-exist.tar.gz" "${BASE}/put" 2>/dev/null; then
  echo "FAIL: pgos_upload_file should reject missing file"
  exit 1
fi
# Empty args must fail
if pgos_upload_file "" "" 2>/dev/null; then
  echo "FAIL: pgos_upload_file should reject empty args"
  exit 1
fi

reap_bg_pid "${SRV_PID:-}"
SRV_PID=""
echo "pgos-s3 smoke OK (incl. pgos_upload_file)"