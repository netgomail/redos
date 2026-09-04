#!/usr/bin/env bash
# redos — установщик для РедОС / RHEL-совместимых дистрибутивов Linux x86_64
# Использование: curl -fsSL https://raw.githubusercontent.com/netgomail/redos/master/install.sh | bash
set -e

REPO="netgomail/redos"
INSTALL_DIR="$HOME/.local/bin"
APP="redos"
BINARY_NAME="redos-linux"

# ── Цвета ────────────────────────────────────────────────────────────────────
CYAN='\033[0;96m'; GREEN='\033[0;92m'; RED='\033[0;91m'
YELLOW='\033[0;93m'; GRAY='\033[0;90m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

# Маркеры те же, что у экрана `redos update`, — установка и обновление
# должны выглядеть одинаково.
step()    { echo -e "  ${CYAN}\u203a${NC} $*"; }
ok()      { echo -e "  ${GREEN}${BOLD}\u2713${NC} $*"; }
warn()    { echo -e "  ${YELLOW}!${NC} ${GRAY}$*${NC}"; }
fail()    { echo -e "  ${RED}${BOLD}\u2717${NC} $*" >&2; exit 1; }

# ── Прогресс-бар (тот же, что рисует `redos update`) ──────────────────────────
BAR_W=22
mb()      { awk -v b="${1:-0}" 'BEGIN { printf "%.1f", b / 1048576 }'; }
draw_bar() {
  local recv=$1 total=$2 filled=0 pct=0 f='' e=''
  if [ "$total" -gt 0 ]; then
    filled=$(( recv * BAR_W / total ))
    pct=$(( recv * 100 / total ))
    [ "$filled" -gt "$BAR_W" ] && filled=$BAR_W
    [ "$pct" -gt 100 ] && pct=100
  fi
  [ "$filled" -gt 0 ]              && f=$(printf '\u2588%.0s' $(seq 1 "$filled"))
  [ "$filled" -lt "$BAR_W" ]       && e=$(printf '\u2591%.0s' $(seq 1 $(( BAR_W - filled ))))
  printf "\r  ${CYAN}\u203a${NC} Скачиваю ${DIM}[${NC}${GREEN}%s${GRAY}%s${DIM}]${NC} ${BOLD}%3d%%${NC} ${DIM}(%s / %s MB)${NC}   " \
         "$f" "$e" "$pct" "$(mb "$recv")" "$(mb "$total")"
}

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

# Размер узнаём заранее, чтобы рисовать тот же бар, что и `redos update`.
# -L обязателен: GitHub отдаёт 302 на облако, content-length только в конце цепочки.
TOTAL=$(curl -fsSLI "$DOWNLOAD_URL" 2>/dev/null \
        | tr -d '\r' | awk 'tolower($1) == "content-length:" { v = $2 } END { print v + 0 }')

if [ "${TOTAL:-0}" -gt 0 ]; then
  curl -fsSL "$DOWNLOAD_URL" -o "$TMP" &
  CURL_PID=$!
  # curl пишет в файл потоком, поэтому размер файла и есть скачанный объём
  while kill -0 "$CURL_PID" 2>/dev/null; do
    draw_bar "$(stat -c %s "$TMP" 2>/dev/null || echo 0)" "$TOTAL"
    sleep 0.2
  done
  if ! wait "$CURL_PID"; then
    echo ""
    fail "Не удалось скачать: $DOWNLOAD_URL"
  fi
  draw_bar "$TOTAL" "$TOTAL"
  echo ""
  echo ""
else
  # Размер неизвестен — показываем штатный бар curl, без него было бы молчание
  step "Скачиваю ${BINARY_NAME}..."
  curl -fsSL --progress-bar "$DOWNLOAD_URL" -o "$TMP" \
    || fail "Не удалось скачать: $DOWNLOAD_URL"
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
echo -e "  ${GREEN}${BOLD}\u2713${NC} ${BOLD}Готово!${NC}  Запустите: ${CYAN}${APP}${NC}"
echo ""
