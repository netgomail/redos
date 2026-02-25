import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { readFile } from '../utils/fs';
import type { TextColor } from '../types';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';
export type FixResult   = { ok: boolean; msg: string };

export interface CheckItem {
  id: string;
  category: string;
  title: string;
  hint: string;
  check: () => CheckStatus;
  fix?: () => FixResult;
}

// ─── helpers (check) ──────────────────────────────────────────────────────────

/** Найти значение директивы в конфиге вида "Key Value" (ignoreCase) */
function sshConfigValue(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s+(\\S+)`, 'im');
  const m = content.match(re);
  return m ? m[1].toLowerCase() : null;
}

function spawnCheck(args: string[]): boolean {
  try {
    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    return result.exitCode === 0;
  } catch { return false; }
}

// ─── helpers (fix) ────────────────────────────────────────────────────────────

/** sudo -n <args>; возвращает { ok, msg } */
function sudoRun(args: string[]): FixResult {
  try {
    const result = Bun.spawnSync(['sudo', '-n', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const out = new TextDecoder().decode(result.stdout).trim();
    const err = new TextDecoder().decode(result.stderr).trim();
    if (result.exitCode === 0) return { ok: true, msg: out || 'Применено' };
    if (err.includes('password is required') || err.includes('a password'))
      return { ok: false, msg: 'Требуется sudo. Запустите: sudo mycode' };
    return { ok: false, msg: err || out || `exit ${result.exitCode}` };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  }
}

/** Записать content в file через sudo tee (создаёт или перезаписывает) */
function writeSudo(file: string, content: string): FixResult {
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
        msg: err.includes('password') ? 'Требуется sudo. Запустите: sudo mycode' : err,
      };
    }
    return { ok: true, msg: 'Применено' };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  }
}

/**
 * В файле заменяет первую строку, совпавшую с pattern, на newLine.
 * Если совпадений нет — добавляет newLine в конец.
 */
function fixConfigLine(file: string, pattern: RegExp, newLine: string): FixResult {
  const content = readFile(file) ?? '';
  let replaced = false;
  const lines = content.split('\n').map(l => {
    if (!replaced && pattern.test(l)) { replaced = true; return newLine; }
    return l;
  });
  const newContent = replaced
    ? lines.join('\n')
    : content.trimEnd() + '\n' + newLine + '\n';
  return writeSudo(file, newContent);
}

function restartSshd(): FixResult {
  const r = sudoRun(['systemctl', 'restart', 'sshd']);
  if (r.ok) return { ok: true, msg: 'sshd перезапущен' };
  const r2 = sudoRun(['systemctl', 'restart', 'ssh']);
  return r2.ok
    ? { ok: true, msg: 'ssh перезапущен' }
    : { ok: false, msg: 'Настройка записана. Перезапустите SSH вручную.' };
}

function fixSshDirective(key: string, value: string): FixResult {
  const r = fixConfigLine(
    '/etc/ssh/sshd_config',
    new RegExp(`^#*\\s*${key}\\s`, 'i'),
    `${key} ${value}`,
  );
  if (!r.ok) return r;
  const rs = restartSshd();
  return { ok: rs.ok, msg: `${key} ${value}  —  ${rs.msg}` };
}

function fixSysctl(param: string, value: string): FixResult {
  // Применяем немедленно
  const r1 = sudoRun(['sysctl', '-w', `${param}=${value}`]);
  if (!r1.ok) return r1;
  // Сохраняем в sysctl.conf
  const r2 = fixConfigLine(
    '/etc/sysctl.conf',
    new RegExp(`^#*\\s*${param.replace(/\./g, '\\.')}\\s*=`),
    `${param} = ${value}`,
  );
  return r2.ok
    ? { ok: true, msg: `${param} = ${value}` }
    : { ok: true, msg: `${param} = ${value} (временно; sysctl.conf недоступен)` };
}

// ─── checks ───────────────────────────────────────────────────────────────────

function checkSshPermitRoot(): CheckStatus {
  const content = readFile('/etc/ssh/sshd_config');
  if (!content) return 'unknown';
  const val = sshConfigValue(content, 'PermitRootLogin');
  if (!val) return 'warn';
  return val === 'no' || val === 'prohibit-password' ? 'pass' : 'fail';
}

function checkSshPasswordAuth(): CheckStatus {
  const content = readFile('/etc/ssh/sshd_config');
  if (!content) return 'unknown';
  const val = sshConfigValue(content, 'PasswordAuthentication');
  if (!val) return 'warn';
  return val === 'no' ? 'pass' : 'fail';
}

function checkSshMaxAuthTries(): CheckStatus {
  const content = readFile('/etc/ssh/sshd_config');
  if (!content) return 'unknown';
  const val = sshConfigValue(content, 'MaxAuthTries');
  if (!val) return 'warn';
  const n = parseInt(val, 10);
  if (isNaN(n)) return 'unknown';
  return n <= 5 ? 'pass' : 'fail';
}

function checkPamMinLen(): CheckStatus {
  const pwq = readFile('/etc/security/pwquality.conf');
  if (pwq) {
    const m = pwq.match(/^\s*minlen\s*=\s*(\d+)/im);
    if (m) return parseInt(m[1], 10) >= 8 ? 'pass' : 'fail';
  }
  const common = readFile('/etc/pam.d/common-password');
  if (common) {
    const m = common.match(/minlen=(\d+)/i);
    if (m) return parseInt(m[1], 10) >= 8 ? 'pass' : 'fail';
  }
  return 'unknown';
}

function checkPamPwquality(): CheckStatus {
  const common = readFile('/etc/pam.d/common-password');
  if (!common) return 'unknown';
  return /pam_pwquality|pam_cracklib/.test(common) ? 'pass' : 'fail';
}

