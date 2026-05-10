import { readFile } from '../utils/fs';
import { sudoRun, fixConfigLine, writeSudo, backupFile } from '../utils/sudo';
import type { FixResult } from '../utils/sudo';

/**
 * Парольная политика РедОС 8.
 *
 * Сложность пишется в drop-in /etc/security/pwquality.conf.d/50-redos.conf —
 * pam_pwquality в system-auth/password-auth подхватит без правки PAM-стека
 * (он управляется authselect и его трогать нельзя).
 *
 * Сроки действия — /etc/login.defs (только для новых учёток) и chage для
 * существующих.
 */

export const PWQ_DROPIN_DIR  = '/etc/security/pwquality.conf.d';
export const PWQ_DROPIN_FILE = '/etc/security/pwquality.conf.d/50-redos.conf';
export const PWQ_BASE_FILE   = '/etc/security/pwquality.conf';
export const LOGIN_DEFS_FILE = '/etc/login.defs';

// ─── типы ─────────────────────────────────────────────────────────────────────

export interface PwQuality {
  minlen:   number;
  minclass: number;
  dcredit:  number;
  ucredit:  number;
  lcredit:  number;
  ocredit:  number;
  difok:    number;
  retry:    number;
}

export interface LoginDefs {
  PASS_MAX_DAYS: number;
  PASS_MIN_DAYS: number;
  PASS_WARN_AGE: number;
}

export interface Preset {
  id:    'basic' | 'strong';
  title: string;
  hint:  string;
  pwquality: PwQuality;
  login:     LoginDefs;
}

export const PRESETS: Preset[] = [
  {
    id: 'basic',
    title: 'Базовая',
    hint:  'minlen=8, классов 4, смена раз в 90 дней',
    pwquality: { minlen: 8,  minclass: 4, dcredit: -1, ucredit: -1, lcredit: -1, ocredit: -1, difok: 5, retry: 3 },
    login:     { PASS_MAX_DAYS: 90, PASS_MIN_DAYS: 1, PASS_WARN_AGE: 7 },
  },
  {
    id: 'strong',
    title: 'Усиленная',
    hint:  'minlen=12, классов 4, смена раз в 60 дней',
    pwquality: { minlen: 12, minclass: 4, dcredit: -1, ucredit: -1, lcredit: -1, ocredit: -1, difok: 5, retry: 3 },
    login:     { PASS_MAX_DAYS: 60, PASS_MIN_DAYS: 1, PASS_WARN_AGE: 14 },
  },
];

const PWQ_KEYS:   (keyof PwQuality)[] = ['minlen', 'minclass', 'dcredit', 'ucredit', 'lcredit', 'ocredit', 'difok', 'retry'];
const LOGIN_KEYS: (keyof LoginDefs)[] = ['PASS_MAX_DAYS', 'PASS_MIN_DAYS', 'PASS_WARN_AGE'];

// ─── чтение текущей политики ──────────────────────────────────────────────────

/**
 * Читаем настройки pwquality «слоями»: сначала основной файл, затем drop-in
 * (drop-in перекрывает). Возвращаем фактически действующие значения.
 */
export function readPwQuality(): Partial<PwQuality> {
  const result: Partial<PwQuality> = {};
  parsePwqInto(readFile(PWQ_BASE_FILE),   result);
  parsePwqInto(readFile(PWQ_DROPIN_FILE), result);
  return result;
}

