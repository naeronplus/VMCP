#!/usr/bin/env bash
# M-11: validate_node_paths.gd must be wired into run-generation multi-layer validation.
# Uses a mock Godot binary + mock callback server (Node) — no real Godot required.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=lib/reap-background.sh
source "$(dirname "$0")/lib/reap-background.sh"
SCRIPT="${ROOT}/workers/scripts/run-generation.sh"
GD_SCRIPT="${ROOT}/workers/scripts/validate_node_paths.gd"

# ---------------------------------------------------------------------------
# Static wiring guards (always run)
# ---------------------------------------------------------------------------
if [[ ! -f "$GD_SCRIPT" ]]; then
  echo "FAIL: validate_node_paths.gd missing at ${GD_SCRIPT}" >&2
  exit 1
fi

if ! grep -q 'validate_node_paths\.gd' "$SCRIPT"; then
  echo "FAIL: run-generation.sh does not reference validate_node_paths.gd" >&2
  exit 1
fi

if ! grep -qE -- '--script' "$SCRIPT"; then
  echo "FAIL: run-generation.sh does not invoke Godot with --script" >&2
  exit 1
fi

if ! grep -q 'VALIDATION_FAILED' "$SCRIPT"; then
  echo "FAIL: run-generation.sh missing VALIDATION_FAILED on validation error" >&2
  exit 1
fi

if ! grep -q 'E003' "$SCRIPT"; then
  echo "FAIL: run-generation.sh missing E003 on validation error" >&2
  exit 1
fi

# Must not be documented as orphaned anymore
if grep -qi 'Orphaned' "${ROOT}/workers/README.md" && grep -q 'validate_node_paths' "${ROOT}/workers/README.md"; then
  # Only fail if the validate_node_paths row still says orphaned
  if grep -n 'validate_node_paths' "${ROOT}/workers/README.md" | grep -qi 'orphan'; then
    echo "FAIL: workers/README.md still marks validate_node_paths as orphaned" >&2
    exit 1
  fi
fi

# GD script must be a SceneTree headless checker
if ! grep -q 'extends SceneTree' "$GD_SCRIPT"; then
  echo "FAIL: validate_node_paths.gd must extend SceneTree" >&2
  exit 1
fi
if ! grep -q 'quit(1)' "$GD_SCRIPT"; then
  echo "FAIL: validate_node_paths.gd must quit(1) on errors" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node required for mock HTTP server" >&2
  exit 1
fi

# Ensure a working Python is available as python3 (run-generation prefers python3).
# On some Windows hosts `python3` is a Microsoft Store stub that does not run.
PYTHON_SHIM_DIR=""
if ! python3 -c 'import sys' >/dev/null 2>&1; then
  if python -c 'import sys' >/dev/null 2>&1; then
    PYTHON_SHIM_DIR="$(mktemp -d)"
    # shellcheck disable=SC2016
    printf '%s\n' '#!/usr/bin/env bash' 'exec python "$@"' >"${PYTHON_SHIM_DIR}/python3"
    chmod +x "${PYTHON_SHIM_DIR}/python3"
    export PATH="${PYTHON_SHIM_DIR}:${PATH}"
  else
    echo "FAIL: python3 (or python) required for validation layers" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Functional: mock godot (reimport OK, --script fails) → VALIDATION_FAILED E003
# ---------------------------------------------------------------------------
PORT="${PGOS_VALIDATE_NODE_TEST_PORT:-18767}"
HITS_FILE="$(mktemp)"
BODIES_FILE="$(mktemp)"
echo "0" >"$HITS_FILE"
: >"$BODIES_FILE"

HITS_FILE="$HITS_FILE" BODIES_FILE="$BODIES_FILE" PORT="$PORT" node - <<'NODE' &
const http = require("http");
const fs = require("fs");
const hitsPath = process.env.HITS_FILE;
const bodiesPath = process.env.BODIES_FILE;
const port = Number(process.env.PORT);

