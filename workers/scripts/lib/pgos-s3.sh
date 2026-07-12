#!/usr/bin/env bash
# S3 presigned URL helpers for worker pipeline (§2.1)
set -euo pipefail

pgos_curl_put() {
  local url="$1"
  local file="$2"
  local content_type="${3:-application/octet-stream}"
  curl -sS -f -X PUT "$url" \
    -H "Content-Type: ${content_type}" \
    --data-binary @"$file"
}

pgos_curl_get() {
  local url="$1"
  local dest="$2"
  local code
  code=$(curl -sS -o "$dest" -w '%{http_code}' "$url" || echo "000")
  echo "$code"
}

pgos_upload_dir_tarball() {
  local dir="$1"
  local url="$2"
  local archive="$3"
  tar -C "$dir" -czf "$archive" .
  pgos_curl_put "$url" "$archive" "application/gzip"
}

# Upload an existing file to a presigned PUT URL (C-03 target snapshot archive).
pgos_upload_file() {
  local file="$1"
  local url="$2"
  local content_type="${3:-application/gzip}"
  if [[ -z "$file" || -z "$url" ]]; then
    echo "pgos_upload_file: file and url required" >&2
    return 1
  fi
  if [[ ! -f "$file" ]]; then
    echo "pgos_upload_file: missing file: $file" >&2
    return 1
  fi
  pgos_curl_put "$url" "$file" "$content_type"
}

pgos_download_and_extract() {
  local url="$1"
  local dest_dir="$2"
  local archive="$3"
  local code
  code=$(pgos_curl_get "$url" "$archive")
  if [[ "$code" == "200" ]]; then
    mkdir -p "$dest_dir"
    tar -xzf "$archive" -C "$dest_dir"
    return 0
  fi
  return 1
}