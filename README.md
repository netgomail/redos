# МойКод

> Консольная утилита для специалиста по защите информации — аудит безопасности, харденинг и инвентаризация Linux-систем. Заточена под РедОС 7/8 (RHEL-based).

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

### Служебные

| Команда | Описание |
|---|---|
| `/help` | Список всех команд |
| `/clear` | Очистить историю |
| `/exit` / `/quit` | Завершить работу |

### Аудит безопасности

| Команда | Описание |
|---|---|
| `/audit [файл.txt]` | Аудит пользователей и файловой системы — пароли, SUID/SGID, world-writable, опции монтирования. **Только Linux.** |
| `/logs [файл.txt]` | Анализ логов безопасности — неудачные SSH-входы, sudo, блокировки, SELinux denials, критические события journalctl. **Только Linux.** |
| `/firewall [файл.txt]` | Анализ фаервола — статус firewalld, зоны, правила, порты, SELinux. Fallback на iptables. **Только Linux.** |

### Харденинг и соответствие

| Команда | Описание |
|---|---|
| `/hardening` | Интерактивный чеклист харденинга Linux — 10 проверок SSH, PAM, firewalld, auditd, ядра. `↑↓` навигация, `F` автофикс, `E` экспорт, `Q` выход. **Только Linux.** |
| `/baseline` | CIS Benchmark для РедОС/RHEL — ~25 проверок по стандарту CIS Level 1: файловые системы, сервисы, сеть, аудит, аутентификация, права файлов. `↑↓` навигация, `F` автофикс, `E` экспорт, `Q` выход. **Только Linux.** |

### Инвентаризация

| Команда | Описание |
|---|---|
| `/inventory [файл.txt]` | Инвентаризация системы: ОС, железо, диски, пользователи, сеть, открытые порты, сервисы. |

Все команды с `[файл.txt]` поддерживают экспорт — без аргумента вывод в терминал, с аргументом — сохранение в файл.

---

## Детали проверок

### `/hardening` — чеклист харденинга

| Категория | Проверка |
|---|---|
| SSH | PermitRootLogin = no / prohibit-password |
| SSH | PasswordAuthentication = no |
| SSH | MaxAuthTries ≤ 5 |
| PAM / Пароли | Минимальная длина пароля ≥ 8 |
| PAM / Пароли | pam_pwquality или pam_cracklib подключён |
| Firewall | firewalld активен |
| auditd | Служба auditd запущена |
| USB | usb-storage заблокирован в modprobe |
| Ядро | ASLR включён (randomize_va_space = 2) |
| Ядро | SYN-cookies включены (tcp_syncookies = 1) |

### `/baseline` — CIS Benchmark RHEL 7/8

| Категория | Проверки |
|---|---|
| Файловые системы | /tmp отдельный раздел (noexec,nosuid,nodev), /var/tmp, blacklist cramfs/squashfs/udf |
| Сервисы | xinetd не установлен, chronyd настроен, avahi/cups отключены, ненужные сетевые сервисы |
| Сеть | IP forwarding отключён, ICMP redirects, source routing, TCP SYN cookies |
| Аудит | auditd запущен, правила аудита /etc/passwd+shadow+group, rsyslog |
| Аутентификация | Парольная политика (minlen, minclass), pam_faillock, TMOUT, umask |
| Права файлов | /etc/passwd, /etc/shadow, /etc/group, /etc/gshadow, sshd_config, crontab |

### `/audit` — аудит пользователей

| Секция | Что проверяется |
|---|---|
| Пользователи | UID ≥ 1000, shell, домашняя папка, UID 0 кроме root |
| Пароли | Пустые пароли, возраст > 90 дней |
| Привилегии | Группа wheel, файлы в /etc/sudoers.d |
| SUID/SGID | Файлы с битами SUID и SGID (топ-25) |
| World-writable | Директории с правами записи для всех |
| Без владельца | Файлы без существующего владельца/группы |
| Монтирование | Опции nosuid, noexec, nodev на /tmp, /var/tmp, /dev/shm |

### `/firewall` — анализ фаервола

| Секция | Что анализируется |
|---|---|
| Статус | firewalld активен / включён в автозапуск |
| Зоны | Активные зоны, зона по умолчанию, правила по зонам |
| Rich rules | Расширенные правила firewalld |
| Порты | Открытые порты (ss -tlnp) |
| iptables | Fallback если firewalld не установлен |
| SELinux | Режим (Enforcing/Permissive/Disabled), sestatus |

### `/logs` — анализ логов безопасности

| Секция | Источник |
|---|---|
| Неудачные SSH-входы | /var/log/secure — агрегация по IP, топ-10 |
| Успешные SSH-входы | /var/log/secure — последние 20 |
| Операции sudo | /var/log/secure — последние 30 |
| Блокировки | pam_faillock записи |
| Критические события | journalctl -p err за 24 часа |
| SELinux denials | /var/log/audit/audit.log — avc denied |

---

## Структура проекта

```
mycode/
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
│   │   ├── HardeningScreen.tsx  — полноэкранный чеклист харденинга
│   │   └── BaselineScreen.tsx   — полноэкранный CIS Benchmark
│   ├── hooks/
│   │   ├── useMessages.ts   — состояние сообщений
│   │   └── useInputState.ts — ввод, история, автодополнение
│   ├── commands/
│   │   └── index.ts         — реестр команд (CommandDef[]) и обработчики
│   ├── features/
│   │   ├── hardening.ts     — проверки харденинга Linux
│   │   ├── baseline.ts      — проверки CIS Benchmark RHEL
│   │   ├── audit.ts         — аудит пользователей и ФС
│   │   ├── firewall.ts      — анализ firewalld/iptables/SELinux
│   │   ├── logs.ts          — анализ логов безопасности
│   │   └── inventory.ts     — инвентаризация системы
│   └── utils/
│       ├── update.ts        — само-обновление
│       └── fs.ts            — общий readFile()
├── dist/                    — скомпилированные бинарники (не в git)
├── bunbuild.mjs             — скрипт сборки
├── tsconfig.json
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
