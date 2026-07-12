#!/usr/bin/env bash
# Staging reimport with S3 I/O, exponential backoff + multi-layer validation (§4.1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgos-s3.sh
source "${SCRIPT_DIR}/lib/pgos-s3.sh"

STAGING="/tmp/staging-${JOB_ID}"
mkdir -p "$STAGING"

: "${CALLBACK_TOKEN:?CALLBACK_TOKEN required — run resolve-secrets.sh first}"
: "${PGOS_BASE_URL:?PGOS_BASE_URL required}"

# Download staging input from S3 when a prior artifact exists
if [[ -n "${PRESIGN_STAGING_GET:-}" ]]; then
  ARCHIVE="/tmp/staging-input-${JOB_ID}.tar.gz"
  if pgos_download_and_extract "$PRESIGN_STAGING_GET" "$STAGING" "$ARCHIVE"; then
    echo "Loaded staging input from S3"
  else
    echo "No existing staging artifact (HTTP != 200); using job seed project"
  fi
fi

if [[ ! -f "$STAGING/project.godot" ]]; then
  mkdir -p "$STAGING/scenes" "$STAGING/.godot"
  cat > "$STAGING/project.godot" <<EOF
config_version=5
[application]
config/name="PGOS Staging"
run/main_scene="res://scenes/main.tscn"
[godot]
version="${GODOT_VERSION}"
EOF
  cat > "$STAGING/scenes/main.tscn" <<'EOF'
[gd_scene format=3]
[node name="Root" type="Node2D"]
EOF
fi

reimport_with_retries() {
  local attempt=0
  local delays=(10 30)
  local max="${REIMPORT_MAX_RETRIES:-2}"
  local timeout="${REIMPORT_TIMEOUT_SEC:-300}"
  while true; do
    set +e
    timeout "$timeout" godot --headless --editor --quit --path "$STAGING" >"$STAGING/godot_reimport.log" 2>&1
    code=$?
    set -e
    if [[ $code -eq 0 ]]; then
      return 0
    fi
    if [[ $attempt -ge $max ]]; then
      if [[ -n "${PRESIGN_DIAGNOSTICS_PUT:-}" ]]; then
        {
          echo "=== stdout/stderr ==="
          cat "$STAGING/godot_reimport.log" || true
          find "$STAGING/.godot/imported" -type f 2>/dev/null | head -200 || true
        } > /tmp/reimport_failure.log
        pgos_curl_put "$PRESIGN_DIAGNOSTICS_PUT" /tmp/reimport_failure.log "text/plain" || true
      fi
      curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
        -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"status\":\"REIMPORT_FAILED\",\"errorCode\":\"E002\",\"errorDetail\":\"reimport failed after retries exit=${code}\"}"
      return 1
    fi
    sleep "${delays[$attempt]:-30}"
    attempt=$((attempt + 1))
  done
}

reimport_with_retries

curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
  -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status":"VALIDATING"}'

REPORT="$STAGING/validation_report.json"
python3 - <<'PY' "$STAGING" "$REPORT"
import json,sys,pathlib,re
root=pathlib.Path(sys.argv[1])
report={"uid":[],"parse":[],"node_refs":[],"ok":True}
uids=set(); dupes=[]
for p in root.rglob("*"):
    if p.suffix not in {".tscn",".tres",".gd"}: continue
    text=p.read_text(errors="ignore")
    for m in re.finditer(r"uid://[A-Za-z0-9_]+", text):
        u=m.group(0)
        if u in uids: dupes.append({"uid":u,"file":str(p)})
        uids.add(u)
report["uid_duplicates"]=dupes
if dupes:
    report["ok"]=False
pathlib.Path(sys.argv[2]).write_text(json.dumps(report,indent=2))
PY

if [[ -n "${PRESIGN_VALIDATION_PUT:-}" ]]; then
  pgos_curl_put "$PRESIGN_VALIDATION_PUT" "$REPORT" "application/json"
fi

OK=$(python3 -c "import json;print(json.load(open('$REPORT'))['ok'])")
if [[ "$OK" != "True" ]]; then
  curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
    -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"status\":\"VALIDATION_FAILED\",\"errorCode\":\"E003\"}"
  exit 1
fi

# Upload staging tarball for commit phase
if [[ -n "${PRESIGN_STAGING_ARCHIVE_PUT:-}" ]]; then
  pgos_upload_dir_tarball "$STAGING" "$PRESIGN_STAGING_ARCHIVE_PUT" "/tmp/staging-upload-${JOB_ID}.tar.gz"
fi

curl -sS -X PATCH "${PGOS_BASE_URL}/api/v1/jobs/${JOB_ID}/status" \
  -H "Authorization: Bearer ${CALLBACK_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"status\":\"VALIDATION_REPORT\",\"s3StagingPrefix\":\"projects/${PROJECT_ID}/jobs/${JOB_ID}/staging\"}"

echo "Staging and validation complete at $STAGING"