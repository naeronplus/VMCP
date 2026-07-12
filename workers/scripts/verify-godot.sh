#!/usr/bin/env bash
# Exact Godot semver + export template validation (H-09, H-10 / E006).
# Usage: verify-godot.sh [GODOT_VERSION]
# Env: GODOT_VERSION, CALLBACK_TOKEN, PGOS_BASE_URL, JOB_ID (for failure PATCH)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEMVER_JS="${SCRIPT_DIR}/lib/godot-semver.mjs"
REQUESTED="${1:-${GODOT_VERSION:?GODOT_VERSION required}}"
# shellcheck source=lib/pgos-callback.sh
source "${SCRIPT_DIR}/lib/pgos-callback.sh"

if [[ ! -f "$SEMVER_JS" ]]; then
  echo "missing ${SEMVER_JS}" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node is required for exact semver comparison (E006)" >&2
  exit 2
fi

fail_e006() {
  local detail="$1"
  echo "E006 EXPORT_TEMPLATE_MISMATCH: ${detail}" >&2
  if [[ -n "${CALLBACK_TOKEN:-}" && -n "${PGOS_BASE_URL:-}" && -n "${JOB_ID:-}" ]]; then
    local payload
    payload="$(DETAIL="$detail" node -e '
      process.stdout.write(JSON.stringify({
        status: "VALIDATION_FAILED",
        errorCode: "E006",
        errorDetail: process.env.DETAIL || "",
      }));
    ')"
    # M-06: validated PATCH; auth failures must not be silent
    pgos_patch_job_status "$payload" || echo "verify-godot: status PATCH failed (HTTP)" >&2
  fi
  exit 1
}

# Resolve godot binary
GODOT_CMD="${GODOT_BIN:-godot}"
if ! command -v "$GODOT_CMD" >/dev/null 2>&1 && [[ ! -x "$GODOT_CMD" ]]; then
  fail_e006 "godot binary not found on PATH (GODOT_BIN=${GODOT_BIN:-unset})"
fi

set +e
VERSION_LINE="$("$GODOT_CMD" --version 2>&1 | head -n1 | tr -d '\r')"
VER_RC=$?
set -e
if [[ $VER_RC -ne 0 || -z "$VERSION_LINE" ]]; then
  fail_e006 "godot --version failed (rc=${VER_RC}): ${VERSION_LINE}"
fi

echo "Installed godot --version: ${VERSION_LINE}"
echo "Requested GODOT_VERSION: ${REQUESTED}"

# Exact semver equality (not substring grep — 4.3.1 must not match 4.3.10)
set +e
VERSION_OUT="$(node "$SEMVER_JS" check-version "$REQUESTED" "$VERSION_LINE" 2>&1)"
VERSION_RC=$?
set -e
if [[ $VERSION_RC -ne 0 ]]; then
  DETAIL="$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.detail||process.argv[1])}catch{console.log(process.argv[1])}" "$VERSION_OUT")"
  fail_e006 "$DETAIL"
fi
echo "Version check OK: ${VERSION_OUT}"

# Export templates (H-10)
set +e
TPL_OUT="$(node "$SEMVER_JS" check-templates "$REQUESTED" 2>&1)"
TPL_RC=$?
set -e
if [[ $TPL_RC -ne 0 ]]; then
  DETAIL="$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.detail||process.argv[1])}catch{console.log(process.argv[1])}" "$TPL_OUT")"
  fail_e006 "$DETAIL"
fi
echo "Export templates OK: ${TPL_OUT}"
echo "verify-godot: all E006 checks passed for ${REQUESTED}"
