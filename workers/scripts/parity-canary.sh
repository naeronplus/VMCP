#!/usr/bin/env bash
# Tier parity canary — real Godot headless reimport checksum (§6.2)
# H-12: reimport failures are loud (reimport_status.txt + non-zero exit)
# L-07: portable millisecond timestamps via Node (not GNU-only date millis)
set -euo pipefail

OUT="${OUT_DIR:-parity-out}"
mkdir -p "$OUT"

# Portable epoch-ms (works on macOS, Alpine, Ubuntu; requires node on PATH)
now_ms() {
  node -e "console.log(Date.now())"
}

START="$(now_ms)"
STAGING="$(mktemp -d)"
cleanup() {
  rm -rf "$STAGING"
}
trap cleanup EXIT

mkdir -p "$STAGING/scenes" "$STAGING/.godot"
cat > "$STAGING/project.godot" <<EOF
config_version=5
[application]
config/name="ParityCanary"
[godot]
version="${GODOT_VERSION:-4.3.1}"
EOF
echo '[gd_scene format=3]
[node name="Root" type="Node2D"]' > "$STAGING/scenes/main.tscn"

# --- Godot headless reimport (H-12: do not swallow failures) ---
REIMPORT_STATUS=0
if ! command -v godot >/dev/null 2>&1; then
  echo "parity-canary: godot not found on PATH" >&2
  REIMPORT_STATUS=1
else
  set +e
  godot --headless --editor --quit --path "$STAGING" >/dev/null 2>&1
  REIMPORT_STATUS=$?
  set -e
  if [[ "$REIMPORT_STATUS" -ne 0 ]]; then
    echo "parity-canary: godot reimport failed with exit ${REIMPORT_STATUS}" >&2
    # Normalize any non-zero to 1 for reimport_status.txt contract (0=ok, 1=fail)
    REIMPORT_STATUS=1
  fi
fi

echo "$REIMPORT_STATUS" > "$OUT/reimport_status.txt"

# Checksum of project files (excluding .godot cache). Still written on reimport
# failure so the compare job can attach diagnostics; compare treats status!=0 as fail.
(
  cd "$STAGING"
  find . -type f ! -path './.godot/*' -print0 | sort -z | xargs -0 sha256sum 2>/dev/null || true
) | sha256sum | awk '{print $1}' > "$OUT/checksum.txt"

END="$(now_ms)"
echo $((END - START)) > "$OUT/duration.txt"

echo "tier=${TIER:-?} checksum=$(cat "$OUT/checksum.txt") duration_ms=$(cat "$OUT/duration.txt") reimport_status=${REIMPORT_STATUS}"

if [[ "$REIMPORT_STATUS" -ne 0 ]]; then
  echo "parity-canary: failing loud — reimport_status=1 (H-12)" >&2
  exit 1
fi
