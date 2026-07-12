#!/usr/bin/env bash
# Staging reimport with S3 I/O, exponential backoff + multi-layer validation (§4.1)
# M-06: status PATCH via pgos_callback_patch (HTTP validated, 5xx retry, 401/403 hard-fail)
# M-11: Godot node-path layer via validate_node_paths.gd (headless --script)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pgos-s3.sh
source "${SCRIPT_DIR}/lib/pgos-s3.sh"
# shellcheck source=lib/pgos-callback.sh
source "${SCRIPT_DIR}/lib/pgos-callback.sh"

STAGING="/tmp/staging-${JOB_ID}"
mkdir -p "$STAGING"

: "${CALLBACK_TOKEN:?CALLBACK_TOKEN required — run resolve-secrets.sh first}"
: "${PGOS_BASE_URL:?PGOS_BASE_URL required}"

GODOT_CMD="${GODOT_BIN:-godot}"
NODE_PATH_SCRIPT="${SCRIPT_DIR}/validate_node_paths.gd"
NODE_PATH_TIMEOUT_SEC="${NODE_PATH_TIMEOUT_SEC:-120}"

# Prefer python3 (Linux runners); fall back to python (some Windows/dev hosts).
# Probe with a real import — Microsoft Store python3 stubs are on PATH but unusable.
if python3 -c 'import sys' >/dev/null 2>&1; then
  PYTHON_CMD="python3"
elif python -c 'import sys' >/dev/null 2>&1; then
  PYTHON_CMD="python"
else
  echo "run-generation: python3 (or python) is required for validation" >&2
  exit 1
fi

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
    timeout "$timeout" "$GODOT_CMD" --headless --editor --quit --path "$STAGING" >"$STAGING/godot_reimport.log" 2>&1
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
      pgos_patch_job_status "{\"status\":\"REIMPORT_FAILED\",\"errorCode\":\"E002\",\"errorDetail\":\"reimport failed after retries exit=${code}\"}"
      return 1
    fi
    sleep "${delays[$attempt]:-30}"
    attempt=$((attempt + 1))
  done
}

reimport_with_retries

pgos_patch_job_status '{"status":"VALIDATING"}'

REPORT="$STAGING/validation_report.json"
NODE_PATH_LOG="$STAGING/node_path_validation.log"

# ---------------------------------------------------------------------------
# Multi-layer validation (E003 on any failure)
#   Layer 1 — Python UID integrity over .tscn/.tres/.gd
#   Layer 2 — Godot headless validate_node_paths.gd (load + instantiate .tscn)
# ---------------------------------------------------------------------------

# Layer 1: text/UID integrity
"$PYTHON_CMD" - "$STAGING" "$REPORT" <<'PY'
import json, sys, pathlib, re

root = pathlib.Path(sys.argv[1])
report_path = pathlib.Path(sys.argv[2])
report = {
    "uid": [],
    "parse": [],
    "node_refs": [],
    "uid_duplicates": [],
    "node_path": {"ok": None, "exitCode": None, "errors": []},
    "layers": {"uid": True, "node_path": None},
    "ok": True,
}
uids = set()
dupes = []
for p in root.rglob("*"):
    if p.suffix not in {".tscn", ".tres", ".gd"}:
        continue
    # Skip Godot cache / VCS noise
    parts = set(p.parts)
    if ".godot" in parts or ".git" in parts:
        continue
    text = p.read_text(errors="ignore")
    for m in re.finditer(r"uid://[A-Za-z0-9_]+", text):
        u = m.group(0)
        if u in uids:
            dupes.append({"uid": u, "file": str(p)})
        uids.add(u)
report["uid_duplicates"] = dupes
if dupes:
    report["ok"] = False
    report["layers"]["uid"] = False
report_path.write_text(json.dumps(report, indent=2))
PY

# Layer 2: Godot node-path integrity (M-11)
if [[ ! -f "$NODE_PATH_SCRIPT" ]]; then
  echo "run-generation: FATAL — validate_node_paths.gd missing at ${NODE_PATH_SCRIPT}" >&2
  "$PYTHON_CMD" - "$REPORT" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
