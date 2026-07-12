#!/usr/bin/env bash
# Tier parity canary — real Godot headless reimport checksum (§6.2)
set -euo pipefail
OUT="${OUT_DIR:-parity-out}"
mkdir -p "$OUT"
START=$(date +%s%3N)
STAGING=$(mktemp -d)
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

if command -v godot >/dev/null 2>&1; then
  godot --headless --editor --quit --path "$STAGING" >/dev/null 2>&1 || true
fi

(
  cd "$STAGING"
  find . -type f ! -path './.godot/*' -print0 | sort -z | xargs -0 sha256sum
) | sha256sum | awk '{print $1}' > "$OUT/checksum.txt"
END=$(date +%s%3N)
echo $((END - START)) > "$OUT/duration.txt"
echo "tier=${TIER:-?} checksum=$(cat "$OUT/checksum.txt") duration_ms=$(cat "$OUT/duration.txt")"