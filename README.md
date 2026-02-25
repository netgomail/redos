# МойКод

> Консольная утилита для работы специалиста по защите информации — учебный проект с дизайном, вдохновлённым [Claude Code](https://claude.ai/code).

---

## Требования

| Способ использования | Требования |
|---|---|
| **Готовый бинарник** (рекомендуется) | Ничего не требуется — файл самодостаточен |
| **Запуск из исходников** | [Bun](https://bun.sh) ≥ 1.1 |
| **Сборка бинарников** | [Bun](https://bun.sh) ≥ 1.1 |

> Node.js **не нужен** — бинарник включает в себя весь runtime.

---

## Установка

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/netgomail/mycode/master/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/netgomail/mycode/master/install.ps1 | iex
```

Установщики автоматически скачивают последнюю версию из GitHub Releases и добавляют `mycode` в PATH.

---

## Обновление

```bash
mycode update
```

---

## Запуск из исходников

Требуется [Bun](https://bun.sh) ≥ 1.1.

```bash
bun install
bun start
```

---

## Сборка бинарников

```bash
bun run build:win    # → dist/mycode.exe        (Windows x64)
bun run build:linux  # → dist/mycode-linux      (Linux x64)
bun run build:mac    # → dist/mycode-mac-x64    (macOS x64)
#                      dist/mycode-mac-arm      (macOS ARM64)
bun run build:all    # все платформы
```

---

## Команды

### Основные

| Команда | Описание |
|---|---|
| `/help` | Список всех команд |
| `/model` | Информация о текущей модели |
| `/status` | Статус сессии: аптайм, ОС, рабочая папка |
| `/files [путь]` | Листинг файлов в директории |
| `/run <команда>` | Выполнить команду (заглушка) |
| `/config` | Настройки приложения (заглушка) |
| `/version` | Версия приложения |
| `/clear` | Очистить историю |
| `/exit` / `/quit` | Завершить работу |

### Утилиты безопасности

| Команда | Описание |
|---|---|
| `/hardening` | Чеклист харденинга Linux — авто-проверка 10 параметров безопасности. `↑↓` навигация, `E` экспорт отчёта, `Q` выход. **Только Linux.** |
| `/inventory [файл.txt]` | Инвентаризация системы: ОС, железо, диски, пользователи, сеть, открытые порты, сервисы. Без аргумента — вывод в терминал; с аргументом — сохранение в файл. |
| `/pass [параметры]` | Генератор паролей. |
| `/pass check "пароль"` | Оценить стойкость пароля. |

#### Параметры `/pass`

| Параметр | Описание | По умолчанию |
|---|---|---|
| `--length N` | Длина пароля | 16 |
| `--symbols` | Включить спецсимволы (`!@#$%...`) | выкл. |
| `--count N` | Количество паролей (до 50) | 1 |
| `--no-ambiguous` | Исключить неоднозначные символы (`l1IoO0`) | выкл. |

Примеры:
```
/pass
/pass --length 24 --symbols
/pass --count 5 --no-ambiguous
/pass check "MyPassword123"
```

#### Чеклист харденинга — что проверяется

| Категория | Проверка |
|---|---|
| SSH | PermitRootLogin = no / prohibit-password |
| SSH | PasswordAuthentication = no |
| SSH | MaxAuthTries ≤ 5 |
| PAM / Пароли | Минимальная длина пароля ≥ 8 |
| PAM / Пароли | pam_pwquality или pam_cracklib подключён |
| Firewall | ufw активен |
| auditd | Служба auditd запущена |
| USB | usb-storage заблокирован в modprobe |
| Ядро | ASLR включён (randomize_va_space = 2) |
| Ядро | SYN-cookies включены (tcp_syncookies = 1) |

Любой текст без `/` — запрос к AI (спиннер + stub-ответ).

---

## Структура проекта

```
mycode/
├── src/
│   ├── app.tsx              — точка входа (render + CLI update mode)
│   ├── types.ts             — общие TypeScript-типы
│   ├── components/
│   │   ├── Header.tsx
│   │   ├── WelcomeTips.tsx
│   │   ├── Spinner.tsx
│   │   ├── Messages.tsx     — UserMessage, AssistantMessage, SystemMessage, ErrorMessage, Thinking
│   │   ├── Suggestions.tsx  — выпадающий список автодополнения
│   │   ├── InputBox.tsx     — строка ввода
│   │   └── HardeningScreen.tsx — интерактивный экран харденинга
│   ├── hooks/
│   │   ├── useMessages.ts   — состояние сообщений
│   │   └── useInputState.ts — ввод, история, автодополнение
│   ├── commands/
│   │   └── index.ts         — реестр команд и обработчики
│   ├── features/
│   │   ├── hardening.ts     — логика проверок Linux (pure)
│   │   ├── inventory.ts     — сбор данных о системе (pure)
│   │   └── passgen.ts       — генератор паролей + оценка (pure)
│   └── utils/
│       └── update.ts        — логика само-обновления
├── dist/                    — скомпилированные бинарники (не в git)
├── bunbuild.mjs             — скрипт сборки
├── tsconfig.json            — конфигурация TypeScript
├── install.sh               — установщик Linux/macOS
├── install.ps1              — установщик Windows
└── package.json             — версия (единственный источник)
```

---

## Стек

| Технология | Роль |
|---|---|
| [TypeScript](https://www.typescriptlang.org) | Типизация |
| [React](https://react.dev) 19 | Компонентный UI |
| [Ink](https://github.com/vadimdemedes/ink) 6 | Рендеринг React в терминале |
| [Bun](https://bun.sh) | Runtime + компилятор в бинарник |

---

## Лицензия

MIT
