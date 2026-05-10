#!/usr/bin/env bash
# redos — установщик для РедОС / RHEL-совместимых дистрибутивов Linux x86_64
# Использование: curl -fsSL https://raw.githubusercontent.com/netgomail/redos/master/install.sh | bash
set -e

REPO="netgomail/redos"
INSTALL_DIR="$HOME/.local/bin"
APP="redos"
BINARY_NAME="redos-linux"

# ── Цвета ────────────────────────────────────────────────────────────────────
CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'
YELLOW='\033[0;33m'; GRAY='\033[0;90m'; BOLD='\033[1m'; NC='\033[0m'

step()    { echo -e "  ${CYAN}>${NC}  $*"; }
ok()      { echo -e "  ${GREEN}v${NC}  $*"; }
warn()    { echo -e "  ${YELLOW}!${NC}  ${GRAY}$*${NC}"; }
fail()    { echo -e "  ${RED}X${NC}  $*" >&2; exit 1; }

# ── Проверка платформы ───────────────────────────────────────────────────────
OS="$(uname -s)"; ARCH="$(uname -m)"
[ "$OS" = "Linux" ] || fail "Поддерживается только Linux (получено: $OS)"
case "$ARCH" in
  x86_64|amd64) ;;
  *) fail "Поддерживается только x86_64 (получено: $ARCH)" ;;
esac

# ── Получаем последнюю версию из GitHub API ───────────────────────────────────
command -v curl &>/dev/null || fail "Требуется curl"
VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
[ -z "$VERSION" ] && fail "Не удалось получить последнюю версию с GitHub"

echo ""
echo -e "  ${CYAN}+--------------------------------------------------+${NC}"
echo -e "  ${CYAN}|${NC}  ${BOLD}РедОС${NC} Installer  ${GRAY}v${VERSION}${NC}"
echo -e "  ${CYAN}|${NC}  ${GRAY}https://github.com/${REPO}${NC}"
echo -e "  ${CYAN}+--------------------------------------------------+${NC}"
echo ""

step "Платформа: Linux / ${ARCH}"

# ── Создаём папку ────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
step "Каталог установки: $INSTALL_DIR"

# ── Скачиваем бинарник ───────────────────────────────────────────────────────
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${BINARY_NAME}"
TMP="$(mktemp)"
step "Скачиваю ${BINARY_NAME}..."
if ! curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$TMP"; then
  fail "Не удалось скачать: $DOWNLOAD_URL"
fi

# ── Устанавливаем ────────────────────────────────────────────────────────────
chmod +x "$TMP"
mv "$TMP" "${INSTALL_DIR}/${APP}"
ok "Установлено: ${INSTALL_DIR}/${APP}"

# ── Добавляем в PATH (если нужно) ─────────────────────────────────────────────
if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
  SHELL_RC=""
  if [ -f "$HOME/.zshrc" ];  then SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
  fi

  if [ -n "$SHELL_RC" ]; then
    echo '' >> "$SHELL_RC"
    echo '# РедОС' >> "$SHELL_RC"
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$SHELL_RC"
    ok "Добавлено в PATH: $SHELL_RC"
    warn "Выполните: source $SHELL_RC  (или перезапустите терминал)"
  else
    warn "Добавьте в shell-конфиг: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
else
  ok "PATH уже включает $INSTALL_DIR"
fi

echo ""
echo -e "  ${GREEN}${BOLD}Готово!${NC}  Запустите: ${CYAN}${APP}${NC}"
echo ""
