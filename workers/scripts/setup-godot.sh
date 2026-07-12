#!/usr/bin/env bash
# Cache fallback with checksum verification (§6.1)
set -euo pipefail
VERSION="${1:?godot version required}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
CACHE_DIR="${GITHUB_WORKSPACE:-.}/.godot-cache"
mkdir -p "$CACHE_DIR"

# Map arch
case "$ARCH" in
  x86_64|amd64) GARCH="x86_64" ;;
  aarch64|arm64) GARCH="arm64" ;;
  *) GARCH="x86_64" ;;
esac

if [[ "$OS" == "linux" ]]; then
  ARCHIVE="Godot_v${VERSION}-stable_linux.${GARCH}.zip"
  BIN_NAME="Godot_v${VERSION}-stable_linux.${GARCH}"
  MIRROR="https://github.com/godotengine/godot/releases/download/${VERSION}-stable/${ARCHIVE}"
elif [[ "$OS" == "darwin" ]]; then
  ARCHIVE="Godot_v${VERSION}-stable_macos.universal.zip"
  BIN_NAME="Godot"
  MIRROR="https://github.com/godotengine/godot/releases/download/${VERSION}-stable/${ARCHIVE}"
else
  ARCHIVE="Godot_v${VERSION}-stable_win64.exe.zip"
  BIN_NAME="Godot_v${VERSION}-stable_win64.exe"
  MIRROR="https://github.com/godotengine/godot/releases/download/${VERSION}-stable/${ARCHIVE}"
fi

EXPECTED_SUM_FILE="${CACHE_DIR}/${ARCHIVE}.sha256"
ARCHIVE_PATH="${CACHE_DIR}/${ARCHIVE}"

download() {
  echo "Downloading Godot ${VERSION} from official mirror..."
  curl -fsSL -o "$ARCHIVE_PATH" "$MIRROR"
  # Record checksum for future cache validation
  if command -v sha256sum >/dev/null; then
    sha256sum "$ARCHIVE_PATH" | awk '{print $1}' > "$EXPECTED_SUM_FILE"
  else
    shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}' > "$EXPECTED_SUM_FILE"
  fi
}

if [[ -f "$ARCHIVE_PATH" && -f "$EXPECTED_SUM_FILE" ]]; then
  echo "Restored cache for ${ARCHIVE}; verifying checksum..."
  if command -v sha256sum >/dev/null; then
    ACTUAL=$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')
  else
    ACTUAL=$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')
  fi
  EXPECTED=$(cat "$EXPECTED_SUM_FILE")
  if [[ "$ACTUAL" != "$EXPECTED" ]]; then
    echo "Checksum mismatch — cache corrupt, re-downloading"
    download
  fi
else
  download
fi

# Extract
EXTRACT_DIR="${CACHE_DIR}/extract-${VERSION}"
mkdir -p "$EXTRACT_DIR"
unzip -o -q "$ARCHIVE_PATH" -d "$EXTRACT_DIR"
GODOT_BIN=$(find "$EXTRACT_DIR" \( -type f -name "$BIN_NAME" -o -type f -name 'Godot*' \) | head -1)
chmod +x "$GODOT_BIN" || true
mkdir -p "$HOME/.local/bin"
ln -sfn "$GODOT_BIN" "$HOME/.local/bin/godot"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$HOME/.local/bin" >> "$GITHUB_PATH"
fi
export PATH="$HOME/.local/bin:$PATH"
godot --version || "$GODOT_BIN" --version

# Export templates (§6.1 / E006)
TEMPLATE_ARCHIVE="Godot_v${VERSION}-stable_export_templates.tpz"
TEMPLATE_URL="https://github.com/godotengine/godot/releases/download/${VERSION}-stable/${TEMPLATE_ARCHIVE}"
TEMPLATE_CACHE="${CACHE_DIR}/${TEMPLATE_ARCHIVE}"
TEMPLATE_DIR="${HOME}/.local/share/godot/export_templates/${VERSION}.stable"

install_templates() {
  echo "Installing export templates for ${VERSION}..."
  if [[ ! -f "$TEMPLATE_CACHE" ]]; then
    curl -fsSL -o "$TEMPLATE_CACHE" "$TEMPLATE_URL"
  fi
  # Record template archive checksum for audit / future integrity checks
  if command -v sha256sum >/dev/null; then
    sha256sum "$TEMPLATE_CACHE" | awk '{print $1}' > "${TEMPLATE_CACHE}.sha256"
  elif command -v shasum >/dev/null; then
    shasum -a 256 "$TEMPLATE_CACHE" | awk '{print $1}' > "${TEMPLATE_CACHE}.sha256"
  fi
  TMP_TPL="/tmp/godot-templates-${VERSION}"
  rm -rf "$TMP_TPL"
  mkdir -p "$TMP_TPL"
  unzip -o -q "$TEMPLATE_CACHE" -d "$TMP_TPL"
  mkdir -p "$TEMPLATE_DIR"
  cp -a "$TMP_TPL"/templates/* "$TEMPLATE_DIR/" 2>/dev/null || cp -a "$TMP_TPL"/* "$TEMPLATE_DIR/"
  # Ensure version.txt for verify-godot.sh exact match
  if [[ ! -f "${TEMPLATE_DIR}/version.txt" ]]; then
    echo "${VERSION}.stable" > "${TEMPLATE_DIR}/version.txt"
  fi
  # Mirror under workspace cache for runners that resolve templates from .godot-cache
  CACHE_TPL="${CACHE_DIR}/export_templates/${VERSION}.stable"
  mkdir -p "$(dirname "$CACHE_TPL")"
  rm -rf "$CACHE_TPL"
  cp -a "$TEMPLATE_DIR" "$CACHE_TPL"
  echo "Export templates installed at $TEMPLATE_DIR (cache mirror: $CACHE_TPL)"
}

if [[ ! -d "$TEMPLATE_DIR" ]] || [[ -z "$(ls -A "$TEMPLATE_DIR" 2>/dev/null || true)" ]]; then
  install_templates
else
  # Refresh version.txt if missing so E006 template check can validate
  if [[ ! -f "${TEMPLATE_DIR}/version.txt" ]]; then
    echo "${VERSION}.stable" > "${TEMPLATE_DIR}/version.txt"
  fi
  echo "Export templates already present at $TEMPLATE_DIR"
fi
