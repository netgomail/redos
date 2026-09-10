import { homedir } from 'os';
import { readFile } from '../utils/fs';
import { isRoot } from '../utils/sudo';
import { detectCurrentUser } from './passwordPolicy';
import { STIMATE_ICON_PNG_BASE64 } from '../assets/stimateIcon';

/**
 * Установка сторонних программ, не входящих в РедОС из коробки.
 *
 * Всё ставится в домашний каталог оператора (не системно), поэтому root не
 * требуется — но redos может уже работать от root, если пользователь до этого
 * вызывал команду с эскалацией (pkexec/sudo подхватывает права на весь
 * процесс). В этом случае определяем реального пользователя и в конце
 * возвращаем файлы ему во владение — иначе он не сможет ни запустить ярлык,
 * ни переустановить программу без sudo.
 */

// ─── типы ─────────────────────────────────────────────────────────────────────

export interface InstallApp {
  id:            string;
  name:          string;
  description:   string;
  /** Прямая ссылка на исполняемый файл (публичная ссылка Nextcloud/ownCloud). */
  downloadUrl:   string;
  binaryName:    string;
  /** Подпапка в $HOME, куда всё распаковывается. */
  installSubdir: string;
  iconBase64:    string;
  iconFileName:  string;
  ini?: { fileName: string; content: string };
  /**
   * Однократно создаваемый файл вне installSubdir (например, «реестр»
   * приложения в $HOME/.config/...). Не перезаписывается, если уже существует
   * — там может накопиться состояние от предыдущего запуска программы.
   */
  seedFile?: { relPath: string; content: string };
  desktop: {
    fileName: string;
    name:     string;
    execArgs: string;
    mimeType?:          string;
    mimeHandlerScheme?: string;
  };
  postInstallNote: string;
}

export interface InstallResult {
  ok:  boolean;
  msg: string;
}

// ─── реестр программ ────────────────────────────────────────────────────────────

const AUTH_SERVER = '10.31.22.10:8080';

export const INSTALL_APPS: InstallApp[] = [
  {
    id:            'stimrun',
    name:          'АС Смета',
    description:   'Клиент системы электронного документооборота «Смета» (Krista)',
    downloadUrl:   'https://files.yanao.ru/s/AMQnYkzrix4oTLz/download',
    binaryName:    'stimrun',
    installSubdir: 'stimate',
    iconBase64:    STIMATE_ICON_PNG_BASE64,
    iconFileName:  'stimate.png',
    ini: {
      fileName: 'stimate.ini',
      content:  `[Server]\nAddress00=${AUTH_SERVER}\n`,
    },
    seedFile: {
      relPath: '.config/stimate/reg.xml',
      content: [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<XMLReg>',
        '  <Key Name="HKEY_CURRENT_USER">',
        '    <Key Name="Software">',
        '      <Key Name="Krista">',
        '        <Key Name="stimate">',
        '          <Key Name="XE">',
        `            <Value Name="AppServer" Type="2">${AUTH_SERVER}</Value>`,
        '            <Value Name="UseProxy" Type="1">0</Value>',
        '          </Key>',
        '        </Key>',
        '      </Key>',
        '    </Key>',
        '  </Key>',
        '</XMLReg>',
        '',
      ].join('\n'),
    },
    desktop: {
      fileName: 'stimate.exe.desktop',
      name:     'АС Смета',
      execArgs: '-saml2 %u',
      mimeType:          'x-scheme-handler/stimate;',
      mimeHandlerScheme: 'x-scheme-handler/stimate.exe',
    },
    postInstallNote: `Сервер авторизации ${AUTH_SERVER} уже прописан — вводить вручную не нужно.`,
  },
];

// ─── определение реального пользователя и его каталогов ────────────────────────

function resolveTargetHome(): { home: string; user: string | null } {
  if (!isRoot()) return { home: homedir(), user: process.env.USER || process.env.LOGNAME || null };

  const user = detectCurrentUser();
  if (!user) return { home: homedir(), user: null };

  const passwd = readFile('/etc/passwd') ?? '';
  for (const line of passwd.split('\n')) {
    const parts = line.split(':');
    if (parts[0] === user) return { home: parts[5] || homedir(), user };
  }
  return { home: homedir(), user };
}