function parsePwqInto(content: string | null, out: Partial<PwQuality>): void {
  if (!content) return;
  for (const raw of content.split('\n')) {
    if (/^\s*#/.test(raw)) continue;
    const m = raw.match(/^\s*([a-z_]+)\s*=\s*(-?\d+)/i);
    if (m && (PWQ_KEYS as string[]).includes(m[1].toLowerCase())) {
      (out as Record<string, number>)[m[1].toLowerCase()] = parseInt(m[2], 10);
    }
  }
}

export function readLoginDefs(): Partial<LoginDefs> {
  const content = readFile(LOGIN_DEFS_FILE);
  if (!content) return {};
  const result: Partial<LoginDefs> = {};
  for (const raw of content.split('\n')) {
    if (/^\s*#/.test(raw)) continue;
    const m = raw.match(/^\s*([A-Z_]+)\s+(\d+)/);
    if (m && (LOGIN_KEYS as string[]).includes(m[1])) {
      (result as Record<string, number>)[m[1]] = parseInt(m[2], 10);
    }
  }
  return result;
}

/** Видна ли drop-in (полезно для UI: «настроено через redos» / «исходные дефолты») */
export function pwqDropinExists(): boolean {
  return readFile(PWQ_DROPIN_FILE) !== null;
}

// ─── применение политики ──────────────────────────────────────────────────────

export function applyPwQuality(v: PwQuality): FixResult {
  const lines = [
    '# Парольная политика, сгенерировано redos',
    `# ${new Date().toISOString()}`,
    '',
    ...PWQ_KEYS.map(k => `${k} = ${v[k]}`),
    '',
  ].join('\n');
  return writeSudo(PWQ_DROPIN_FILE, lines);
}

export function applyLoginDefs(v: LoginDefs): FixResult {
  const bk = backupFile(LOGIN_DEFS_FILE);
  if (!bk.ok) return { ok: false, msg: 'backup: ' + bk.msg };

  for (const k of LOGIN_KEYS) {
    // После ключа обязательно число — иначе сматчим документационный комментарий
    // вида «#\tPASS_MAX_DAYS\tMaximum number of days...» в шапке файла.
    const r = fixConfigLine(
      LOGIN_DEFS_FILE,
      new RegExp(`^\\s*#?\\s*${k}\\s+\\d+`),
      `${k}\t${v[k]}`,
    );
    if (!r.ok) return { ok: false, msg: `${k}: ${r.msg}` };
  }
  return { ok: true, msg: 'login.defs обновлён' };
}

// ─── пользователи ─────────────────────────────────────────────────────────────

export interface LocalUser {
  name:            string;
  uid:             number;
  shell:           string;
  systemAccount:   boolean;
  lastChange:      string | null;
  passwordExpires: string | null;
  forced:          boolean;
}

function daysToISO(days: number): string {
  return new Date(days * 86400 * 1000).toISOString().slice(0, 10);
}

/**
 * Кто реально запустил redos (если процесс работает от root через sudo/pkexec).
 * Возвращает имя живой учётки или null, если определить не удалось.
 */
export function detectCurrentUser(): string | null {
  // sudo подставляет SUDO_USER с именем оригинального пользователя.
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && sudoUser !== 'root') return sudoUser;

  // pkexec подставляет PKEXEC_UID. Резолвим в имя через id(1).
  const pkUid = process.env.PKEXEC_UID;
  if (pkUid) {
    try {
      const r = Bun.spawnSync(['id', '-nu', pkUid], { stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode === 0) {
        const name = new TextDecoder().decode(r.stdout).trim();
        if (name && name !== 'root') return name;
      }
    } catch { /* ignore */ }
  }

  // Без эскалации USER/LOGNAME уже корректный.
  const envUser = process.env.USER || process.env.LOGNAME;
  if (envUser && envUser !== 'root') return envUser;

  return null;
}

export function listLocalUsers(): LocalUser[] {
  const passwd = readFile('/etc/passwd');
  if (!passwd) return [];

  // /etc/shadow читается только под root. Без sudo поля дат остаются null.
  const shadow = readFile('/etc/shadow');
  const shadowMap = new Map<string, string[]>();
  if (shadow) {
    for (const line of shadow.split('\n')) {
      const parts = line.split(':');
      if (parts.length < 9) continue;
      shadowMap.set(parts[0], parts);
    }
  }

  const users: LocalUser[] = [];
  for (const line of passwd.split('\n')) {
    const parts = line.split(':');
    if (parts.length < 7) continue;
    const name = parts[0];
    const uid  = parseInt(parts[2], 10);
    const shell = parts[6];
    if (isNaN(uid)) continue;

    const isSystem = uid < 1000 || /\/(nologin|false)$/.test(shell) || name === 'root';

    let lastChange: string | null = null;
    let expires:    string | null = null;
    let forced = false;
    const sh = shadowMap.get(name);
    if (sh) {
      const lc  = parseInt(sh[2], 10);
      const max = parseInt(sh[4], 10);
      if (lc === 0) {
        forced = true;
        lastChange = '— (смена при входе)';
      } else if (!isNaN(lc) && lc > 0) {
        lastChange = daysToISO(lc);
        if (!isNaN(max) && max > 0 && max < 99999) {
          expires = daysToISO(lc + max);
        }
      }
    }

    users.push({ name, uid, shell, systemAccount: isSystem, lastChange, passwordExpires: expires, forced });
  }
  return users.sort((a, b) => a.uid - b.uid);
}

export function applyChageDates(user: string, v: LoginDefs): FixResult {
  return sudoRun([
    'chage',
    '-M', String(v.PASS_MAX_DAYS),
    '-m', String(v.PASS_MIN_DAYS),
    '-W', String(v.PASS_WARN_AGE),
    user,
  ]);
}

export function forcePasswordChange(user: string): FixResult {
  return sudoRun(['chage', '-d', '0', user]);
}
