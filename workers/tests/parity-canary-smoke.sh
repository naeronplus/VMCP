#!/usr/bin/env bash
# H-12 / L-07 smoke: parity-canary writes reimport_status, portable duration, fails loud without godot.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/workers/scripts/parity-canary.sh"
OUT="$(mktemp -d)"
export OUT_DIR="$OUT"
export TIER=smoke
export PATH="/usr/bin:/bin:${PATH}"

# Ensure godot is not on PATH for this smoke (loud fail path)
if command -v godot >/dev/null 2>&1; then
  # Shadow godot with a failing stub so reimport fails loudly
  STUB_DIR="$(mktemp -d)"
  cat > "${STUB_DIR}/godot" <<'EOF'
#!/usr/bin/env bash
echo "stub godot: forced failure" >&2
exit 42
EOF
  chmod +x "${STUB_DIR}/godot"
  export PATH="${STUB_DIR}:${PATH}"
fi

set +e
bash "$SCRIPT"
RC=$?
set -e

if [[ "$RC" -eq 0 ]]; then
  echo "FAIL: parity-canary should exit non-zero when reimport fails" >&2
  exit 1
fi

if [[ ! -f "$OUT/reimport_status.txt" ]]; then
  echo "FAIL: reimport_status.txt not written" >&2
  exit 1
fi
STATUS="$(cat "$OUT/reimport_status.txt")"
if [[ "$STATUS" != "1" ]]; then
  echo "FAIL: expected reimport_status=1 got ${STATUS}" >&2
  exit 1
fi

if [[ ! -f "$OUT/checksum.txt" ]]; then
  echo "FAIL: checksum.txt not written for diagnostics" >&2
  exit 1
fi

if [[ ! -f "$OUT/duration.txt" ]]; then
  echo "FAIL: duration.txt not written" >&2
  exit 1
fi

# duration must be a non-negative integer (portable Date.now() delta)
DUR="$(cat "$OUT/duration.txt")"
if ! [[ "$DUR" =~ ^[0-9]+$ ]]; then
  echo "FAIL: duration_ms not an integer: ${DUR}" >&2
  exit 1
fi

# L-07: script must not invoke GNU-only date millis (ignore comment-only lines)
if grep -nE '^[^#]*date[[:space:]]+\+%s%3N' "$SCRIPT"; then
  echo "FAIL: parity-canary.sh still uses date +%s%3N (L-07)" >&2
  exit 1
fi
if ! grep -q 'Date.now()' "$SCRIPT"; then
  echo "FAIL: parity-canary.sh missing portable Date.now() timestamp" >&2
  exit 1
fi

# H-12: must not swallow godot failures with || true on the godot line
if grep -nE 'godot[[:space:]].*\|\|[[:space:]]*true' "$SCRIPT"; then
  echo "FAIL: parity-canary.sh still has godot ... || true (H-12)" >&2
  exit 1
fi

echo "parity-canary-smoke: OK (rc=${RC} reimport_status=${STATUS} duration_ms=${DUR})"
rm -rf "$OUT"
