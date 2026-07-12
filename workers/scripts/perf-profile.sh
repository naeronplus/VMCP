#!/usr/bin/env bash
# Nightly perf profile — wall time, elapsed, and peak RSS for Godot headless reimport (§11.2)
# M-12: real memory via GNU /usr/bin/time (%M or -v) or peak RSS sampling — never a hardcoded placeholder
# L-07: portable millisecond timestamps via Node (not GNU-only date +%s%3N)
set -euo pipefail

OUT="${OUT_DIR:-perf-out}"
mkdir -p "$OUT"

GODOT_CMD="${GODOT_BIN:-godot}"
# Production default: absolute GNU time. PERF_TIME_BIN overrides for tests/smoke.
TIME_BIN="${PERF_TIME_BIN:-/usr/bin/time}"

# Portable epoch-ms (works on macOS, Alpine, Ubuntu; requires node on PATH)
now_ms() {
  node -e "console.log(Date.now())"
}

# Convert kilobytes → whole MiB (rounded). Empty/invalid → 0.
kb_to_mib() {
  local kb="${1:-}"
  kb="$(echo "$kb" | tr -d '[:space:]')"
  if [[ -z "$kb" || ! "$kb" =~ ^[0-9]+$ ]]; then
    echo "0"
    return 0
  fi
  echo $(( (kb + 512) / 1024 ))
}

# True if TIME_BIN is GNU-compatible time and accepts -f '%e %M'
gnu_time_format_ok() {
  [[ -n "$TIME_BIN" && -x "$TIME_BIN" ]] || return 1
  local probe
  probe="$(mktemp)"
  # GNU time writes the format line to -o; BSD/other may error or ignore %M
  if ! "$TIME_BIN" -f '%e %M' -o "$probe" true >/dev/null 2>&1; then
    rm -f "$probe"
    return 1
  fi
  # Expect two fields: elapsed and integer KB
  if ! awk 'NF >= 2 && $2 ~ /^[0-9]+$/ { ok=1 } END { exit ok ? 0 : 1 }' "$probe"; then
    rm -f "$probe"
    return 1
  fi
  rm -f "$probe"
  return 0
}

# Parse "Maximum resident set size (kbytes): N" from GNU time -v
parse_max_rss_kb_from_verbose() {
  local file="$1"
  sed -n 's/.*Maximum resident set size (kbytes):[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$file" | head -1
}

# Parse elapsed seconds from GNU time -v "Elapsed (wall clock) time (...): …"
parse_elapsed_from_verbose() {
  local file="$1"
  local raw
  raw="$(sed -n 's/.*Elapsed (wall clock) time ([^)]*):[[:space:]]*//p' "$file" | head -1 | tr -d '[:space:]')"
  if [[ -z "$raw" ]]; then
    echo ""
    return 0
  fi
  # Forms: 0:01.23  or  1:02:03.45  or  12.34
  node -e '
const s = process.argv[1];
const parts = s.split(":").map(Number);
let sec;
if (parts.some((n) => Number.isNaN(n))) process.exit(2);
if (parts.length === 1) sec = parts[0];
else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
else if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
else process.exit(2);
process.stdout.write(String(sec));
' "$raw" 2>/dev/null || echo ""
}

# Sample RSS (KB) for pid and its direct children; update peak_kb name-ref via echo max.
sample_peak_rss_kb() {
  local pid="$1"
  local peak="${2:-0}"
  local sample rss
  sample="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$sample" =~ ^[0-9]+$ ]] && [[ "$sample" -gt "$peak" ]]; then
    peak="$sample"
  fi
  # GNU ps supports --ppid; ignore failure on BSD/macOS
  while read -r rss; do
    rss="$(echo "$rss" | tr -d '[:space:]')"
    if [[ "$rss" =~ ^[0-9]+$ ]] && [[ "$rss" -gt "$peak" ]]; then
      peak="$rss"
    fi
  done < <(ps --ppid "$pid" -o rss= 2>/dev/null || true)
  echo "$peak"
}

# Run command with peak RSS sampling. Stdout/stderr of command → logs under $OUT.
# Prints: "<exit_code> <peak_rss_kb> <elapsed_sec>"
run_with_rss_sampling() {
  local peak_kb=0
  local pid rc start_ms end_ms elapsed
  start_ms="$(now_ms)"
  set +e
  "$@" >"$OUT/godot_stdout.log" 2>"$OUT/godot_stderr.log" &
  pid=$!
  # First sample immediately (short-lived processes)
  peak_kb="$(sample_peak_rss_kb "$pid" "$peak_kb")"
  while kill -0 "$pid" 2>/dev/null; do
    peak_kb="$(sample_peak_rss_kb "$pid" "$peak_kb")"
    sleep 0.05
  done
  wait "$pid"
  rc=$?
  set -e
  end_ms="$(now_ms)"
  elapsed="$(node -e "const a=Number(process.argv[1]),b=Number(process.argv[2]); process.stdout.write(((b-a)/1000).toFixed(3))" "$start_ms" "$end_ms")"
  echo "${rc} ${peak_kb} ${elapsed}"
}