/**
 * Публичные ссылки Nextcloud/ownCloud (files.yanao.ru) отдают файл не сразу:
 * первый ответ — 303 с cookie сессии, редиректящий на /public.php/dav/...;
 * без переноса cookie на второй запрос сервер отвечает ошибкой. fetch() сам
 * редиректы проходит, но cookie между хопами не переносит — поэтому редиректы
 * обрабатываем вручную.
 */
async function fetchFollowingRedirects(startUrl: string, maxHops = 5): Promise<Response> {
  let current = startUrl;
  const cookies: string[] = [];
  for (let i = 0; i < maxHops; i++) {
    const resp = await fetch(current, {
      redirect: 'manual',
      headers: cookies.length ? { Cookie: cookies.join('; ') } : {},
    });
    const setCookie = resp.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) cookies.push(c.split(';')[0]);

    const location = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error('слишком много редиректов');
}

function resolveDesktopDir(home: string): string {
  const cfg = readFile(`${home}/.config/user-dirs.dirs`);
  if (cfg) {
    const m = cfg.match(/XDG_DESKTOP_DIR="([^"]+)"/);
    if (m) return m[1].replace(/\$HOME\b/, home);
  }
  return `${home}/Desktop`;
}

// ─── установка ──────────────────────────────────────────────────────────────────

export async function installApp(
  app: InstallApp,
  onStep: (msg: string) => void = () => {},
  onProgress: (received: number, total: number) => void = () => {},
): Promise<InstallResult> {
  const { home, user } = resolveTargetHome();
  const installDir = `${home}/${app.installSubdir}`;

  // ── скачивание ──────────────────────────────────────────────────────────────
  onStep(`Скачиваю ${app.name}...`);
  let data: Uint8Array;
  try {
    const resp = await fetchFollowingRedirects(app.downloadUrl);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const total = Number(resp.headers.get('content-length') ?? 0);
    const reader = resp.body?.getReader();
    if (!reader) throw new Error('нет тела ответа');

    const chunks: Uint8Array[] = [];
    let received = 0;
    onProgress(0, total);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(received, total);
    }
    data = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) { data.set(c, offset); offset += c.byteLength; }
  } catch (e) {
    return { ok: false, msg: 'Ошибка при скачивании: ' + (e as Error).message };
  }

  const { mkdirSync, writeFileSync, chmodSync } = await import('fs');

  // ── запись бинарника ──────────────────────────────────────────────────────────
  onStep('Записываю исполняемый файл...');
  try {
    mkdirSync(installDir, { recursive: true });
    writeFileSync(`${installDir}/${app.binaryName}`, data);
  } catch (e) {
    return { ok: false, msg: 'Ошибка установки: ' + (e as Error).message };
  }

  // ── иконка, ini, «реестр» ─────────────────────────────────────────────────────
  onStep('Записываю иконку и конфигурацию...');
  try {
    writeFileSync(`${installDir}/${app.iconFileName}`, Buffer.from(app.iconBase64, 'base64'));
    if (app.ini) writeFileSync(`${installDir}/${app.ini.fileName}`, app.ini.content);
    if (app.seedFile) {
      const seedPath = `${home}/${app.seedFile.relPath}`;
      if (!readFile(seedPath)) {
        mkdirSync(seedPath.slice(0, seedPath.lastIndexOf('/')), { recursive: true });
        writeFileSync(seedPath, app.seedFile.content);
      }
    }
  } catch (e) {
    return { ok: false, msg: 'Ошибка записи файлов: ' + (e as Error).message };
  }

  // ── права: везде чтение+выполнение, запись — только владельцу ────────────────
  onStep('Выставляю права доступа...');
  Bun.spawnSync(['chmod', '-R', '755', installDir]);

  // ── ярлык ────────────────────────────────────────────────────────────────────
  onStep('Создаю ярлык...');
  const binaryPath = `${installDir}/${app.binaryName}`;
  const desktopEntry = [
    '[Desktop Entry]',
    'Encoding=UTF-8',
    'Version=1.0',
    'Type=Application',
    'Terminal=false',
    `Name=${app.desktop.name}`,
    `Icon=${installDir}/${app.iconFileName}`,
    `Path=${installDir}/`,
    `Exec=${binaryPath} ${app.desktop.execArgs}`,
    ...(app.desktop.mimeType ? [`MimeType=${app.desktop.mimeType}`] : []),
    '',
  ].join('\n');

  const appsDir    = `${home}/.local/share/applications`;
  const desktopDir = resolveDesktopDir(home);
  const appsPath   = `${appsDir}/${app.desktop.fileName}`;
  const deskPath   = `${desktopDir}/${app.desktop.fileName}`;

  try {
    mkdirSync(appsDir, { recursive: true });
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(appsPath, desktopEntry);
    writeFileSync(deskPath, desktopEntry);
    chmodSync(appsPath, 0o755);
    chmodSync(deskPath, 0o755);
    // GNOME/Nautilus не запускает .desktop с рабочего стола без метки доверия;
    // на MATE/Caja она не нужна — просто игнорируем отсутствие gio.
    try { Bun.spawnSync(['gio', 'set', deskPath, 'metadata::trusted', 'true']); } catch { /* нет gio */ }

    if (app.desktop.mimeHandlerScheme) {
      const mimeFile = `${home}/.config/mimeapps.list`;
      const line = `${app.desktop.mimeHandlerScheme}=${app.desktop.fileName}`;
      const existing = readFile(mimeFile);
      if (!existing) {
        writeFileSync(mimeFile, `[Default Applications]\n${line}\n`);
      } else if (!existing.includes(line)) {
        const updated = /\[Default Applications\]/.test(existing)
          ? existing.replace(/\[Default Applications\]/, `[Default Applications]\n${line}`)
          : existing.trimEnd() + `\n\n[Default Applications]\n${line}\n`;
        writeFileSync(mimeFile, updated);
      }
    }
  } catch (e) {
    return { ok: false, msg: 'Ошибка создания ярлыка: ' + (e as Error).message };
  }

  // ── возврат владения реальному пользователю, если процесс сейчас root ────────
  if (isRoot() && user) {
    let group = user;
    try {
      const r = Bun.spawnSync(['id', '-gn', user], { stdout: 'pipe' });
      if (r.exitCode === 0) group = new TextDecoder().decode(r.stdout).trim() || user;
    } catch { /* используем user как группу */ }
    const owner = `${user}:${group}`;
    Bun.spawnSync(['chown', '-R', owner, installDir]);
    Bun.spawnSync(['chown', owner, appsPath]);
    Bun.spawnSync(['chown', owner, deskPath]);
    if (app.seedFile) Bun.spawnSync(['chown', owner, `${home}/${app.seedFile.relPath}`]);
  }

  return {
    ok: true,
    msg: [
      `${app.name} установлена: ${installDir}`,
      'Ярлык добавлен на рабочий стол и в меню приложений.',
      app.postInstallNote,
    ].join('\n'),
  };
}

