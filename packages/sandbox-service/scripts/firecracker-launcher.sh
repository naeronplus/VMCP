#!/usr/bin/env bash
# Firecracker microVM launcher hook.
# FIRECRACKER_LAUNCHER_MODE=stub|real (default stub in dev).
# Production must use mode=real with a real hypervisor integration (fail-closed gate in Node).
set -euo pipefail

MODE="${FIRECRACKER_LAUNCHER_MODE:-stub}"
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

if [[ "$MODE" == "stub" ]]; then
  # Identifiable stub — monitors must NOT treat this as production Firecracker.
  printf '%s\n' "{\"ok\":true,\"backend\":\"firecracker-stub\",\"socket\":\"${SOCKET}\",\"extensionId\":\"${EXTENSION_ID}\",\"limits\":{\"timeoutMs\":${TIMEOUT_MS},\"memoryBytes\":${MEMORY_BYTES}},\"policy\":{\"network\":${NETWORK}}}"
  exit 0
fi

# Real mode: integrate firecracker-containerd / custom microVM spawn here.
# Until wired, fail closed so production health cannot claim success.
echo '{"error":"FIRECRACKER_REAL_NOT_WIRED: implement microVM spawn for FIRECRACKER_LAUNCHER_MODE=real"}' >&2
exit 4