const server = http.createServer((req, res) => {
  if (req.method !== "PATCH") {
    res.writeHead(405);
    res.end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    let n = Number(fs.readFileSync(hitsPath, "utf8") || "0") + 1;
    fs.writeFileSync(hitsPath, String(n));
    fs.appendFileSync(bodiesPath, body + "\n");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
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

STUB_DIR="$(mktemp -d)"
JOB_ID="00000000-0000-4000-8000-000000000011"
STAGING="/tmp/staging-${JOB_ID}"

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  kill -9 "$SERVER_PID" 2>/dev/null || true
  rm -f "$HITS_FILE" "$BODIES_FILE"
  rm -rf "$STUB_DIR"
  if [[ -n "${PYTHON_SHIM_DIR:-}" ]]; then
    rm -rf "$PYTHON_SHIM_DIR"
  fi
  # Leave staging for debugging only on failure — always clean on success path below
}
trap cleanup EXIT
sleep 0.4

# Mock godot: --editor (reimport) succeeds; --script (node-path) fails with NODE_PATH_ERROR
cat > "${STUB_DIR}/godot" <<'EOF'
#!/usr/bin/env bash
# Mock Godot for M-11 smoke tests
args="$*"
if [[ " $args " == *" --script "* ]]; then
  echo "NODE_PATH_ERROR: failed to load res://scenes/broken.tscn" >&2
  echo "NODE_PATH_FAILED count=1" >&2
  exit 1
fi
# reimport / other invocations
exit 0
EOF
chmod +x "${STUB_DIR}/godot"

# Ensure timeout exists (required by run-generation); if missing, provide a passthrough
if ! command -v timeout >/dev/null 2>&1; then
  cat > "${STUB_DIR}/timeout" <<'EOF'
#!/usr/bin/env bash
# passthrough timeout stub: drop duration arg and exec remainder
shift
exec "$@"
EOF
  chmod +x "${STUB_DIR}/timeout"
fi

export PATH="${STUB_DIR}:${PATH}"
export GODOT_BIN="${STUB_DIR}/godot"
export PGOS_BASE_URL="http://127.0.0.1:${PORT}"
export CALLBACK_TOKEN="test-token"
export JOB_ID
export PROJECT_ID="00000000-0000-4000-8000-000000000022"
export GODOT_VERSION="4.3.0"
export REIMPORT_MAX_RETRIES=0
export NODE_PATH_TIMEOUT_SEC=30
export PGOS_CALLBACK_MAX_RETRIES=1
export PGOS_CALLBACK_BACKOFF_SEC=0

rm -rf "$STAGING"

set +e
bash "$SCRIPT"
RC=$?
set -e

if [[ "$RC" -eq 0 ]]; then
  echo "FAIL: run-generation should exit non-zero when node-path validation fails" >&2
  exit 1
fi

if [[ ! -f "$STAGING/validation_report.json" ]]; then
  echo "FAIL: validation_report.json not written" >&2
  exit 1
fi

python3 - "$STAGING/validation_report.json" <<'PY'
import json, sys, pathlib
r = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert r.get("ok") is False, r
assert r.get("layers", {}).get("node_path") is False, r
np = r.get("node_path") or {}
assert np.get("ok") is False, np
assert np.get("exitCode") == 1, np
print("report_ok=false node_path_exit=", np.get("exitCode"))
PY

# Callback must have PATCHed VALIDATION_FAILED + E003
if ! grep -q 'VALIDATION_FAILED' "$BODIES_FILE"; then
  echo "FAIL: no VALIDATION_FAILED status PATCH recorded" >&2
  echo "bodies:" >&2
  cat "$BODIES_FILE" >&2 || true
  exit 1
fi
if ! grep -q 'E003' "$BODIES_FILE"; then
  echo "FAIL: no E003 errorCode in status PATCH" >&2
  cat "$BODIES_FILE" >&2 || true
  exit 1
fi

# ---------------------------------------------------------------------------
# Happy path: mock godot --script succeeds → validation proceeds to VALIDATION_REPORT
# ---------------------------------------------------------------------------
echo "0" >"$HITS_FILE"
: >"$BODIES_FILE"
rm -rf "$STAGING"

cat > "${STUB_DIR}/godot" <<'EOF'
#!/usr/bin/env bash
args="$*"
if [[ " $args " == *" --script "* ]]; then
  # Assert the real GD script path was passed (not a missing file)
  for a in "$@"; do
    if [[ "$a" == *validate_node_paths.gd ]]; then
      echo "NODE_PATH_OK"
      echo "node path validation ok"
      exit 0
    fi
  done
  echo "mock godot: --script without validate_node_paths.gd: $args" >&2
  exit 2
fi
exit 0
EOF
chmod +x "${STUB_DIR}/godot"

set +e
bash "$SCRIPT"
RC_OK=$?
set -e

if [[ "$RC_OK" -ne 0 ]]; then
  echo "FAIL: run-generation should succeed when node-path validation passes (rc=${RC_OK})" >&2
  cat "$STAGING/node_path_validation.log" 2>/dev/null || true
  cat "$BODIES_FILE" >&2 || true
  exit 1
fi

python3 - "$STAGING/validation_report.json" <<'PY'
import json, sys, pathlib
r = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert r.get("ok") is True, r
assert r.get("layers", {}).get("node_path") is True, r
assert (r.get("node_path") or {}).get("ok") is True, r
print("report_ok=true node_path=ok")
PY

if ! grep -q 'VALIDATION_REPORT' "$BODIES_FILE"; then
  echo "FAIL: expected VALIDATION_REPORT status after successful validation" >&2
  cat "$BODIES_FILE" >&2 || true
  exit 1
fi

# Confirm --script was invoked with the GD file (log or mock path)
if [[ ! -f "$STAGING/node_path_validation.log" ]]; then
  echo "FAIL: node_path_validation.log not written" >&2
  exit 1
fi
if ! grep -q 'NODE_PATH_OK' "$STAGING/node_path_validation.log"; then
  echo "FAIL: expected NODE_PATH_OK in node_path_validation.log" >&2
  cat "$STAGING/node_path_validation.log" >&2
  exit 1
fi

rm -rf "$STAGING"
reap_bg_pid "$SERVER_PID"
SERVER_PID=""
echo "validate-node-paths-smoke: ALL OK"
