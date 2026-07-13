#!/usr/bin/env bash
# Resolve dispatch JWE — callback credential embedded; never in workflow inputs (§9.4)
# M-07: mask CALLBACK_TOKEN in GitHub Actions before GITHUB_ENV; prefer RUNNER_TEMP file (mode 600)
# L-12: error paths log HTTP status only — never response body
set -euo pipefail

: "${PGOS_BASE_URL:?PGOS_BASE_URL required}"
: "${SECRET_JWE:?SECRET_JWE required}"
: "${JOB_ID:?JOB_ID required}"

# Register JWE for redaction in Actions logs as early as possible (M-07)
pgos_gha_mask() {
  local value="${1:-}"
  # Only emit when running under Actions (GITHUB_ACTIONS or GITHUB_ENV set by the runner)
  if [[ -z "$value" ]]; then
    return 0
  fi
  if [[ -n "${GITHUB_ACTIONS:-}" || -n "${GITHUB_ENV:-}" ]]; then
    # Exact string match mask; token must not contain newlines
    echo "::add-mask::${value}"
  fi
}

pgos_gha_mask "${SECRET_JWE}"

# Capture body + status; do not print body on failure (L-12)
RESP=$(curl -sS -w '\n%{http_code}' -X POST "${PGOS_BASE_URL}/api/v1/resolve-secret" \
  -H "Content-Type: application/json" \
  -d "{\"jwe\":\"${SECRET_JWE}\"}")

HTTP_CODE=$(echo "$RESP" | tail -n1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$HTTP_CODE" != "200" ]]; then
  # Never log response body (may contain secret material) — L-12 / H-11
  echo "resolve-secret failed HTTP ${HTTP_CODE}" >&2
  unset RESP BODY
  exit 1
fi

# Prefer Node for portable JSON parse (GHA runners always have node; python3 optional).
if ! command -v node >/dev/null 2>&1; then
  echo "resolve-secrets: node is required to parse resolve-secret response" >&2
  unset RESP BODY
  exit 1
fi

if ! echo "$BODY" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c));
  process.stdin.on("end", () => {
    try {
      const d = JSON.parse(s);
      if (!d || typeof d !== "object" || !d.secrets) {
        process.stderr.write("resolve-secret response missing secrets envelope\n");
        process.exit(1);
      }
      process.exit(0);
    } catch {
      process.stderr.write("resolve-secret response is not valid JSON\n");
      process.exit(1);
    }
  });
'; then
  # Do not echo BODY — may contain tokens
  unset RESP BODY
  exit 1
fi

# Parse secrets JSON and export env vars for subsequent steps.
# SSH private key is written to a 600 file only — never to GITHUB_ENV / logs (H-11).
eval "$(
  BODY_JSON="$BODY" node <<'NODE'
const data = JSON.parse(process.env.BODY_JSON || '{}');
const secrets = data.secrets || {};
const urls = secrets.presignedUrls || {};
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
function emit(key, val) {
  if (val == null || val === '') return;
  process.stdout.write('export ' + key + '=' + shellQuote(val) + '\n');
}
emit('CALLBACK_TOKEN', secrets.callbackToken);
emit('FENCING_TOKEN', secrets.fencingToken);
emit('PGOS_LOCK_KEY', secrets.lockKey);
emit('PGOS_LOCK_OWNER', secrets.lockOwner);
emit('TARGET_PROJECT_ROOT', secrets.targetProjectRoot);
emit('TARGET_HOST', secrets.targetHost);
// L-05: orchestrator-configured reimport policy (overrides runner defaults when present)
emit('REIMPORT_TIMEOUT_SEC', secrets.reimportTimeoutSec);
emit('REIMPORT_MAX_RETRIES', secrets.reimportMaxRetries);
// H-02 merge-apply: optional fields sealed in direct-dispatch JWE
emit('OUTBOX_ID_RESOLVED', secrets.outboxId);
emit('REL_PATH_RESOLVED', secrets.relPath);
emit('PGOS_BASE_URL_RESOLVED', secrets.pgosBaseUrl);
emit('PATCH_GET_URL_RESOLVED', secrets.patchGetUrl);
// Ephemeral only for materialization below — not for GITHUB_ENV
emit('SSH_PRIVATE_KEY_PEM', secrets.sshPrivateKey);
emit('PRESIGN_STAGING_PUT', urls.stagingPut);
emit('PRESIGN_STAGING_GET', urls.stagingGet);
emit('PRESIGN_STAGING_ARCHIVE_PUT', urls.stagingArchivePut);
emit('PRESIGN_VALIDATION_PUT', urls.validationPut);
emit('PRESIGN_SNAPSHOT_PUT', urls.snapshotPut);
emit('PRESIGN_SNAPSHOT_GET', urls.snapshotGet);
emit('PRESIGN_DIAGNOSTICS_PUT', urls.diagnosticsPut);
NODE
)"

