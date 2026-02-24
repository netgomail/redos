# МойКод

> Консольный AI-ассистент для разработки — учебный проект с дизайном, вдохновлённым [Claude Code](https://claude.ai/code).

---

## Запуск

### Скомпилированный бинарник (Windows)

```cmd
dist\mycode.exe
```

> Бинарник самодостаточный — Node.js устанавливать не нужно.

### Из исходников (нужен Bun или Node.js)

```bash
# Через Bun (рекомендуется)
bun src/app.jsx

# Через Node.js
npm install
node src/app.jsx   # или: npx tsx src/app.jsx
```

---

## Установка

### Linux / macOS

```bash
curl -fsSL https://yourhost/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://yourhost/install.ps1 | iex
```

---

## Сборка бинарников

Требуется [Bun](https://bun.sh) ≥ 1.1.

```bash
# Windows (использует bunbuild.mjs с плагинами)
bun run build:win    # → dist/mycode.exe

# Linux x64
bun run build:linux  # → dist/mycode

# macOS x64
bun run build:mac    # → dist/mycode-mac
```

> **Почему Bun, а не pkg?**
> `pkg` не поддерживает ESM и WebAssembly. Bun корректно компилирует ink + yoga-wasm-web в единый standalone-бинарник.

---

## Команды

| Команда | Описание |
|---|---|
| `/help` | Список всех команд |
| `/model` | Информация о текущей модели |
| `/status` | Статус сессии: аптайм, ОС, рабочая папка |
| `/files [путь]` | Листинг файлов в директории |
| `/run <команда>` | Выполнить команду (заглушка) |
| `/config` | Настройки приложения (заглушка) |
| `/version` | Версия приложения |
| `/clear` | Очистить экран |
| `/exit` / `/quit` | Завершить работу |

Любой текст без `/` — запрос к AI (спиннер + stub-ответ).

---

## Структура проекта

```
mycode/
├── src/
│   └── app.jsx          — исходник (React + Ink)
├── dist/
│   └── mycode.exe       — скомпилированный бинарник Windows (~110 МБ)
├── bunbuild.mjs         — скрипт сборки с Bun-плагинами
├── install.sh           — установщик Linux/macOS
├── install.ps1          — установщик Windows
└── package.json
```

---

## Стек

| Технология | Роль |
|---|---|
| [React](https://react.dev) 18 | Компонентный UI |
| [Ink](https://github.com/vadimdemedes/ink) 4 | Рендеринг React в терминале |
| [yoga-wasm-web](https://github.com/nicolo-ribaudo/yoga-wasm-web) | Flexbox-движок для Ink (WASM) |
| [Bun](https://bun.sh) | Runtime + компилятор в бинарник |

---

## Лицензия

MIT
