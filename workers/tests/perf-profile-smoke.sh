#!/usr/bin/env bash
# M-12 / L-07: perf-profile measures real memory (not hardcoded 64); portable timestamps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/workers/scripts/perf-profile.sh"
OUT="$(mktemp -d)"
STUB_DIR="$(mktemp -d)"
export OUT_DIR="$OUT"

cleanup() {
  rm -rf "$OUT" "$STUB_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Static guards
# ---------------------------------------------------------------------------
if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL: perf-profile.sh missing" >&2
  exit 1
fi

# M-12: must not hardcode the placeholder mem value into mem_mib.txt
if grep -nE 'echo[[:space:]]+"64"[[:space:]]*>.*mem_mib' "$SCRIPT"; then
  echo "FAIL: perf-profile.sh still hardcodes mem_mib=64 (M-12)" >&2
  exit 1
fi
if grep -nE "echo[[:space:]]+'64'[[:space:]]*>.*mem_mib" "$SCRIPT"; then
  echo "FAIL: perf-profile.sh still hardcodes mem_mib=64 (M-12)" >&2
  exit 1
fi

# Must implement a real measurement path
if ! grep -qE '%M|Maximum resident set size|rss-sample|mem_rss_kb' "$SCRIPT"; then
  echo "FAIL: perf-profile.sh has no peak-RSS / GNU time measurement plumbing" >&2
  exit 1
fi

# L-07: portable Date.now(), no GNU-only date millis
if grep -nE '^[^#]*date[[:space:]]+\+%s%3N' "$SCRIPT"; then
  echo "FAIL: perf-profile.sh still uses date +%s%3N (L-07)" >&2
  exit 1
fi
if ! grep -q 'Date.now()' "$SCRIPT"; then
  echo "FAIL: perf-profile.sh missing portable Date.now() timestamp (L-07)" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node required for now_ms()" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Functional path A: mock GNU time (%e %M) + mock godot — primary M-12 path
# ---------------------------------------------------------------------------
cat >"${STUB_DIR}/godot" <<'EOF'
#!/usr/bin/env bash
# Simulate work; metrics come from PERF_TIME_BIN mock below
sleep 0.2
exit 0
EOF
chmod +x "${STUB_DIR}/godot"

# Mock GNU /usr/bin/time: honor -f '%e %M' -o FILE and run the remaining command
cat >"${STUB_DIR}/mock-time" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out=""
fmt=""
verbose=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f)
      fmt="${2:-}"
      shift 2
      ;;
    -o)
      out="${2:-}"
      shift 2
      ;;
    -v|--verbose)
      verbose=1
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      # ignore unknown flags
      shift
      ;;
    *)
      break
      ;;
  esac
done

start_ms="$(node -e "console.log(Date.now())")"
set +e
"$@"
rc=$?
set -e
end_ms="$(node -e "console.log(Date.now())")"
elapsed="$(node -e "const a=Number(process.argv[1]),b=Number(process.argv[2]); process.stdout.write(((b-a)/1000).toFixed(3))" "$start_ms" "$end_ms")"
# Deterministic non-placeholder peak RSS: 98304 KB = 96 MiB
max_kb=98304

if [[ "$verbose" -eq 1 ]]; then
  body=$(
    cat <<V
	Command being timed: "$@"
	User time (seconds): 0.10
	System time (seconds): 0.05
	Elapsed (wall clock) time (h:mm:ss or m:ss): 0:${elapsed}
	Maximum resident set size (kbytes): ${max_kb}
V
  )
  if [[ -n "$out" ]]; then
    printf '%s\n' "$body" >"$out"
  else
    printf '%s\n' "$body" >&2
  fi
elif [[ -n "$out" ]]; then
  # Default primary format used by perf-profile
  if [[ "$fmt" == "%e %M" || -z "$fmt" ]]; then
    printf '%s %s\n' "$elapsed" "$max_kb" >"$out"
  else
    printf '%s %s\n' "$elapsed" "$max_kb" >"$out"
  fi
fi
exit "$rc"
EOF
chmod +x "${STUB_DIR}/mock-time"

export PATH="${STUB_DIR}:${PATH}"
export GODOT_BIN="${STUB_DIR}/godot"
export PERF_TIME_BIN="${STUB_DIR}/mock-time"