# Drop raw response from shell memory as soon as parsed
unset RESP BODY BODY_JSON

: "${CALLBACK_TOKEN:?CALLBACK_TOKEN missing from resolve-secret response}"

# --- M-07: mask secrets BEFORE any GITHUB_ENV / file writes that could be logged ---
pgos_gha_mask "${CALLBACK_TOKEN}"
if [[ -n "${FENCING_TOKEN:-}" ]]; then
  pgos_gha_mask "${FENCING_TOKEN}"
fi
# Presigned URLs are short-lived credentials — mask when present
for _u in \
  "${PRESIGN_STAGING_PUT:-}" \
  "${PRESIGN_STAGING_GET:-}" \
  "${PRESIGN_STAGING_ARCHIVE_PUT:-}" \
  "${PRESIGN_VALIDATION_PUT:-}" \
  "${PRESIGN_SNAPSHOT_PUT:-}" \
  "${PRESIGN_SNAPSHOT_GET:-}" \
  "${PRESIGN_DIAGNOSTICS_PUT:-}"; do
  pgos_gha_mask "${_u}"
done

# Prefer RUNNER_TEMP (GHA job temp, cleaned after job); else TMPDIR; else /tmp
TOKEN_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
mkdir -p "$TOKEN_DIR"
CALLBACK_TOKEN_FILE="${TOKEN_DIR}/pgos-callback-token-${JOB_ID}"
umask 077
# No trailing newline required for token material; printf avoids accidental newline variance
printf '%s' "${CALLBACK_TOKEN}" >"${CALLBACK_TOKEN_FILE}"
chmod 600 "${CALLBACK_TOKEN_FILE}"
export CALLBACK_TOKEN_FILE

# H-11: materialize SSH key to disk for later steps on the same runner (/tmp persists).
# Never write PEM into GITHUB_ENV (would appear in debug logs).
if [[ -n "${SSH_PRIVATE_KEY_PEM:-}" ]]; then
  KEY_FILE="/tmp/pgos-ssh-key-${JOB_ID}"
  umask 077
  printf '%s\n' "$SSH_PRIVATE_KEY_PEM" >"$KEY_FILE"
  chmod 600 "$KEY_FILE"
  unset SSH_PRIVATE_KEY_PEM
  export SSH_PRIVATE_KEY_PEM=""
  echo "Ephemeral SSH key materialised for job (path not logged)"
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  # Values are already ::add-mask:: registered so Actions redacts them in logs.
  {
    echo "CALLBACK_TOKEN=${CALLBACK_TOKEN:-}"
    echo "CALLBACK_TOKEN_FILE=${CALLBACK_TOKEN_FILE:-}"
    echo "FENCING_TOKEN=${FENCING_TOKEN:-}"
    echo "PGOS_LOCK_KEY=${PGOS_LOCK_KEY:-}"
    echo "PGOS_LOCK_OWNER=${PGOS_LOCK_OWNER:-}"
    echo "TARGET_PROJECT_ROOT=${TARGET_PROJECT_ROOT:-}"
    echo "TARGET_HOST=${TARGET_HOST:-}"
    echo "REIMPORT_TIMEOUT_SEC=${REIMPORT_TIMEOUT_SEC:-}"
    echo "REIMPORT_MAX_RETRIES=${REIMPORT_MAX_RETRIES:-}"
    echo "OUTBOX_ID_RESOLVED=${OUTBOX_ID_RESOLVED:-}"
    echo "REL_PATH_RESOLVED=${REL_PATH_RESOLVED:-}"
    echo "PGOS_BASE_URL_RESOLVED=${PGOS_BASE_URL_RESOLVED:-}"
    echo "PATCH_GET_URL_RESOLVED=${PATCH_GET_URL_RESOLVED:-}"
    echo "PRESIGN_STAGING_PUT=${PRESIGN_STAGING_PUT:-}"
    echo "PRESIGN_STAGING_GET=${PRESIGN_STAGING_GET:-}"
    echo "PRESIGN_STAGING_ARCHIVE_PUT=${PRESIGN_STAGING_ARCHIVE_PUT:-}"
    echo "PRESIGN_VALIDATION_PUT=${PRESIGN_VALIDATION_PUT:-}"
    echo "PRESIGN_SNAPSHOT_PUT=${PRESIGN_SNAPSHOT_PUT:-}"
    echo "PRESIGN_SNAPSHOT_GET=${PRESIGN_SNAPSHOT_GET:-}"
    echo "PRESIGN_DIAGNOSTICS_PUT=${PRESIGN_DIAGNOSTICS_PUT:-}"
    # Deliberately omit SSH_PRIVATE_KEY_PEM
  } >> "$GITHUB_ENV"
fi

echo "Secrets resolved for job ${JOB_ID} (callback token masked; file mode 600 under RUNNER_TEMP when available)"