r = json.loads(p.read_text())
r["ok"] = False
r["layers"]["node_path"] = False
r["node_path"] = {
    "ok": False,
    "exitCode": 127,
    "errors": ["validate_node_paths.gd missing from worker scripts"],
}
p.write_text(json.dumps(r, indent=2))
PY
else
  echo "run-generation: node-path validation via ${NODE_PATH_SCRIPT}"
  set +e
  timeout "$NODE_PATH_TIMEOUT_SEC" \
    "$GODOT_CMD" --headless --path "$STAGING" --script "$NODE_PATH_SCRIPT" \
    >"$NODE_PATH_LOG" 2>&1
  NODE_PATH_RC=$?
  set -e

  "$PYTHON_CMD" - "$REPORT" "$NODE_PATH_LOG" "$NODE_PATH_RC" <<'PY'
import json, sys, pathlib

report_path = pathlib.Path(sys.argv[1])
log_path = pathlib.Path(sys.argv[2])
rc = int(sys.argv[3])
report = json.loads(report_path.read_text())
log = log_path.read_text(errors="ignore") if log_path.is_file() else ""

errors = []
for line in log.splitlines():
    s = line.strip()
    if s.startswith("NODE_PATH_ERROR:"):
        errors.append(s[len("NODE_PATH_ERROR:") :].strip())
    elif "failed to load" in s or "failed to instantiate" in s or "resource missing" in s:
        errors.append(s)

# timeout(1) returns 124 on expiry; treat any non-zero as failure
ok = rc == 0
report["node_path"] = {
    "ok": ok,
    "exitCode": rc,
    "errors": errors[:50],
    "logTail": "\n".join(log.splitlines()[-40:]),
}
report.setdefault("layers", {})
report["layers"]["node_path"] = ok
if not ok:
    report["ok"] = False
report_path.write_text(json.dumps(report, indent=2))
if ok:
    print("node-path validation: OK")
else:
    print(f"node-path validation: FAILED (exit={rc})", file=sys.stderr)
    for e in errors[:10]:
        print(f"  - {e}", file=sys.stderr)
PY
fi

# Always upload validation report when presigned (success or failure) for operators
if [[ -n "${PRESIGN_VALIDATION_PUT:-}" ]]; then
  pgos_curl_put "$PRESIGN_VALIDATION_PUT" "$REPORT" "application/json"
fi

# Pass report path via argv (not embedded in -c) so MSYS/Git-Bash path conversion works
# with native Windows Python when testing locally.
OK=$(
  "$PYTHON_CMD" - "$REPORT" <<'PY'
import json, sys, pathlib
print(json.loads(pathlib.Path(sys.argv[1]).read_text())["ok"])
PY
)
if [[ "$OK" != "True" ]]; then
  DETAIL=$(
    "$PYTHON_CMD" - "$REPORT" <<'PY'
import json, sys, pathlib

r = json.loads(pathlib.Path(sys.argv[1]).read_text())
parts = []
if not r.get("layers", {}).get("uid", True):
    n = len(r.get("uid_duplicates") or [])
    parts.append(f"uid_duplicates={n}")
np = r.get("node_path") or {}
if np.get("ok") is False:
    rc = np.get("exitCode")
    errs = np.get("errors") or []
    parts.append(f"node_path_exit={rc}")
    if errs:
        parts.append("node_path: " + "; ".join(str(e) for e in errs[:5]))
    elif rc == 124:
        parts.append("node_path: timeout")
if not parts:
    parts.append("validation report ok=false")
print("; ".join(parts)[:900])
PY
  )
  # JSON-escape errorDetail for the PATCH body
  BODY=$(
    DETAIL="$DETAIL" "$PYTHON_CMD" - <<'PY'
import json, os
detail = os.environ.get("DETAIL", "validation failed")
print(json.dumps({
    "status": "VALIDATION_FAILED",
    "errorCode": "E003",
    "errorDetail": detail,
}))
PY
  )
  pgos_patch_job_status "$BODY"
  exit 1
fi

# Upload staging tarball for commit phase
if [[ -n "${PRESIGN_STAGING_ARCHIVE_PUT:-}" ]]; then
  pgos_upload_dir_tarball "$STAGING" "$PRESIGN_STAGING_ARCHIVE_PUT" "/tmp/staging-upload-${JOB_ID}.tar.gz"
fi

pgos_patch_job_status "{\"status\":\"VALIDATION_REPORT\",\"s3StagingPrefix\":\"projects/${PROJECT_ID}/jobs/${JOB_ID}/staging\"}"

echo "Staging and validation complete at $STAGING"