write_metrics() {
  local elapsed_sec="$1"
  local max_rss_kb="$2"
  local method="$3"
  local godot_rc="$4"

  # cpu_sec.txt historically holds GNU time %e (wall elapsed seconds), not %U CPU.
  # Keep the artifact name for nightly_perf / operators.
  if [[ -n "$elapsed_sec" ]]; then
    printf '%s\n' "$elapsed_sec" >"$OUT/cpu_sec.txt"
  else
    echo "0" >"$OUT/cpu_sec.txt"
  fi

  kb_to_mib "$max_rss_kb" >"$OUT/mem_mib.txt"
  printf '%s\n' "$method" >"$OUT/mem_method.txt"
  printf '%s\n' "$godot_rc" >"$OUT/godot_exit.txt"
  if [[ -n "$max_rss_kb" && "$max_rss_kb" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$max_rss_kb" >"$OUT/mem_rss_kb.txt"
  else
    echo "0" >"$OUT/mem_rss_kb.txt"
  fi
}

STAGING="$(mktemp -d)"
cleanup() {
  rm -rf "$STAGING"
}
trap cleanup EXIT

mkdir -p "$STAGING/scenes"
cat >"$STAGING/project.godot" <<'EOF'
config_version=5
[application]
config/name="PerfProfile"
EOF
echo '[gd_scene format=3]
[node name="Root" type="Node2D"]' >"$STAGING/scenes/main.tscn"

START="$(now_ms)"
METHOD="none"
ELAPSED_SEC="0"
MAX_RSS_KB="0"
GODOT_RC=127

if ! command -v "$GODOT_CMD" >/dev/null 2>&1 && [[ ! -x "$GODOT_CMD" ]]; then
  echo "perf-profile: godot not found (GODOT_BIN=${GODOT_BIN:-unset}); writing zero metrics" >&2
  METHOD="no-godot"
  GODOT_RC=127
  ELAPSED_SEC="0"
  MAX_RSS_KB="0"
else
  if gnu_time_format_ok; then
    # Primary (M-12): GNU time — %e elapsed seconds, %M maximum resident set size (KB)
    METHOD="gnu-time-%M"
    set +e
    "$TIME_BIN" -f '%e %M' -o "$OUT/time_raw.txt" \
      "$GODOT_CMD" --headless --editor --quit --path "$STAGING" \
      >"$OUT/godot_stdout.log" 2>"$OUT/godot_stderr.log"
    GODOT_RC=$?
    set -e
    # time_raw: "0.42 12345"
    ELAPSED_SEC="$(awk '{print $1; exit}' "$OUT/time_raw.txt" | tr -d '[:space:]')"
    MAX_RSS_KB="$(awk '{print $2; exit}' "$OUT/time_raw.txt" | tr -d '[:space:]')"
  elif [[ -x "$TIME_BIN" ]]; then
    # Secondary: verbose time output
    METHOD="gnu-time-v"
    set +e
    "$TIME_BIN" -v -o "$OUT/time_verbose.txt" \
      "$GODOT_CMD" --headless --editor --quit --path "$STAGING" \
      >"$OUT/godot_stdout.log" 2>"$OUT/godot_stderr.log"
    GODOT_RC=$?
    set -e
    MAX_RSS_KB="$(parse_max_rss_kb_from_verbose "$OUT/time_verbose.txt")"
    ELAPSED_SEC="$(parse_elapsed_from_verbose "$OUT/time_verbose.txt")"
    if [[ -z "$MAX_RSS_KB" || ! "$MAX_RSS_KB" =~ ^[0-9]+$ ]]; then
      echo "perf-profile: time -v RSS unparseable; re-running with RSS sampler" >&2
      METHOD="rss-sample"
      read -r GODOT_RC MAX_RSS_KB ELAPSED_SEC < <(
        run_with_rss_sampling "$GODOT_CMD" --headless --editor --quit --path "$STAGING"
      )
    fi
  else
    # Tertiary: peak RSS sampling when TIME_BIN is absent
    METHOD="rss-sample"
    echo "perf-profile: ${TIME_BIN} unavailable; using peak RSS sampling" >&2
    read -r GODOT_RC MAX_RSS_KB ELAPSED_SEC < <(
      run_with_rss_sampling "$GODOT_CMD" --headless --editor --quit --path "$STAGING"
    )
  fi
fi

END="$(now_ms)"
echo $((END - START)) >"$OUT/wall_ms.txt"

write_metrics "${ELAPSED_SEC:-0}" "${MAX_RSS_KB:-0}" "$METHOD" "${GODOT_RC:-1}"

# Contract: all three primary artifacts always present and numeric where required
for f in wall_ms.txt cpu_sec.txt mem_mib.txt; do
  if [[ ! -f "$OUT/$f" ]]; then
    echo "perf-profile: FATAL missing $OUT/$f" >&2
    exit 1
  fi
done

MEM_MIB="$(tr -d '[:space:]' <"$OUT/mem_mib.txt")"
if [[ ! "$MEM_MIB" =~ ^[0-9]+$ ]]; then
  echo "perf-profile: FATAL mem_mib.txt is not a non-negative integer: ${MEM_MIB}" >&2
  exit 1
fi

# Guard against reintroducing the M-12 placeholder without measurement plumbing
if [[ "$METHOD" == "none" ]]; then
  echo "perf-profile: FATAL mem measurement method unset" >&2
  exit 1
fi

echo "wall_ms=$(cat "$OUT/wall_ms.txt") cpu_sec=$(cat "$OUT/cpu_sec.txt") mem_mib=${MEM_MIB} method=${METHOD} godot_rc=${GODOT_RC}"
