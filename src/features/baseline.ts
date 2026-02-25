import { existsSync, readdirSync, statSync } from 'fs';
import { readFile } from '../utils/fs';
import type { TextColor } from '../types';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';
export type FixResult = { ok: boolean; msg: string };

export interface BaselineItem {
  id: string;
  category: string;
  title: string;
  hint: string;
  check: () => CheckStatus;
  fix?: () => FixResult;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function spawn(args: string[]): string {
  try {
    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    return new TextDecoder().decode(result.stdout).trim();
  } catch { return ''; }
}

function spawnOk(args: string[]): boolean {
  try {
    return Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0;
  } catch { return false; }
}

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

function writeSudo(file: string, content: string): FixResult {
  try {
    const proc = Bun.spawnSync(['sudo', '-n', 'tee', file], {
      stdin: new TextEncoder().encode(content),
      stdout: 'pipe', stderr: 'pipe',
    });
    if (proc.exitCode !== 0) {
      const err = new TextDecoder().decode(proc.stderr).trim();
      return { ok: false, msg: err.includes('password') ? 'Требуется sudo' : err };
    }
    return { ok: true, msg: 'Применено' };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  }
}

function sysctlValue(param: string): string | null {
  const out = spawn(['sysctl', '-n', param]);
  return out || null;
}

function fixSysctl(param: string, value: string): FixResult {
  const r1 = sudoRun(['sysctl', '-w', `${param}=${value}`]);
  if (!r1.ok) return r1;
  // Persist
  const file = '/etc/sysctl.d/99-baseline.conf';
  const content = readFile(file) ?? '';
  const line = `${param} = ${value}`;
  const re = new RegExp(`^#*\\s*${param.replace(/\./g, '\\.')}\\s*=.*`, 'm');
  const newContent = re.test(content)
    ? content.replace(re, line)
    : content.trimEnd() + '\n' + line + '\n';
  writeSudo(file, newContent);
  return { ok: true, msg: `${param} = ${value}` };
}

function isModuleLoaded(mod: string): boolean {
  return spawn(['lsmod']).split('\n').some(l => l.startsWith(mod + ' '));
}

function isModuleBlacklisted(mod: string): boolean {
  try {
    const files = readdirSync('/etc/modprobe.d');
    for (const f of files) {
      const content = readFile(`/etc/modprobe.d/${f}`);
      if (content && new RegExp(`^(blacklist|install)\\s+${mod}`, 'im').test(content)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

function rpmInstalled(pkg: string): boolean {
  return spawnOk(['rpm', '-q', pkg]);
}

function serviceActive(name: string): boolean {
  return spawnOk(['systemctl', 'is-active', '--quiet', name]);
}

function filePerms(path: string): number | null {
  try {
    return statSync(path).mode & 0o7777;
  } catch { return null; }
}

function mountHasOpt(mountpoint: string, opt: string): boolean {
  const mounts = readFile('/proc/mounts') ?? '';
  const line = mounts.split('\n').find(l => l.split(' ')[1] === mountpoint);
  if (!line) return false;
  return (line.split(' ')[3] ?? '').includes(opt);
}

function isSeparateMount(mountpoint: string): boolean {
  const mounts = readFile('/proc/mounts') ?? '';
  return mounts.split('\n').some(l => l.split(' ')[1] === mountpoint);
}

// ─── checks ───────────────────────────────────────────────────────────────────

export function buildBaselineChecks(): BaselineItem[] {
  return [
    // ── Файловые системы ──
    {
      id: 'fs-tmp-separate',
      category: 'Файловые системы',
      title: '/tmp — отдельный раздел с noexec,nosuid,nodev',
      hint: 'Выделите /tmp в отдельный раздел. Добавьте noexec,nosuid,nodev в /etc/fstab',
      check: () => {
        if (!isSeparateMount('/tmp')) return 'fail';
        const missing = ['noexec', 'nosuid', 'nodev'].filter(o => !mountHasOpt('/tmp', o));
        return missing.length === 0 ? 'pass' : 'warn';
      },
    },
    {
      id: 'fs-vartmp',
      category: 'Файловые системы',
      title: '/var/tmp — отдельный раздел или bind-mount',
      hint: 'Выделите /var/tmp в отдельный раздел или смонтируйте bind к /tmp',
      check: () => isSeparateMount('/var/tmp') ? 'pass' : 'warn',
    },
    {
      id: 'fs-cramfs',
      category: 'Файловые системы',
      title: 'cramfs, squashfs, udf заблокированы',
      hint: 'Добавьте blacklist в /etc/modprobe.d/ и install <mod> /bin/false',
      check: () => {
        const mods = ['cramfs', 'squashfs', 'udf'];
        const loaded = mods.filter(m => isModuleLoaded(m));
        if (loaded.length > 0) return 'fail';
        const blocked = mods.filter(m => isModuleBlacklisted(m));
        return blocked.length === mods.length ? 'pass' : 'warn';
      },
      fix: () => {
        const mods = ['cramfs', 'squashfs', 'udf'];
        const lines = mods.flatMap(m => [`blacklist ${m}`, `install ${m} /bin/false`]);
        return writeSudo('/etc/modprobe.d/cis-filesystem.conf', lines.join('\n') + '\n');
      },
    },

    // ── Сервисы ──
    {
      id: 'svc-xinetd',
      category: 'Сервисы',
      title: 'xinetd не установлен',
      hint: 'Удалите: dnf remove xinetd',
      check: () => rpmInstalled('xinetd') ? 'fail' : 'pass',
    },
    {
      id: 'svc-chrony',
      category: 'Сервисы',
      title: 'chronyd настроен (синхронизация времени)',
      hint: 'Установите и запустите: dnf install chrony && systemctl enable --now chronyd',
      check: () => {
        if (serviceActive('chronyd')) return 'pass';
        if (serviceActive('ntpd')) return 'pass';
        return 'fail';
      },
      fix: () => sudoRun(['systemctl', 'enable', '--now', 'chronyd']),
    },
    {
      id: 'svc-avahi',
      category: 'Сервисы',
      title: 'avahi-daemon отключён',
      hint: 'Отключите: systemctl disable --now avahi-daemon',
      check: () => serviceActive('avahi-daemon') ? 'fail' : 'pass',
      fix: () => sudoRun(['systemctl', 'disable', '--now', 'avahi-daemon']),
    },
    {
      id: 'svc-cups',
      category: 'Сервисы',
      title: 'cups отключён (если не нужен)',
      hint: 'Отключите: systemctl disable --now cups',
      check: () => serviceActive('cups') ? 'warn' : 'pass',
      fix: () => sudoRun(['systemctl', 'disable', '--now', 'cups']),
    },
    {
      id: 'svc-unnecessary',
      category: 'Сервисы',
      title: 'Ненужные сетевые сервисы отключены',
      hint: 'Проверьте: dhcpd, named, vsftpd, httpd, dovecot, smb, squid',
      check: () => {
        const svcs = ['dhcpd', 'named', 'vsftpd', 'httpd', 'dovecot', 'smb', 'squid'];
        const active = svcs.filter(s => serviceActive(s));
        return active.length === 0 ? 'pass' : 'warn';
      },
    },

    // ── Сеть ──
    {
      id: 'net-ipforward',
      category: 'Сеть',
      title: 'IP forwarding отключён',
      hint: 'Установите: net.ipv4.ip_forward = 0 в sysctl',
      check: () => sysctlValue('net.ipv4.ip_forward') === '0' ? 'pass' : 'fail',
      fix: () => fixSysctl('net.ipv4.ip_forward', '0'),
    },
    {
      id: 'net-icmp-redirect',
      category: 'Сеть',
      title: 'ICMP redirects отключены',
      hint: 'Установите: net.ipv4.conf.all.accept_redirects = 0',
      check: () => {
        const v1 = sysctlValue('net.ipv4.conf.all.accept_redirects');
        const v2 = sysctlValue('net.ipv4.conf.default.accept_redirects');
        return v1 === '0' && v2 === '0' ? 'pass' : 'fail';
      },
      fix: () => {
        fixSysctl('net.ipv4.conf.all.accept_redirects', '0');
        return fixSysctl('net.ipv4.conf.default.accept_redirects', '0');
      },
    },
    {
      id: 'net-source-route',
      category: 'Сеть',
      title: 'Source routing отключён',
      hint: 'Установите: net.ipv4.conf.all.accept_source_route = 0',
      check: () => {
        const v1 = sysctlValue('net.ipv4.conf.all.accept_source_route');
        const v2 = sysctlValue('net.ipv4.conf.default.accept_source_route');
        return v1 === '0' && v2 === '0' ? 'pass' : 'fail';
      },
      fix: () => {
        fixSysctl('net.ipv4.conf.all.accept_source_route', '0');
        return fixSysctl('net.ipv4.conf.default.accept_source_route', '0');
      },
    },
    {
      id: 'net-syncookies',
      category: 'Сеть',
      title: 'TCP SYN cookies включены',
      hint: 'Установите: net.ipv4.tcp_syncookies = 1',
      check: () => sysctlValue('net.ipv4.tcp_syncookies') === '1' ? 'pass' : 'fail',
      fix: () => fixSysctl('net.ipv4.tcp_syncookies', '1'),
    },

    // ── Аудит и логирование ──
    {
      id: 'audit-auditd',
      category: 'Аудит',
      title: 'auditd запущен и включён',
      hint: 'Запустите: systemctl enable --now auditd',
      check: () => {
        if (!serviceActive('auditd')) return 'fail';
        return spawnOk(['systemctl', 'is-enabled', '--quiet', 'auditd']) ? 'pass' : 'warn';
      },
      fix: () => sudoRun(['systemctl', 'enable', '--now', 'auditd']),
    },
    {
      id: 'audit-rules-identity',
      category: 'Аудит',
      title: 'Аудит изменений /etc/passwd, /etc/shadow, /etc/group',
      hint: 'Добавьте правила в /etc/audit/rules.d/identity.rules',
      check: () => {
        const rules = spawn(['auditctl', '-l']);
        if (!rules) return 'unknown';
        const watchFiles = ['/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow'];
        const covered = watchFiles.filter(f => rules.includes(f));
        return covered.length === watchFiles.length ? 'pass' :
               covered.length > 0 ? 'warn' : 'fail';
      },
      fix: () => {
        const rules = [
          '-w /etc/passwd -p wa -k identity',
          '-w /etc/shadow -p wa -k identity',
          '-w /etc/group -p wa -k identity',
          '-w /etc/gshadow -p wa -k identity',
        ].join('\n') + '\n';
        const r = writeSudo('/etc/audit/rules.d/identity.rules', rules);
        if (!r.ok) return r;
        sudoRun(['augenrules', '--load']);
        return { ok: true, msg: 'Правила аудита добавлены' };
      },
    },
    {
      id: 'audit-rsyslog',
      category: 'Аудит',
      title: 'rsyslog запущен',
      hint: 'Запустите: systemctl enable --now rsyslog',
      check: () => serviceActive('rsyslog') ? 'pass' : 'fail',
      fix: () => sudoRun(['systemctl', 'enable', '--now', 'rsyslog']),
    },

    // ── Доступ и аутентификация ──
    {
      id: 'auth-pwquality',
      category: 'Аутентификация',
      title: 'Парольная политика: minlen ≥ 8, minclass ≥ 3',
      hint: 'Настройте /etc/security/pwquality.conf: minlen = 8, minclass = 3',
      check: () => {
        const pwq = readFile('/etc/security/pwquality.conf');
        if (!pwq) return 'unknown';
        const minlen = pwq.match(/^\s*minlen\s*=\s*(\d+)/im)?.[1];
        const minclass = pwq.match(/^\s*minclass\s*=\s*(\d+)/im)?.[1];
        const lenOk = minlen && parseInt(minlen, 10) >= 8;
        const classOk = minclass && parseInt(minclass, 10) >= 3;
        return lenOk && classOk ? 'pass' : (lenOk || classOk ? 'warn' : 'fail');
      },
    },
    {
      id: 'auth-faillock',
      category: 'Аутентификация',
      title: 'Блокировка после неудачных попыток (pam_faillock)',
      hint: 'Настройте faillock: deny = 5, unlock_time = 900',
      check: () => {
        const systemAuth = readFile('/etc/pam.d/system-auth');
        const passwordAuth = readFile('/etc/pam.d/password-auth');
        const content = (systemAuth ?? '') + (passwordAuth ?? '');
        return content.includes('pam_faillock') ? 'pass' : 'fail';
      },
    },
    {
      id: 'auth-tmout',
      category: 'Аутентификация',
      title: 'Таймаут сессии (TMOUT ≤ 900)',
      hint: 'Добавьте TMOUT=900 в /etc/profile.d/tmout.sh',
      check: () => {
        const files = ['/etc/profile', '/etc/bashrc',
          ...(() => {
            try { return readdirSync('/etc/profile.d').map(f => `/etc/profile.d/${f}`); }
            catch { return []; }
          })(),
        ];
        for (const f of files) {
          const content = readFile(f);
          if (content) {
            const m = content.match(/^\s*(?:export\s+)?TMOUT\s*=\s*(\d+)/im);
            if (m && parseInt(m[1], 10) <= 900) return 'pass';
          }
        }
        return 'fail';
      },
      fix: () => writeSudo('/etc/profile.d/tmout.sh',
        'readonly TMOUT=900\nexport TMOUT\n'),
    },
    {
      id: 'auth-umask',
      category: 'Аутентификация',
      title: 'Umask ≥ 027',
      hint: 'Установите umask 027 в /etc/bashrc и /etc/profile',
      check: () => {
        const bashrc = readFile('/etc/bashrc') ?? '';
        const profile = readFile('/etc/profile') ?? '';
        const content = bashrc + profile;
        const m = content.match(/^\s*umask\s+(\d+)/im);
        if (!m) return 'warn';
        const val = parseInt(m[1], 8);
        return val >= 0o027 ? 'pass' : 'fail';
      },
    },

    // ── Права файлов ──
    {
      id: 'perms-passwd',
      category: 'Права файлов',
      title: '/etc/passwd — 644, /etc/shadow — 000 или 640',
      hint: 'chmod 644 /etc/passwd; chmod 000 /etc/shadow',
      check: () => {
        const passwdPerms = filePerms('/etc/passwd');
        const shadowPerms = filePerms('/etc/shadow');
        if (passwdPerms === null || shadowPerms === null) return 'unknown';
        const passwdOk = passwdPerms <= 0o644;
        const shadowOk = shadowPerms <= 0o640;
        return passwdOk && shadowOk ? 'pass' : 'fail';
      },
      fix: () => {
        sudoRun(['chmod', '644', '/etc/passwd']);
        return sudoRun(['chmod', '000', '/etc/shadow']);
      },
    },
    {
      id: 'perms-group',
      category: 'Права файлов',
      title: '/etc/group — 644, /etc/gshadow — 000 или 640',
      hint: 'chmod 644 /etc/group; chmod 000 /etc/gshadow',
      check: () => {
        const groupPerms = filePerms('/etc/group');
        const gshadowPerms = filePerms('/etc/gshadow');
        if (groupPerms === null || gshadowPerms === null) return 'unknown';
        return groupPerms <= 0o644 && gshadowPerms <= 0o640 ? 'pass' : 'fail';
      },
      fix: () => {
        sudoRun(['chmod', '644', '/etc/group']);
        return sudoRun(['chmod', '000', '/etc/gshadow']);
      },
    },
    {
      id: 'perms-sshd-config',
      category: 'Права файлов',
      title: '/etc/ssh/sshd_config — 600',
      hint: 'chmod 600 /etc/ssh/sshd_config',
      check: () => {
        const perms = filePerms('/etc/ssh/sshd_config');
        if (perms === null) return 'unknown';
        return perms <= 0o600 ? 'pass' : 'fail';
      },
      fix: () => sudoRun(['chmod', '600', '/etc/ssh/sshd_config']),
    },
    {
      id: 'perms-crontab',
      category: 'Права файлов',
      title: '/etc/crontab — 600, cron-директории — 700',
      hint: 'chmod 600 /etc/crontab; chmod 700 /etc/cron.*',
      check: () => {
        const crontab = filePerms('/etc/crontab');
        if (crontab === null) return 'unknown';
        if (crontab > 0o600) return 'fail';
        const cronDirs = ['/etc/cron.d', '/etc/cron.daily', '/etc/cron.hourly',
          '/etc/cron.monthly', '/etc/cron.weekly'];
        for (const d of cronDirs) {
          const p = filePerms(d);
          if (p !== null && p > 0o700) return 'fail';
        }
        return 'pass';
      },
      fix: () => {
        sudoRun(['chmod', '600', '/etc/crontab']);
        const dirs = ['cron.d', 'cron.daily', 'cron.hourly', 'cron.monthly', 'cron.weekly'];
        for (const d of dirs) sudoRun(['chmod', '700', `/etc/${d}`]);
        return { ok: true, msg: 'Права установлены' };
      },
    },
  ];
}

// ─── public API ───────────────────────────────────────────────────────────────

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
