#!/usr/bin/env bash
# DEP-04: one-command install of pgos-target-provisioner on a Godot target host.
# Mirrors packages/commit-agent/scripts/install.sh (DEP-02).
#
# Usage:
#   sudo bash packages/target-provisioner/scripts/install.sh
#   PROVISIONER_BIN=/opt/pgos/bin/pgos-target-provisioner sudo -E bash packages/target-provisioner/scripts/install.sh
#
# Env:
#   PROVISIONER_BIN   Install path for the binary (default: /usr/local/bin/pgos-target-provisioner)
#   SKIP_BUILD=1      Skip go build (copy existing bin/pgos-target-provisioner if present)
#   INSTALL_SYSTEMD=1 Install + enable systemd unit (default: 0 — print path only)
#   ENV_FILE          Path for EnvironmentFile (default: /etc/pgos/target-provisioner.env)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROVISIONER_BIN="${PROVISIONER_BIN:-/usr/local/bin/pgos-target-provisioner}"
ENV_FILE="${ENV_FILE:-/etc/pgos/target-provisioner.env}"

echo "pgos target-provisioner install (DEP-04)"
echo "  binary: ${PROVISIONER_BIN}"

BIN_DIR="$(dirname "${PROVISIONER_BIN}")"
mkdir -p "${BIN_DIR}"

BUILD_OUT="${PKG_ROOT}/bin/pgos-target-provisioner"
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  if ! command -v go >/dev/null 2>&1; then
    echo "ERROR: go toolchain required (or set SKIP_BUILD=1 with a prebuilt binary)" >&2
    echo "  CI artifact: target-provisioner-linux-amd64 from GitHub Actions (DEP-04)" >&2
    exit 1
  fi
  mkdir -p "${PKG_ROOT}/bin"
  echo "Building ./cmd/provisioner → ${BUILD_OUT}"
  (cd "${PKG_ROOT}" && go build -o "${BUILD_OUT}" ./cmd/provisioner)
elif [[ ! -f "${BUILD_OUT}" ]]; then
  echo "ERROR: SKIP_BUILD=1 but ${BUILD_OUT} missing" >&2
  echo "  Place CI artifact at ${BUILD_OUT} or set PROVISIONER_BIN after manual copy" >&2
  exit 1
fi

install -m 0755 "${BUILD_OUT}" "${PROVISIONER_BIN}"

# Runtime dirs for authorized_keys fragments + ledger
mkdir -p /etc/ssh/pgos-authorized-keys.d /var/lib/pgos /etc/pgos
chmod 0700 /etc/ssh/pgos-authorized-keys.d 2>/dev/null || true
chmod 0755 /var/lib/pgos 2>/dev/null || true

if [[ ! -f "${ENV_FILE}" ]]; then
  cat >"${ENV_FILE}" <<'EOF'
# PGOS target-provisioner (DEP-01 / SEC-02)
# Must match orchestrator PGOS_PROVISION_TOKEN — do not reuse SANDBOX_INTERNAL_TOKEN.
PGOS_PROVISION_TOKEN=change-me
AUTHORIZED_KEYS_DIR=/etc/ssh/pgos-authorized-keys.d
PGOS_KEYS_LEDGER=/var/lib/pgos/keys-ledger.json
PGOS_PROVISION_LISTEN=127.0.0.1:9071
# Optional SEC-01 TLS:
# PGOS_PROVISION_TLS_CERT=/etc/pgos/provision-server.crt
# PGOS_PROVISION_TLS_KEY=/etc/pgos/provision-server.key
# PGOS_PROVISION_TLS_CLIENT_CA=/etc/pgos/provision-client-ca.crt
EOF
  chmod 0600 "${ENV_FILE}"
  echo "  wrote: ${ENV_FILE} (edit PGOS_PROVISION_TOKEN before starting)"
else
  echo "  keep:  ${ENV_FILE} (already exists)"
fi

UNIT_SRC="${PKG_ROOT}/systemd/pgos-target-provisioner.service"
if [[ -f "${UNIT_SRC}" ]]; then
  if [[ "${INSTALL_SYSTEMD:-0}" == "1" ]]; then
    install -m 0644 "${UNIT_SRC}" /etc/systemd/system/pgos-target-provisioner.service
    # Ensure EnvironmentFile is used when we created the default env
    if ! grep -q 'EnvironmentFile=-/etc/pgos/target-provisioner.env' /etc/systemd/system/pgos-target-provisioner.service; then
      # Unit already documents EnvironmentFile as a comment; leave as-is
      :
    fi
    # Point ExecStart at installed binary if non-default
    if [[ "${PROVISIONER_BIN}" != "/usr/local/bin/pgos-target-provisioner" ]]; then
      sed -i "s|^ExecStart=.*|ExecStart=${PROVISIONER_BIN}|" /etc/systemd/system/pgos-target-provisioner.service
    fi
    systemctl daemon-reload
    systemctl enable --now pgos-target-provisioner
    echo "  systemd: enabled pgos-target-provisioner"
  else
    echo "  systemd unit: ${UNIT_SRC}"
    echo "  install with: INSTALL_SYSTEMD=1 $0"
    echo "  or: install -m 0644 ${UNIT_SRC} /etc/systemd/system/ && systemctl enable --now pgos-target-provisioner"
  fi
fi

echo "Installed:"
echo "  ${PROVISIONER_BIN}"
echo "Verify: curl -sS http://127.0.0.1:9071/health"
echo "CI artifact: download target-provisioner-linux-amd64 → ${PROVISIONER_BIN}"
echo "  SKIP_BUILD=1 with prebuilt bin/pgos-target-provisioner also works"
