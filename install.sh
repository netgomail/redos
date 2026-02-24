#!/usr/bin/env bash
# МойКод — установщик для Linux и macOS
# Использование: curl -fsSL https://raw.githubusercontent.com/YOURNAME/mycode/main/install.sh | bash
set -e

REPO="netgomail/mycode"
VERSION="0.1.0"
INSTALL_DIR="$HOME/.local/bin"
APP="mycode"

# ── Цвета ────────────────────────────────────────────────────────────────────
CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'
YELLOW='\033[0;33m'; GRAY='\033[0;90m'; BOLD='\033[1m'; NC='\033[0m'

step()    { echo -e "  ${CYAN}>${NC}  $*"; }
ok()      { echo -e "  ${GREEN}v${NC}  $*"; }
warn()    { echo -e "  ${YELLOW}!${NC}  ${GRAY}$*${NC}"; }
fail()    { echo -e "  ${RED}X${NC}  $*" >&2; exit 1; }

echo ""
echo -e "  ${CYAN}+--------------------------------------------------+${NC}"
echo -e "  ${CYAN}|${NC}  ${BOLD}MyCode${NC} Installer  ${GRAY}v${VERSION}${NC}"
echo -e "  ${CYAN}|${NC}  ${GRAY}https://github.com/${REPO}${NC}"
echo -e "  ${CYAN}+--------------------------------------------------+${NC}"
echo ""

# ── Определяем платформу ─────────────────────────────────────────────────────
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Linux*)  PLATFORM="linux" ;;
  Darwin*) PLATFORM="mac"   ;;
  *)       fail "Unsupported OS: $OS" ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH_SUFFIX="" ;;       # linux -> mycode-linux, mac -> mycode-mac-x64
  arm64|aarch64)
    if [ "$PLATFORM" = "mac" ]; then
      ARCH_SUFFIX="-arm"
    else
      fail "Linux ARM64 not yet supported"
    fi ;;
  *) fail "Unsupported architecture: $ARCH" ;;
esac

if [ "$PLATFORM" = "linux" ]; then
  BINARY_NAME="mycode-linux"
elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  BINARY_NAME="mycode-mac-arm"
else
  BINARY_NAME="mycode-mac-x64"
fi

step "Platform: ${PLATFORM} / ${ARCH}"

# ── Проверяем зависимости ────────────────────────────────────────────────────
command -v curl &>/dev/null || fail "curl is required but not installed"

# ── Создаём папку ────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
step "Install directory: $INSTALL_DIR"

# ── Скачиваем бинарник ───────────────────────────────────────────────────────
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${BINARY_NAME}"
TMP="$(mktemp)"
step "Downloading ${BINARY_NAME}..."
if ! curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$TMP"; then
  fail "Download failed: $DOWNLOAD_URL"
fi

# ── Устанавливаем ────────────────────────────────────────────────────────────
chmod +x "$TMP"
mv "$TMP" "${INSTALL_DIR}/${APP}"
ok "Installed: ${INSTALL_DIR}/${APP}"

# ── Добавляем в PATH (если нужно) ─────────────────────────────────────────────
if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
  SHELL_RC=""
  if [ -f "$HOME/.zshrc" ];  then SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
  fi

  if [ -n "$SHELL_RC" ]; then
    echo '' >> "$SHELL_RC"
    echo '# MyCode' >> "$SHELL_RC"
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$SHELL_RC"
    ok "Added to PATH in $SHELL_RC"
    warn "Run: source $SHELL_RC  (or restart your terminal)"
  else
    warn "Add to your shell config: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
else
  ok "PATH already includes $INSTALL_DIR"
fi

echo ""
echo -e "  ${GREEN}${BOLD}Done!${NC}  Type ${CYAN}${APP}${NC} to start"
echo ""
