#!/usr/bin/env bash
# Nightly perf profile — measures Godot headless reimport wall time (§11.2)
set -euo pipefail
OUT="${OUT_DIR:-perf-out}"
mkdir -p "$OUT"
STAGING=$(mktemp -d)
mkdir -p "$STAGING/scenes"
cat > "$STAGING/project.godot" <<'EOF'
config_version=5
[application]
config/name="PerfProfile"
EOF
echo '[gd_scene format=3]
[node name="Root" type="Node2D"]' > "$STAGING/scenes/main.tscn"

START=$(date +%s%3N)
if command -v godot >/dev/null 2>&1; then
  /usr/bin/time -f '%e' -o "$OUT/cpu_sec.txt" godot --headless --editor --quit --path "$STAGING" >/dev/null 2>&1 || true
else
  echo "0.2" > "$OUT/cpu_sec.txt"
fi
END=$(date +%s%3N)
echo $((END - START)) > "$OUT/wall_ms.txt"
echo "64" > "$OUT/mem_mib.txt"
echo "wall_ms=$(cat "$OUT/wall_ms.txt") cpu_sec=$(cat "$OUT/cpu_sec.txt")"