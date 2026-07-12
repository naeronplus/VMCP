#!/usr/bin/env bash
# Smoke test for pgos-s3.sh helpers (no live S3 required)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../scripts/lib/pgos-s3.sh
source "${ROOT}/scripts/lib/pgos-s3.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# pgos_curl_put / pgos_curl_get against a tiny local file server
python3 - <<'PY' &
import http.server, socketserver, os, sys
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
with socketserver.TCPServer(("", port), H) as httpd:
    httpd.serve_forever()
PY
SRV_PID=$!
sleep 1

BASE="http://127.0.0.1:9876"
echo "payload" > "$TMP/file.txt"
pgos_curl_put "${BASE}/put" "$TMP/file.txt" "text/plain"

ARCHIVE="$TMP/archive.tgz"
mkdir -p "$TMP/src"
echo "hello" > "$TMP/src/a.txt"
tar -C "$TMP/src" -czf "$ARCHIVE" .
code=$(pgos_curl_get "${BASE}/get" "$ARCHIVE")
[[ "$code" == "200" ]] || { echo "expected 200 got $code"; exit 1; }

kill "$SRV_PID" 2>/dev/null || true
echo "pgos-s3 smoke OK"