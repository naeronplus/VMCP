#!/usr/bin/env bash
# M-07 / L-12: resolve-secrets masks CALLBACK_TOKEN, writes 600 token file,
# and never logs HTTP body on failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=lib/reap-background.sh
source "$(dirname "$0")/lib/reap-background.sh"
SCRIPT="${ROOT}/workers/scripts/resolve-secrets.sh"
PORT="${PGOS_RESOLVE_TEST_PORT:-18767}"
TMPDIR_TEST="$(mktemp -d)"
export RUNNER_TEMP="$TMPDIR_TEST"
export GITHUB_ACTIONS=true
GITHUB_ENV_FILE="$(mktemp)"
export GITHUB_ENV="$GITHUB_ENV_FILE"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node required" >&2
  exit 1
fi

# Mock resolve-secret API
MODE_FILE="$(mktemp)"
echo "200" >"$MODE_FILE"
TOKEN_VALUE="super-secret-callback-token-m07-$$"

MODE_FILE="$MODE_FILE" TOKEN_VALUE="$TOKEN_VALUE" PORT="$PORT" node - <<'NODE' &
const http = require("http");
const fs = require("fs");
const modePath = process.env.MODE_FILE;
const token = process.env.TOKEN_VALUE;
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const mode = fs.readFileSync(modePath, "utf8").trim();
    if (mode === "500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "should-not-appear-in-logs", secret: token }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        secrets: {
          callbackToken: token,
          fencingToken: "fence-secret-xyz",
          lockKey: "gen:p",
          lockOwner: "job:j",
          presignedUrls: { stagingGet: "https://s3.example/staging" },
        },
      }),
    );
  });
});
server.listen(port, "127.0.0.1");
const shutdown = () => {
  try {
    server.close();
  } catch (_) {}
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
NODE
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  kill -9 "$SERVER_PID" 2>/dev/null || true
  rm -f "$MODE_FILE" "$GITHUB_ENV_FILE"
  rm -rf "$TMPDIR_TEST"
}
trap cleanup EXIT
sleep 0.4

export PGOS_BASE_URL="http://127.0.0.1:${PORT}"
export SECRET_JWE="eyJ.test.jwe.payload.secret"
export JOB_ID="00000000-0000-4000-8000-000000000077"

# --- Success path: mask + token file + GITHUB_ENV ---
OUT="$(bash "$SCRIPT" 2>&1)" || {
  echo "FAIL: resolve-secrets exited non-zero on 200" >&2
  echo "$OUT" >&2
  exit 1
}

if ! echo "$OUT" | grep -q '::add-mask::'"${TOKEN_VALUE}"; then
  echo "FAIL: expected ::add-mask:: for CALLBACK_TOKEN in output" >&2
  echo "$OUT" >&2
  exit 1
fi
if ! echo "$OUT" | grep -q '::add-mask::eyJ.test.jwe.payload.secret'; then
  echo "FAIL: expected ::add-mask:: for SECRET_JWE" >&2
  exit 1
fi
if ! echo "$OUT" | grep -q '::add-mask::fence-secret-xyz'; then
  echo "FAIL: expected ::add-mask:: for FENCING_TOKEN" >&2
  exit 1
fi

# Token must not be printed in clear as a log line like "token=..."
if echo "$OUT" | grep -Eiq 'callback[_ ]?token[[:space:]]*[=:][[:space:]]*'"${TOKEN_VALUE}"; then
  echo "FAIL: CALLBACK_TOKEN value logged in cleartext label form" >&2
  exit 1
fi

TOKEN_FILE="${RUNNER_TEMP}/pgos-callback-token-${JOB_ID}"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "FAIL: CALLBACK_TOKEN_FILE not written at ${TOKEN_FILE}" >&2
  exit 1
fi
mode="$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || stat -f '%OLp' "$TOKEN_FILE" 2>/dev/null || echo '?')"
if [[ "$mode" != "600" && "$mode" != "0600" ]]; then
  # Git Bash on Windows/NTFS often cannot enforce 0600; GHA ubuntu runners do.
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  case "$uname_s" in
    MINGW*|MSYS*|CYGWIN*)
      echo "WARN: token file mode is ${mode} on ${uname_s} (expected 600 on Linux GHA)" >&2
      ;;
    *)
      echo "FAIL: token file mode is ${mode}, expected 600" >&2
      exit 1
      ;;
  esac
fi
if [[ "$(cat "$TOKEN_FILE")" != "$TOKEN_VALUE" ]]; then
  echo "FAIL: token file contents mismatch" >&2
  exit 1
fi

if ! grep -q "^CALLBACK_TOKEN=${TOKEN_VALUE}$" "$GITHUB_ENV_FILE"; then
  echo "FAIL: CALLBACK_TOKEN missing from GITHUB_ENV file" >&2
  cat "$GITHUB_ENV_FILE" >&2
  exit 1
fi
if ! grep -q "^CALLBACK_TOKEN_FILE=${TOKEN_FILE}$" "$GITHUB_ENV_FILE"; then
  echo "FAIL: CALLBACK_TOKEN_FILE missing from GITHUB_ENV" >&2
  exit 1
fi
if grep -q 'SSH_PRIVATE_KEY_PEM' "$GITHUB_ENV_FILE"; then
  echo "FAIL: SSH_PRIVATE_KEY_PEM must not be in GITHUB_ENV" >&2
  exit 1
fi
echo "OK: mask + RUNNER_TEMP file mode ${mode} + GITHUB_ENV"

# --- Failure path L-12: HTTP status only, no body secret ---
echo "500" >"$MODE_FILE"
export JOB_ID="00000000-0000-4000-8000-000000000078"
set +e
ERR_OUT="$(bash "$SCRIPT" 2>&1)"
ERR_RC=$?
set -e
if [[ "$ERR_RC" -eq 0 ]]; then
  echo "FAIL: expected non-zero on HTTP 500" >&2
  exit 1
fi
if ! echo "$ERR_OUT" | grep -q 'HTTP 500'; then
  echo "FAIL: expected HTTP 500 in error message" >&2
  echo "$ERR_OUT" >&2
  exit 1
fi
if echo "$ERR_OUT" | grep -q 'should-not-appear-in-logs'; then
  echo "FAIL: response body leaked on error path (L-12)" >&2
  echo "$ERR_OUT" >&2
  exit 1
fi
if echo "$ERR_OUT" | grep -q "$TOKEN_VALUE"; then
  echo "FAIL: token value appeared in error output" >&2
  exit 1
fi
echo "OK: L-12 error path logs status only"

# Static guards
if ! grep -q 'add-mask' "$SCRIPT"; then
  echo "FAIL: resolve-secrets.sh missing add-mask" >&2
  exit 1
fi
if ! grep -q 'RUNNER_TEMP' "$SCRIPT"; then
  echo "FAIL: resolve-secrets.sh missing RUNNER_TEMP token file path" >&2
  exit 1
fi
if ! grep -q 'resolve-secret failed HTTP' "$SCRIPT"; then
  echo "FAIL: missing L-12 status-only error message" >&2
  exit 1
fi

reap_bg_pid "$SERVER_PID"
SERVER_PID=""

echo "resolve-secrets-mask-smoke: ALL OK"
