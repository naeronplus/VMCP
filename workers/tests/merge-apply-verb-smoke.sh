#!/usr/bin/env bash
# H-02-MERGE-VERB: run real commit-agent -once "merge-apply …" against a fixture tree.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AGENT_DIR="${ROOT}/packages/commit-agent"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Build agent binary (windows: commit-agent.exe)
BIN_NAME="commit-agent"
if [[ "$(uname -s 2>/dev/null || echo unknown)" == MINGW* ]] || [[ "$(uname -s 2>/dev/null || echo unknown)" == MSYS* ]]; then
  BIN_NAME="commit-agent.exe"
fi
BIN="${WORK}/${BIN_NAME}"

echo "Building commit-agent for merge-apply verb smoke..."
(
  cd "$AGENT_DIR"
  go build -o "$BIN" ./cmd/agent
)

if [[ ! -x "$BIN" && ! -f "$BIN" ]]; then
  echo "FAIL: go build did not produce $BIN" >&2
  exit 1
fi

# Fixture project under allowed -project-root
GAME="${WORK}/game"
REL="scenes/player.tscn"
mkdir -p "${GAME}/scenes"
cat >"${GAME}/${REL}" <<'EOF'
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1_script"]

[node name="Root" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="Root"]
position = Vector2(0, 0)
EOF

PATCH="${WORK}/patch.json"
cat >"$PATCH" <<'EOF'
{
  "nodes": [
    {
      "path": "Root/Player",
      "properties": { "position": "Vector2(10, 0)" }
    }
  ]
}
EOF

# Nonce log under WORK so agent does not touch system paths
export PGOS_AGENT_TOKEN=""

# Go on Windows does not treat MSYS /tmp paths as under each other — convert to
# mixed Windows paths (C:/Users/...) when cygpath is available (Git Bash).
to_go_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$p"
  else
    echo "$p"
  fi
}
PROJECT_ROOT_GO="$(to_go_path "$WORK")"
GAME_GO="$(to_go_path "$GAME")"
NONCE_LOG_GO="$(to_go_path "${WORK}/nonces.log")"

set +e
out="$(
  "$BIN" \
    -project-root "$PROJECT_ROOT_GO" \
    -nonce-log "$NONCE_LOG_GO" \
    -once "merge-apply ${GAME_GO} ${REL}" \
    <"$PATCH" 2>"$WORK/stderr.log"
)"
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  echo "FAIL: commit-agent merge-apply exited $rc"
  cat "$WORK/stderr.log" || true
  echo "stdout: $out"
  exit 1
fi

if ! echo "$out" | grep -q '"ok":true'; then
  echo "FAIL: expected ok:true in stdout JSON"
  echo "$out"
  exit 1
fi

if ! echo "$out" | grep -q 'mergedHash'; then
  echo "FAIL: expected mergedHash in stdout JSON"
  echo "$out"
  exit 1
fi

if ! grep -q 'Vector2(10, 0)' "${GAME}/${REL}"; then
  echo "FAIL: fixture .tscn not updated with patched position"
  cat "${GAME}/${REL}"
  exit 1
fi

# E019: script property patch must fail
BAD="${WORK}/bad-script.json"
cat >"$BAD" <<'EOF'
{
  "nodes": [
    {
      "path": "Root/Player",
      "properties": { "script": "ExtResource(\"1_script\")" }
    }
  ]
}
EOF

set +e
bad_out="$(
  "$BIN" \
    -project-root "$PROJECT_ROOT_GO" \
    -nonce-log "$NONCE_LOG_GO" \
    -once "merge-apply ${GAME_GO} ${REL}" \
    <"$BAD" 2>"$WORK/bad.err"
)"
bad_rc=$?
set -e

if [[ $bad_rc -eq 0 ]]; then
  echo "FAIL: script patch should be rejected (E019)"
  echo "$bad_out"
  exit 1
fi
if ! grep -qiE 'E019|script' "$WORK/bad.err"; then
  echo "FAIL: expected E019/script rejection on stderr"
  cat "$WORK/bad.err"
  exit 1
fi

echo "merge-apply-verb-smoke: ALL OK"
