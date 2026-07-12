#!/usr/bin/env bash
# Host-side UID file rewrite + Godot reimport when project files are not on orchestrator (H-03).
# Usage:
#   uid-reconcile.sh <project_root> <replacements.json>
# replacements.json: { "uid://OLD": "uid://NEW", ... }
set -euo pipefail

PROJECT_ROOT="${1:?project root required}"
MAP_FILE="${2:?replacements json path required}"
GODOT_BIN="${GODOT_BIN:-godot}"
TIMEOUT_SEC="${UID_RECONCILE_TIMEOUT_SEC:-300}"

if [[ ! -d "$PROJECT_ROOT" ]]; then
  echo "project root not found: $PROJECT_ROOT" >&2
  exit 1
fi
if [[ ! -f "$MAP_FILE" ]]; then
  echo "map file not found: $MAP_FILE" >&2
  exit 1
fi

# Apply replacements with Node for safe full-token substitution
node --input-type=module <<'NODE' "$PROJECT_ROOT" "$MAP_FILE"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = process.argv[2];
const map = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const UID_RE = /uid:\/\/[A-Za-z0-9_-]+/g;
const EXTS = new Set(['.tscn', '.tres', '.import', '.gd', '.cfg', '.uid']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === '.godot' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (EXTS.has(path.extname(e.name).toLowerCase()) || e.name.endsWith('.uid')) out.push(full);
  }
  return out;
}

let filesTouched = 0;
let reps = 0;
for (const file of walk(projectRoot)) {
  let text = fs.readFileSync(file, 'utf8');
  let count = 0;
  const next = text.replace(UID_RE, (tok) => {
    if (map[tok] && map[tok] !== tok) {
      count++;
      return map[tok];
    }
    return tok;
  });
  if (count > 0) {
    fs.writeFileSync(file, next, 'utf8');
    filesTouched++;
    reps += count;
  }
}
console.log(JSON.stringify({ filesTouched, replacements: reps }));
NODE

echo "Running Godot reimport on ${PROJECT_ROOT}"
set +e
timeout "$TIMEOUT_SEC" "$GODOT_BIN" --headless --editor --quit --path "$PROJECT_ROOT"
code=$?
set -e
if [[ $code -ne 0 ]]; then
  echo "Godot reimport failed (exit $code) — raise E008 for manual review" >&2
  exit 2
fi
echo "uid-reconcile complete"
