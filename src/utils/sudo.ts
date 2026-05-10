import { readFile } from './fs';

export type FixResult = { ok: boolean; msg: string };

/** sudo -n <args>; возвращает { ok, msg } */
export function sudoRun(args: string[]): FixResult {
  try {
    const result = Bun.spawnSync(['sudo', '-n', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const out = new TextDecoder().decode(result.stdout).trim();
    const err = new TextDecoder().decode(result.stderr).trim();
    if (result.exitCode === 0) return { ok: true, msg: out || 'Применено' };
    if (err.includes('password is required') || err.includes('a password'))
      return { ok: false, msg: 'Требуется sudo. Запустите: sudo redos' };
    return { ok: false, msg: err || out || `exit ${result.exitCode}` };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  }
}

/** Записать content в file через sudo tee (создаёт или перезаписывает) */
export function writeSudo(file: string, content: string): FixResult {
  try {
    const proc = Bun.spawnSync(['sudo', '-n', 'tee', file], {
      stdin: new TextEncoder().encode(content),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) {
      const err = new TextDecoder().decode(proc.stderr).trim();
      return {
        ok: false,
        msg: err.includes('password') ? 'Требуется sudo. Запустите: sudo redos' : err,
      };
    }
    return { ok: true, msg: 'Применено' };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  }
}

/**
 * В файле заменяет первую строку, совпавшую с pattern, на newLine; все
 * последующие совпадения удаляются (иначе дубликат ниже перекрыл бы наше
 * значение — например, в login.defs читается последняя запись по ключу).
 * Если совпадений нет — добавляет newLine в конец.
 */
export function fixConfigLine(file: string, pattern: RegExp, newLine: string): FixResult {
  const content = readFile(file) ?? '';
  let replaced  = false;
  const out: string[] = [];
  for (const l of content.split('\n')) {
    if (pattern.test(l)) {
      if (!replaced) { out.push(newLine); replaced = true; }
      continue;
    }
    out.push(l);
  }
  const newContent = replaced
    ? out.join('\n')
    : content.trimEnd() + '\n' + newLine + '\n';
  return writeSudo(file, newContent);
}

/** Делает резервную копию file через sudo cp -p file file.bak.YYYYMMDD-HHMMSS */
export function backupFile(file: string): FixResult {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15); // YYYYMMDD-HHMMSS
  return sudoRun(['cp', '-p', file, `${file}.bak.${stamp}`]);
}

// ─── повышение прав ───────────────────────────────────────────────────────────

export function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Доступен ли pkexec в графической сессии (есть DISPLAY/WAYLAND_DISPLAY) */
export function canPkexec(): boolean {
  if (process.platform !== 'linux') return false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  try {
    const r = Bun.spawnSync(['which', 'pkexec'], { stdout: 'pipe', stderr: 'pipe' });
    return r.exitCode === 0;
  } catch { return false; }
}

/**
 * Перезапускает текущее приложение через pkexec — polkit покажет графическое
 * окно для ввода пароля администратора. Если пользователь закрыл диалог или
 * не прошёл авторизацию (exit 126/127), возвращает 'cancelled' — caller должен
 * перезапустить Ink. При успешном запуске дочернего процесса родитель завершает
 * себя тем же кодом и не возвращается.
 *
 * autoCmd — имя команды (например, '/passwd-policy'), которую дочерний процесс
 * должен автоматически открыть после старта. Прокидывается через флаг
 * --auto-cmd в argv.
 *
 * Caller должен заранее вызвать ink-exit, чтобы освободить TTY.
 *
 * Чтобы первое нажатие клавиши в дочернем процессе не «съедал» ещё живой
 * родитель, перед spawn явно глушим stdin-reader родителя:
 *  - снимаем raw-mode (canonical mode)
 *  - удаляем listeners
 *  - pause + unref, чтобы Node/Bun не держал ссылку на TTY
 * Курсор возвращаем — Ink его прячет и при exit() не всегда восстанавливает.
 */
export async function escalateViaPkexec(autoCmd?: string): Promise<'cancelled'> {
  await new Promise<void>(r => setTimeout(r, 80));

  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('readable');
  process.stdin.removeAllListeners('keypress');
  try { process.stdin.pause(); } catch { /* ignore */ }
  try { (process.stdin as { unref?: () => void }).unref?.(); } catch { /* ignore */ }

  // Показать курсор + сбросить ANSI-modes, которые Ink оставляет (mouse-tracking,
  // bracketed-paste, focus-events) — иначе они «протекают» в дочерний TUI.
  process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?2004l');

  // Снимаем уже имеющийся --auto-cmd, чтобы не дублировать при повторной
  // эскалации внутри уже эскалированного дочернего процесса.
  const passthrough: string[] = [];
  const slice = process.argv.slice(1);
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === '--auto-cmd') { i++; continue; }
    passthrough.push(slice[i]);
  }
  if (autoCmd) passthrough.push('--auto-cmd', autoCmd);

  const child = Bun.spawn(
    ['pkexec', process.execPath, ...passthrough],
    { stdio: ['inherit', 'inherit', 'inherit'] },
  );
  const code = await child.exited;

  // 126 — пользователь закрыл диалог авторизации; 127 — авторизация не пройдена.
  if (code === 126 || code === 127) {
    try { (process.stdin as { ref?: () => void }).ref?.(); } catch { /* ignore */ }
    return 'cancelled';
  }

  process.exit(typeof code === 'number' ? code : 0);
}
