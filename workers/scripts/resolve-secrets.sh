#!/usr/bin/env bash
# Resolve dispatch JWE — callback credential embedded; never in workflow inputs (§9.4)
set -euo pipefail

: "${PGOS_BASE_URL:?PGOS_BASE_URL required}"
: "${SECRET_JWE:?SECRET_JWE required}"
: "${JOB_ID:?JOB_ID required}"

RESP=$(curl -sS -w '\n%{http_code}' -X POST "${PGOS_BASE_URL}/api/v1/resolve-secret" \
  -H "Content-Type: application/json" \
  -d "{\"jwe\":\"${SECRET_JWE}\"}")

HTTP_CODE=$(echo "$RESP" | tail -n1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "resolve-secret failed HTTP ${HTTP_CODE}: ${BODY}" >&2
  exit 1
fi

if ! echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('secrets')"; then
  echo "resolve-secret response missing secrets envelope" >&2
  exit 1
fi

# Parse secrets JSON and export env vars for subsequent steps
eval "$(python3 - <<'PY' "$BODY"
import json, os, shlex, sys
data = json.loads(sys.argv[1])
secrets = data.get("secrets") or {}
urls = secrets.get("presignedUrls") or {}

def emit(key, val):
    if val is None or val == "":
        return
    print(f"export {key}={shlex.quote(str(val))}")

emit("CALLBACK_TOKEN", secrets.get("callbackToken"))
emit("FENCING_TOKEN", secrets.get("fencingToken"))
emit("PGOS_LOCK_KEY", secrets.get("lockKey"))
emit("PGOS_LOCK_OWNER", secrets.get("lockOwner"))
emit("TARGET_PROJECT_ROOT", secrets.get("targetProjectRoot"))
emit("TARGET_HOST", secrets.get("targetHost"))
emit("SSH_PRIVATE_KEY_PEM", secrets.get("sshPrivateKey"))

emit("PRESIGN_STAGING_PUT", urls.get("stagingPut"))
emit("PRESIGN_STAGING_GET", urls.get("stagingGet"))
emit("PRESIGN_STAGING_ARCHIVE_PUT", urls.get("stagingArchivePut"))
emit("PRESIGN_VALIDATION_PUT", urls.get("validationPut"))
emit("PRESIGN_SNAPSHOT_PUT", urls.get("snapshotPut"))
emit("PRESIGN_SNAPSHOT_GET", urls.get("snapshotGet"))
emit("PRESIGN_DIAGNOSTICS_PUT", urls.get("diagnosticsPut"))
PY
)"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "CALLBACK_TOKEN=${CALLBACK_TOKEN:-}"
    echo "FENCING_TOKEN=${FENCING_TOKEN:-}"
    echo "PGOS_LOCK_KEY=${PGOS_LOCK_KEY:-}"
    echo "PGOS_LOCK_OWNER=${PGOS_LOCK_OWNER:-}"
    echo "TARGET_PROJECT_ROOT=${TARGET_PROJECT_ROOT:-}"
    echo "TARGET_HOST=${TARGET_HOST:-}"
    echo "PRESIGN_STAGING_PUT=${PRESIGN_STAGING_PUT:-}"
    echo "PRESIGN_STAGING_GET=${PRESIGN_STAGING_GET:-}"
    echo "PRESIGN_STAGING_ARCHIVE_PUT=${PRESIGN_STAGING_ARCHIVE_PUT:-}"
    echo "PRESIGN_VALIDATION_PUT=${PRESIGN_VALIDATION_PUT:-}"
    echo "PRESIGN_SNAPSHOT_PUT=${PRESIGN_SNAPSHOT_PUT:-}"
    echo "PRESIGN_SNAPSHOT_GET=${PRESIGN_SNAPSHOT_GET:-}"
    echo "PRESIGN_DIAGNOSTICS_PUT=${PRESIGN_DIAGNOSTICS_PUT:-}"
  } >> "$GITHUB_ENV"
fi

: "${CALLBACK_TOKEN:?CALLBACK_TOKEN missing from resolve-secret response}"

echo "Secrets resolved for job ${JOB_ID}"