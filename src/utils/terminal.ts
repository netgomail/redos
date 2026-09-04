/**
 * Запуск системных команд в псевдотерминале (Bun.Terminal, появился в Bun 1.4).
 *
 * Зачем PTY, а не обычный Bun.spawn с pipe:
 *
 *  1. Утилиты смотрят на isatty(). Под pipe `lpstat`, `journalctl`,
 *     `scanimage -L`, `lpinfo` режут вывод, отключают цвет и прогресс. Под PTY
 *     они ведут себя ровно так же, как в настоящем терминале, — администратор
 *     видит то же, что увидел бы, набрав команду руками.
 *
 *  2. Живой вывод. Долгие команды (`scanimage -L` до минуты, `lpadmin` с
 *     опросом устройства) отдают строки по мере работы, а не одним куском в
 *     конце, — экран может показывать ход выполнения.
 *
 *  3. Приглашения ввода. Команда под PTY может быть спрошена о чём-то
 *     интерактивно, и на это можно ответить (см. respond).
 *
 * В отличие от Bun.spawnSync из utils/sudo.ts, здесь всё асинхронно и не
 * блокирует перерисовку Ink.
 */

export interface PtyResult {
  /** Код возврата процесса (не PTY). -1, если процесс убит по таймауту. */
  code:     number;
  /** Полный вывод, \r\n приведены к \n. ANSI-коды сохранены. */
  output:   string;
  timedOut: boolean;
}

export interface PtyRunOptions {
  cols?:      number;
  rows?:      number;
  /** Сырые куски вывода — для живого лога в UI. */
  onData?:    (chunk: string) => void;
  /** Готовые строки без ANSI и \r — удобнее для построчного лога. */
  onLine?:    (line: string) => void;
  /**
   * Ответ на приглашения. Вызывается на каждый кусок вывода; вернуть строку,
   * которую нужно записать в терминал.
   */
  respond?:   (chunk: string) => string | null | undefined;
  /** Записать в stdin команды сразу после старта. */
  input?:     string;
  timeoutMs?: number;
  cwd?:       string;
  env?:       Record<string, string>;
}

const DEFAULT_TIMEOUT = 120_000;

/**
 * Запускает команду в PTY и отдаёт весь вывод. Ink при этом продолжает
 * рисовать экран: вывод идёт не в наш stdout, а в колбэки.
 */
export async function runPty(argv: string[], opts: PtyRunOptions = {}): Promise<PtyResult> {
  const {
    cols = 120, rows = 40,
    onData, onLine, respond, input,
    timeoutMs = DEFAULT_TIMEOUT,
    cwd, env,
  } = opts;

  let output   = '';
  let lineBuf  = '';
  let timedOut = false;

  const term = new Bun.Terminal({
    cols, rows,
    data(t, bytes) {
      const chunk = new TextDecoder().decode(bytes);
      output += chunk;
      onData?.(chunk);

      if (onLine) {
        lineBuf += chunk;
        const parts = lineBuf.split(/\r?\n/);
        lineBuf = parts.pop() ?? '';
        for (const l of parts) onLine(stripAnsi(l).replace(/\r/g, ''));
      }

      const reply = respond?.(chunk);
      if (reply) t.write(reply);
    },
  });

  try {
    let proc;
    try {
      proc = Bun.spawn(argv, {
        terminal: term,
        cwd,
        // TERM обязателен: без него утилиты считают терминал «тупым» и всё
        // равно режут вывод, а curses-приложения падают.
        env: { ...process.env, TERM: 'xterm-256color', ...(env ?? {}) },
      });
    } catch (e) {
      // Утилиты может не быть в системе (нет cups-client, нет sane-utils).
      // Возвращаем 127, как это делает шелл, — вызывающий код разбирает код,
      // а не ловит исключение.
      const msg = `${argv[0]}: не удалось запустить (${(e as Error).message})`;
      onLine?.(msg);
      return { code: 127, output: msg + '\n', timedOut: false };
    }

    if (input) term.write(input);

    const killer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
    const code = await proc.exited;
    clearTimeout(killer);

    // PTY отдаёт хвост вывода уже после exit — даём ему долететь.
    await new Promise<void>(r => setTimeout(r, 60));
    if (onLine && lineBuf) onLine(stripAnsi(lineBuf).replace(/\r/g, ''));

    return { code: timedOut ? -1 : code, output: output.replace(/\r\n/g, '\n'), timedOut };
  } finally {
    term.close();
  }
}

/** Только строки вывода, без ANSI. Ошибки запуска дают пустой массив. */
export async function runPtyLines(argv: string[], opts: PtyRunOptions = {}): Promise<string[]> {
  try {
    const r = await runPty(argv, opts);
    return stripAnsi(r.output).split('\n').map(l => l.replace(/\r/g, ''));
  } catch {
    return [];
  }
}

// CSI/OSC/одиночные esc-последовательности. Нужен для onLine и для разбора
// вывода: иначе в UI попадают коды переноса курсора и раскраски.
const ANSI_RE = /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
