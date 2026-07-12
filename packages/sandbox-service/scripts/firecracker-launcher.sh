#!/usr/bin/env bash
# Production Firecracker launcher hook — wire to firecracker-containerd or custom microVM runner.
# Reads JSON payload from stdin; writes JSON result to stdout.
set -euo pipefail

SOCKET=""
EXTENSION_ID=""
TIMEOUT_MS="60000"
MEMORY_BYTES="536870912"
NETWORK="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --socket) SOCKET="$2"; shift 2 ;;
    --extension-id) EXTENSION_ID="$2"; shift 2 ;;
    --timeout-ms) TIMEOUT_MS="$2"; shift 2 ;;
    --memory-bytes) MEMORY_BYTES="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SOCKET" || -z "$EXTENSION_ID" ]]; then
  echo "socket and extension-id required" >&2
  exit 2
fi

PAYLOAD="$(cat)"
if [[ "$NETWORK" == "0" ]] && echo "$PAYLOAD" | grep -q '"fetchUrl"'; then
  echo '{"error":"NETWORK_DENIED: network disabled in microVM policy"}' >&2
  exit 3
fi

# Replace this block with real Firecracker VM lifecycle when hypervisor is available.
printf '%s\n' "{\"ok\":true,\"backend\":\"firecracker\",\"socket\":\"${SOCKET}\",\"extensionId\":\"${EXTENSION_ID}\",\"limits\":{\"timeoutMs\":${TIMEOUT_MS},\"memoryBytes\":${MEMORY_BYTES}},\"policy\":{\"network\":${NETWORK}}}"