// ─── запуск после установки ─────────────────────────────────────────────────────

/** Есть ли графическая сессия, куда можно запустить GUI-программу. */
export function hasGraphicalSession(): boolean {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Запускает только что установленную программу отдельным процессом. Для
 * stimrun это не просто открытие окна — по журналу stimrun.log видно, что при
 * первом запуске он сам докачивает недостающее (шрифты, основной модуль
 * stimate, библиотеки ГОСТ-шифрования) с сервера обновлений — то есть
 * настоящая установка происходит именно здесь, а не при распаковке.
 *
 * `setsid` отвязывает процесс от текущей сессии, чтобы он пережил закрытие
 * redos.
 */
export function launchApp(app: InstallApp): InstallResult {
  if (!hasGraphicalSession()) {
    return { ok: false, msg: 'Нет графической сессии (DISPLAY/WAYLAND_DISPLAY) — запустите ярлык вручную из графического окружения.' };
  }
  const { home } = resolveTargetHome();
  const binaryPath = `${home}/${app.installSubdir}/${app.binaryName}`;
  try {
    Bun.spawn(['setsid', binaryPath], { stdio: ['ignore', 'ignore', 'ignore'] });
    return { ok: true, msg: `${app.name} запущена — первый запуск может докачать недостающие файлы с сервера обновлений.` };
  } catch (e) {
    return { ok: false, msg: 'Ошибка запуска: ' + (e as Error).message };
  }
}
