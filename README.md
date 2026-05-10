# РедОС

> Консольная утилита для специалиста по защите информации — настройка парольной политики, установка пакетов и инвентаризация Linux-систем. Заточена под РедОС 7/8 (RHEL-based).

---

## Установка

```bash
curl -fsSL https://raw.githubusercontent.com/netgomail/redos/master/install.sh | bash
```

Установщик автоматически скачивает последнюю версию из GitHub Releases и добавляет `redos` в PATH.

---

## Обновление

```bash
redos update
```

---

## Запуск из исходников

Требуется [Bun](https://bun.sh) ≥ 1.1.

```bash
bun install
bun start
```

---

## Сборка бинарника

```bash
bun run build   # → dist/redos-linux  (Linux x64)
```

---

## Команды

### Служебные

| Команда | Описание |
|---|---|
| `/help` | Список всех команд |
| `/clear` | Очистить историю |
| `/exit` / `/quit` | Завершить работу |

### Безопасность

| Команда | Описание |
|---|---|
| `/passwd-policy` | Парольная политика — сложность пароля, срок смены, принудительная смена при входе. Требует root (запросит через polkit в графической сессии). **Только Linux.** |

### Инвентаризация

| Команда | Описание |
|---|---|
| `/inventory [файл.txt]` | Инвентаризация системы: ОС, железо, диски, пользователи, сеть, открытые порты, сервисы. |

### Установка пакетов

| Команда | Описание |
|---|---|
| `/install` | Установка пакетов с настроенного сервера. Требует root. **Только Linux.** |
| `/config [server\|secret] [значение]` | Настройка адреса сервера и секрета для `/install`. |

---

## `/passwd-policy` — детали

Полноэкранный режим с тремя действиями:

- **Применить пресет «Базовая»** — `minlen=8`, `minclass=3`, `PASS_MAX_DAYS=90`. Опционально применяет `chage -M -m -W` к выбранным пользователям.
- **Применить пресет «Усиленная»** — `minlen=12`, `minclass=4`, `PASS_MAX_DAYS=60`. То же самое для существующих пользователей.
- **Форсировать смену пароля при входе** — `chage -d 0` для выбранных пользователей; при ближайшем входе система потребует новый пароль.

Куда пишутся настройки:

| Файл | Что |
|---|---|
| `/etc/security/pwquality.conf.d/50-redos.conf` | Параметры сложности (drop-in, основной `pwquality.conf` не трогается) |
| `/etc/login.defs` | `PASS_MAX_DAYS`, `PASS_MIN_DAYS`, `PASS_WARN_AGE`. Перед записью создаётся `*.bak.YYYYMMDD-HHMMSS` |
| `/etc/shadow` (через `chage`) | Сроки и флаг «сменить при входе» для существующих пользователей |

PAM-стек `/etc/pam.d/system-auth` / `password-auth` **не редактируется** — он управляется `authselect`. `pam_pwquality` уже подключён в нём по умолчанию и подхватывает drop-in.

---

## Структура проекта

```
redos/
├── src/
│   ├── app.tsx              — точка входа (render + CLI update mode)
│   ├── types.ts             — общие типы (Screen, Message, TextColor)
│   ├── components/
│   │   ├── Header.tsx
│   │   ├── WelcomeTips.tsx
│   │   ├── Spinner.tsx
│   │   ├── Messages.tsx     — UserMessage, SystemMessage, ErrorMessage
│   │   ├── Suggestions.tsx  — выпадающий список автодополнения
│   │   ├── InputBox.tsx     — строка ввода
│   │   ├── InstallScreen.tsx        — установка пакетов
│   │   └── PasswordPolicyScreen.tsx — парольная политика
│   ├── hooks/
│   │   ├── useMessages.ts   — состояние сообщений
│   │   └── useInputState.ts — ввод, история, автодополнение
│   ├── commands/
│   │   └── index.ts         — реестр команд (CommandDef[]) и обработчики
│   ├── features/
│   │   ├── inventory.ts     — инвентаризация системы
│   │   ├── passwordPolicy.ts — чтение/запись парольной политики, chage
│   │   └── packages/        — установщик пакетов с сервера
│   └── utils/
│       ├── update.ts        — само-обновление
│       ├── sudo.ts          — sudoRun / writeSudo / pkexec re-exec
│       └── fs.ts            — общий readFile()
├── dist/                    — скомпилированные бинарники (не в git)
├── bunbuild.mjs             — скрипт сборки
├── tsconfig.json
├── install.sh               — установщик Linux x86_64
└── package.json             — версия (единственный источник)
```

---

## Стек

| Технология | Роль |
|---|---|
| [TypeScript](https://www.typescriptlang.org) | Типизация |
| [React](https://react.dev) 19 | Компонентный UI |
| [Ink](https://github.com/vadimdemedes/ink) 7 | Рендеринг React в терминале |
| [Bun](https://bun.sh) | Runtime + компилятор в бинарник |

---

## Лицензия

MIT
