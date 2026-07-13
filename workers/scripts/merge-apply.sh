#!/usr/bin/env bash
# H-02 / H-02-WORKFLOW-SSH: Host-side structural .tscn merge for merge_outbox remote rows.
# Usage (env or flags):
#   PROJECT_ROOT  — Godot project root (local on runner, or path on TARGET_HOST)
#   REL_PATH      — logical path e.g. scenes/player.tscn
#   PATCH_FILE    — JSON patch file (or PATCH_GET_URL to download)
#   OUTBOX_ID     — optional; reported on success via complete callback
#   TARGET_HOST   — when PROJECT_ROOT is not a local dir, apply via commit-agent merge-apply
#   CALLBACK_TOKEN / PGOS_SERVICE_TOKEN — bearer for POST /merge-outbox/:id/complete
#   PGOS_BASE_URL — orchestrator base URL for complete callback
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

# Extract mergedHash from agent/local JSON stdout (single line preferred).
pgos_merge_hash_from_result() {
  local raw="${1:-}"
  echo "$raw" | node -e "
let s='';
process.stdin.on('data',d=>s+=d);
process.stdin.on('end',()=>{
  try {
    const lines = s.trim().split(/\\r?\\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (o && typeof o.mergedHash === 'string' && o.mergedHash) {
          process.stdout.write(o.mergedHash);
          return;
        }
      } catch { /* next line */ }
    }
    const o = JSON.parse(s);
    process.stdout.write(o.mergedHash || '');
  } catch { /* empty */ }
});
"
}

# POST /api/v1/merge-outbox/:id/complete with mergedHash (best-effort when env incomplete).
pgos_report_merge_complete() {
  local result_json="${1:-}"
  if [[ -z "${PGOS_BASE_URL:-}" || -z "${OUTBOX_ID:-}" ]]; then
    return 0
  fi
  local token="${CALLBACK_TOKEN:-${PGOS_SERVICE_TOKEN:-}}"
  if [[ -z "$token" ]]; then
    echo "merge-apply: complete callback skipped (no CALLBACK_TOKEN/PGOS_SERVICE_TOKEN)" >&2
    return 0
  fi
  local hash
  hash="$(pgos_merge_hash_from_result "$result_json")"
  if [[ -z "$hash" ]]; then
    echo "merge-apply: complete callback skipped (no mergedHash in result)" >&2
    return 0
  fi
  local base="${PGOS_BASE_URL%/}"
  curl -sS -f -X POST "${base}/api/v1/merge-outbox/${OUTBOX_ID}/complete" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "{\"mergedHash\":\"${hash}\"}" \
    || {
      echo "merge-apply: complete callback failed for outbox=${OUTBOX_ID}" >&2
      return 1
    }
  echo "merge-apply: reported complete outbox=${OUTBOX_ID}"
}

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
  pgos_report_merge_complete "$result" || true
  exit 0
fi

if [[ -z "${TARGET_HOST:-}" ]]; then
  echo "project root not found and TARGET_HOST unset: $PROJECT_ROOT" >&2
  exit 1
fi

echo "PROJECT_ROOT not local; ForcedCommand merge-apply on TARGET_HOST" >&2
if ! command -v pgos_ssh_agent_stdin >/dev/null 2>&1 && ! type pgos_ssh_agent_stdin >/dev/null 2>&1; then
  echo "remote merge-apply failed — pgos_ssh_agent_stdin unavailable (source pgos-remote.sh)" >&2
  exit 1
fi

# JOB_ID required by pgos-remote key path when using ephemeral SSH from resolve-secrets.
if [[ -z "${JOB_ID:-}" ]]; then
  export JOB_ID="merge-${OUTBOX_ID:-$$}"
fi

set +e
result="$(pgos_ssh_agent_stdin "merge-apply ${PROJECT_ROOT} ${REL_PATH}" <"$PATCH_FILE" 2>"$WORK/remote.err")"
remote_rc=$?
set -e
if [[ -s "$WORK/remote.err" ]]; then
  # Agent diagnostics on stderr only — never dump PEM
  cat "$WORK/remote.err" >&2
fi
if [[ "$remote_rc" -ne 0 ]]; then
  echo "remote merge-apply failed — ensure commit-agent merge-apply or co-locate project_root (exit ${remote_rc})" >&2
  exit 1
fi

echo "$result"
# Prefer JSON line from agent; if empty stdout, fail closed on complete (hash required for audit).
if [[ -z "$(echo "$result" | tr -d '[:space:]')" ]]; then
  echo "remote merge-apply produced empty stdout" >&2
  exit 1
fi
# Complete callback is required for remote success so outbox leaves "dispatched".
pgos_report_merge_complete "$result"
exit 0