function checkFirewalld(): CheckStatus {
  if (!spawnCheck(['which', 'firewall-cmd'])) return 'unknown';
  return spawnCheck(['systemctl', 'is-active', '--quiet', 'firewalld']) ? 'pass' : 'fail';
}

function checkAuditd(): CheckStatus {
  if (existsSync('/var/run/auditd.pid')) return 'pass';
  if (!spawnCheck(['which', 'systemctl'])) return 'unknown';
  return spawnCheck(['systemctl', 'is-active', '--quiet', 'auditd']) ? 'pass' : 'fail';
}

function checkUsbBlocked(): CheckStatus {
  const dirs = ['/etc/modprobe.d'];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const file of readdirSync(dir)) {
        const content = readFile(join(dir, file));
        if (!content) continue;
        if (/^(blacklist|install)\s+usb[-_]storage/im.test(content)) return 'pass';
      }
    } catch { /* ignore */ }
  }
  return 'fail';
}

function checkKernelAslr(): CheckStatus {
  const val = readFile('/proc/sys/kernel/randomize_va_space')?.trim();
  if (!val) return 'unknown';
  return val === '2' ? 'pass' : (val === '1' ? 'warn' : 'fail');
}

function checkKernelSynCookies(): CheckStatus {
  const val = readFile('/proc/sys/net/ipv4/tcp_syncookies')?.trim();
  if (!val) return 'unknown';
  return val === '1' ? 'pass' : 'fail';
}

// ─── public API ───────────────────────────────────────────────────────────────

export function buildChecks(): CheckItem[] {
  return [
    {
      id: 'ssh-root',
      category: 'SSH',
      title: 'PermitRootLogin = no / prohibit-password',
      hint: 'Установите: PermitRootLogin no  в /etc/ssh/sshd_config',
      check: checkSshPermitRoot,
      fix: () => fixSshDirective('PermitRootLogin', 'no'),
    },
    {
      id: 'ssh-passauth',
      category: 'SSH',
      title: 'PasswordAuthentication = no',
      hint: 'Установите: PasswordAuthentication no  в /etc/ssh/sshd_config',
      check: checkSshPasswordAuth,
      fix: () => {
        const r = fixSshDirective('PasswordAuthentication', 'no');
        return r.ok
          ? { ok: true, msg: r.msg + '\n⚠ Убедитесь, что SSH-ключи настроены!' }
          : r;
      },
    },
    {
      id: 'ssh-maxauth',
      category: 'SSH',
      title: 'MaxAuthTries ≤ 5',
      hint: 'Установите: MaxAuthTries 3  в /etc/ssh/sshd_config',
      check: checkSshMaxAuthTries,
      fix: () => fixSshDirective('MaxAuthTries', '3'),
    },
    {
      id: 'pam-minlen',
      category: 'PAM / Пароли',
      title: 'Минимальная длина пароля ≥ 8',
      hint: 'Установите minlen = 8  в /etc/security/pwquality.conf',
      check: checkPamMinLen,
      fix: () => fixConfigLine(
        '/etc/security/pwquality.conf',
        /^#*\s*minlen\s*=/,
        'minlen = 8',
      ),
    },
    {
      id: 'pam-pwquality',
      category: 'PAM / Пароли',
      title: 'pam_pwquality или pam_cracklib подключён',
      hint: 'Добавьте в /etc/pam.d/common-password: password requisite pam_pwquality.so',
      check: checkPamPwquality,
      // Нет автофикса — изменение PAM без проверки может заблокировать вход
    },
    {
      id: 'firewall',
      category: 'Firewall',
      title: 'firewalld активен',
      hint: 'Запустите: sudo systemctl enable --now firewalld',
      check: checkFirewalld,
      fix: () => sudoRun(['systemctl', 'enable', '--now', 'firewalld']),
    },
    {
      id: 'auditd',
      category: 'auditd',
      title: 'Служба auditd запущена',
      hint: 'Установите и запустите: apt install auditd && systemctl enable --now auditd',
      check: checkAuditd,
      fix: () => sudoRun(['systemctl', 'enable', '--now', 'auditd']),
    },
    {
      id: 'usb-blocked',
      category: 'USB',
      title: 'usb-storage заблокирован в modprobe',
      hint: 'Добавьте в /etc/modprobe.d/usb-block.conf: blacklist usb-storage',
      check: checkUsbBlocked,
      fix: () => writeSudo(
        '/etc/modprobe.d/usb-block.conf',
        'blacklist usb-storage\ninstall usb-storage /bin/false\n',
      ),
    },
    {
      id: 'kernel-aslr',
      category: 'Ядро',
      title: 'ASLR включён (randomize_va_space = 2)',
      hint: 'Добавьте в /etc/sysctl.conf: kernel.randomize_va_space = 2',
      check: checkKernelAslr,
      fix: () => fixSysctl('kernel.randomize_va_space', '2'),
    },
    {
      id: 'kernel-syncookies',
      category: 'Ядро',
      title: 'SYN-cookies включены (tcp_syncookies = 1)',
      hint: 'Добавьте в /etc/sysctl.conf: net.ipv4.tcp_syncookies = 1',
      check: checkKernelSynCookies,
      fix: () => fixSysctl('net.ipv4.tcp_syncookies', '1'),
    },
  ];
}

export function statusIcon(s: CheckStatus): string {
  switch (s) {
    case 'pass':    return '✓';
    case 'fail':    return '✗';
    case 'warn':    return '⚠';
    case 'unknown': return '?';
  }
}

export function statusColor(s: CheckStatus): TextColor {
  switch (s) {
    case 'pass':    return 'green';
    case 'fail':    return 'red';
    case 'warn':    return 'yellow';
    case 'unknown': return 'gray';
  }
}
