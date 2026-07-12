#!/usr/bin/env bash
# H-02: Host-side structural .tscn merge for merge_outbox remote rows.
# Usage (env or flags):
#   PROJECT_ROOT  — Godot project root on this host
#   REL_PATH      — logical path e.g. scenes/player.tscn
#   PATCH_FILE    — JSON patch file (or PATCH_GET_URL to download)
#   OUTBOX_ID     — optional; reported on success
#   TARGET_HOST   — optional; when set and PROJECT_ROOT not local, apply via SSH
#                   (requires commit-agent merge-apply or co-located tree)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgos-s3.sh
source "${SCRIPT_DIR}/lib/pgos-s3.sh" 2>/dev/null || true
# shellcheck source=lib/pgos-remote.sh
source "${SCRIPT_DIR}/lib/pgos-remote.sh" 2>/dev/null || true

PROJECT_ROOT="${PROJECT_ROOT:-${1:-}}"
REL_PATH="${REL_PATH:-${2:-}}"
PATCH_FILE="${PATCH_FILE:-${3:-}}"
OUTBOX_ID="${OUTBOX_ID:-}"
PATCH_GET_URL="${PATCH_GET_URL:-}"

if [[ -z "$PROJECT_ROOT" || -z "$REL_PATH" ]]; then
  echo "usage: PROJECT_ROOT=... REL_PATH=... PATCH_FILE=... merge-apply.sh" >&2
  echo "   or: merge-apply.sh <project_root> <rel_path> <patch.json>" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [[ -z "$PATCH_FILE" || ! -f "$PATCH_FILE" ]]; then
  if [[ -n "$PATCH_GET_URL" ]]; then
    PATCH_FILE="$WORK/patch.json"
    code="$(pgos_curl_get "$PATCH_GET_URL" "$PATCH_FILE" 2>/dev/null || echo 000)"
    if [[ "$code" != "200" && ! -s "$PATCH_FILE" ]]; then
      # Fallback raw curl if pgos_curl_get unavailable
      curl -sS -f -o "$PATCH_FILE" "$PATCH_GET_URL"
    fi
  else
    echo "PATCH_FILE or PATCH_GET_URL required" >&2
    exit 2
  fi
fi

if [[ ! -f "$PATCH_FILE" ]]; then
  echo "patch file missing: $PATCH_FILE" >&2
  exit 1
fi

apply_local() {
  local root="$1"
  local rel="$2"
  local patch="$3"
  local target="${root%/}/${rel}"
  local merge_lib="${SCRIPT_DIR}/lib/tscn-merge.mjs"
  if [[ ! -f "$target" ]]; then
    echo "base .tscn not found: $target" >&2
    return 1
  fi
  if [[ ! -f "$merge_lib" ]]; then
    echo "tscn-merge.mjs not found at $merge_lib" >&2
    return 1
  fi
  TSCN_MERGE_LIB="$merge_lib" node --input-type=module - "$root" "$rel" "$patch" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const projectRoot = process.argv[2];
const rel = process.argv[3];
const patchPath = process.argv[4];
const mergeLib = process.env.TSCN_MERGE_LIB;
const { applyTscnPatch } = await import(pathToFileURL(mergeLib).href);

const full = path.resolve(projectRoot, rel);
const base = fs.readFileSync(full, 'utf8');
const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
const merged = applyTscnPatch(base, patch);
const hash = crypto.createHash('sha256').update(merged).digest('hex');
const tmp = `${full}.pgos-merge-${process.pid}`;
fs.writeFileSync(tmp, merged, 'utf8');
fs.renameSync(tmp, full);
console.log(JSON.stringify({ ok: true, mergedHash: hash, path: rel }));
NODE
}

if [[ -d "$PROJECT_ROOT" ]]; then
  echo "Applying merge locally under ${PROJECT_ROOT}"
  result="$(apply_local "$PROJECT_ROOT" "$REL_PATH" "$PATCH_FILE")"
  echo "$result"
  # Optional: report completion to orchestrator
  if [[ -n "${PGOS_BASE_URL:-}" && -n "${OUTBOX_ID:-}" && -n "${CALLBACK_TOKEN:-}${PGOS_SERVICE_TOKEN:-}" ]]; then
    hash="$(echo "$result" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(s).mergedHash||'')}catch{}})")"
    token="${CALLBACK_TOKEN:-${PGOS_SERVICE_TOKEN}}"
    curl -sS -X POST "${PGOS_BASE_URL}/api/v1/merge-outbox/${OUTBOX_ID}/complete" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      -d "{\"mergedHash\":\"${hash}\"}" || true
  fi
  exit 0
fi

if [[ -n "${TARGET_HOST:-}" ]]; then
  echo "PROJECT_ROOT not local; attempting ForcedCommand merge-apply on TARGET_HOST" >&2
  # Pipe patch JSON to remote verb (commit-agent merge-apply if installed)
  if command -v pgos_ssh_agent_stdin >/dev/null 2>&1 || type pgos_ssh_agent_stdin >/dev/null 2>&1; then
    if pgos_ssh_agent_stdin "merge-apply ${PROJECT_ROOT} ${REL_PATH}" <"$PATCH_FILE"; then
      echo '{"ok":true,"mode":"remote_ssh"}'
      exit 0
    fi
  fi
  echo "remote merge-apply failed — ensure commit-agent merge-apply or co-locate project_root" >&2
  exit 1
fi

echo "project root not found and TARGET_HOST unset: $PROJECT_ROOT" >&2
exit 1