rm -rf "$OUT"
mkdir -p "$OUT"

set +e
bash "$SCRIPT"
RC=$?
set -e

if [[ "$RC" -ne 0 ]]; then
  echo "FAIL: perf-profile.sh exited ${RC} (gnu-time path)" >&2
  ls -la "$OUT" >&2 || true
  exit 1
fi

for f in wall_ms.txt cpu_sec.txt mem_mib.txt mem_method.txt mem_rss_kb.txt; do
  if [[ ! -f "$OUT/$f" ]]; then
    echo "FAIL: missing artifact $f" >&2
    ls -la "$OUT" >&2 || true
    exit 1
  fi
done

WALL="$(tr -d '[:space:]' <"$OUT/wall_ms.txt")"
MEM="$(tr -d '[:space:]' <"$OUT/mem_mib.txt")"
METHOD="$(tr -d '[:space:]' <"$OUT/mem_method.txt")"
KB="$(tr -d '[:space:]' <"$OUT/mem_rss_kb.txt")"

if ! [[ "$WALL" =~ ^[0-9]+$ ]]; then
  echo "FAIL: wall_ms not an integer: ${WALL}" >&2
  exit 1
fi
if ! [[ "$MEM" =~ ^[0-9]+$ ]]; then
  echo "FAIL: mem_mib not an integer: ${MEM}" >&2
  exit 1
fi
if [[ "$METHOD" != "gnu-time-%M" ]]; then
  echo "FAIL: expected mem_method=gnu-time-%M got ${METHOD}" >&2
  cat "$OUT/time_raw.txt" 2>/dev/null || true
  exit 1
fi
if [[ "$KB" != "98304" ]]; then
  echo "FAIL: expected mem_rss_kb=98304 from mock time, got ${KB}" >&2
  cat "$OUT/time_raw.txt" 2>/dev/null || true
  exit 1
fi
# 98304 KB → 96 MiB
if [[ "$MEM" != "96" ]]; then
  echo "FAIL: expected mem_mib=96 (98304/1024), got ${MEM}" >&2
  exit 1
fi
# Explicit: must not be the old hardcoded placeholder
if [[ "$MEM" == "64" && "$KB" == "64" ]]; then
  echo "FAIL: mem still looks like placeholder 64" >&2
  exit 1
fi

echo "perf-profile-smoke: gnu-time path OK wall_ms=${WALL} mem_mib=${MEM} method=${METHOD} rss_kb=${KB}"

# ---------------------------------------------------------------------------
# Functional path B: no TIME_BIN → RSS sampler still writes integer mem_mib
# ---------------------------------------------------------------------------
OUT_B="$(mktemp -d)"
export OUT_DIR="$OUT_B"
export PERF_TIME_BIN="${STUB_DIR}/does-not-exist-time"

# Longer-lived mock so sampling has a chance (Linux CI); on Windows may still be 0
cat >"${STUB_DIR}/godot" <<'EOF'
#!/usr/bin/env bash
sleep 0.4
exit 0
EOF
chmod +x "${STUB_DIR}/godot"

set +e
bash "$SCRIPT"
RC_B=$?
set -e

if [[ "$RC_B" -ne 0 ]]; then
  echo "FAIL: perf-profile.sh exited ${RC_B} (rss-sample path)" >&2
  ls -la "$OUT_B" >&2 || true
  rm -rf "$OUT_B"
  exit 1
fi

METHOD_B="$(tr -d '[:space:]' <"$OUT_B/mem_method.txt")"
MEM_B="$(tr -d '[:space:]' <"$OUT_B/mem_mib.txt")"
if [[ "$METHOD_B" != "rss-sample" ]]; then
  echo "FAIL: expected rss-sample when TIME_BIN missing, got ${METHOD_B}" >&2
  rm -rf "$OUT_B"
  exit 1
fi
if ! [[ "$MEM_B" =~ ^[0-9]+$ ]]; then
  echo "FAIL: rss-sample mem_mib not integer: ${MEM_B}" >&2
  rm -rf "$OUT_B"
  exit 1
fi

rm -rf "$OUT_B"
echo "perf-profile-smoke: rss-sample path OK method=${METHOD_B} mem_mib=${MEM_B}"
echo "perf-profile-smoke: ALL OK"
