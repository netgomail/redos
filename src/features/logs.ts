import { readFile } from '../utils/fs';

interface LogSection {
  title: string;
  lines: string[];
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function spawn(args: string[]): string {
  try {
    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    return new TextDecoder().decode(result.stdout).trim();
  } catch { return ''; }
}

function grepFile(file: string, pattern: RegExp, limit = 50): string[] {
  const content = readFile(file);
  if (!content) return [];
  return content.split('\n')
    .filter(l => pattern.test(l))
    .slice(-limit); // берём последние N строк
}

// ─── sections ─────────────────────────────────────────────────────────────────

function sectionFailedSSH(): LogSection {
  const lines: string[] = [];

  // РедОС/RHEL: /var/log/secure
  const logFile = '/var/log/secure';
  const failed = grepFile(logFile, /Failed password/i, 100);

  if (failed.length === 0) {
    lines.push('✓ Нет записей о неудачных SSH-входах');
    lines.push(`  (источник: ${logFile})`);
    return { title: 'Неудачные SSH-входы', lines };
  }

  // Агрегация по IP
  const ipCount = new Map<string, number>();
  for (const line of failed) {
    const m = line.match(/from\s+(\S+)/);
    if (m) ipCount.set(m[1], (ipCount.get(m[1]) ?? 0) + 1);
  }

  const sorted = [...ipCount.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 10);

  lines.push(`Всего неудачных попыток: ${failed.length}`);
  lines.push('');
  lines.push(`Топ-${top.length} IP по количеству попыток:`);
  for (const [ip, count] of top) {
    const bar = '█'.repeat(Math.min(count, 30));
    lines.push(`  ${ip.padEnd(18)} ${String(count).padStart(5)} ${bar}`);
  }

  // Последние 10 записей
  lines.push('');
  lines.push('Последние записи:');
  for (const l of failed.slice(-10)) {
    lines.push('  ' + l.trim());
  }

  return { title: 'Неудачные SSH-входы', lines };
}

function sectionAcceptedSSH(): LogSection {
  const lines: string[] = [];

  const accepted = grepFile('/var/log/secure', /Accepted\s+(password|publickey)/i, 20);

  if (accepted.length === 0) {
    lines.push('Нет записей об успешных SSH-входах');
    return { title: 'Успешные SSH-входы', lines };
  }

  lines.push(`Последние ${accepted.length} входов:`);
  for (const l of accepted) {
    lines.push('  ' + l.trim());
  }

  return { title: 'Успешные SSH-входы', lines };
}

function sectionSudo(): LogSection {
  const lines: string[] = [];

  const sudoOps = grepFile('/var/log/secure', /sudo:/i, 30);

  if (sudoOps.length === 0) {
    lines.push('Нет записей sudo');
    return { title: 'Операции sudo', lines };
  }

  lines.push(`Последние ${sudoOps.length} операций sudo:`);
  for (const l of sudoOps) {
    lines.push('  ' + l.trim());
  }

  return { title: 'Операции sudo', lines };
}

function sectionLockedAccounts(): LogSection {
  const lines: string[] = [];

  const locked = grepFile('/var/log/secure', /account.*locked|pam_faillock/i, 20);

  if (locked.length === 0) {
    lines.push('✓ Нет записей о блокировках аккаунтов');
  } else {
    lines.push(`Блокировки аккаунтов (${locked.length}):`);
    for (const l of locked) {
      lines.push('  ' + l.trim());
    }
  }

  return { title: 'Блокировки аккаунтов', lines };
}

function sectionCriticalEvents(): LogSection {
  const lines: string[] = [];

  const out = spawn([
    'journalctl', '-p', 'err', '--since', '24 hours ago',
    '--no-pager', '-n', '30', '--output=short',
  ]);

  if (!out || out.includes('No entries')) {
    lines.push('✓ Нет критических событий за последние 24 часа');
    return { title: 'Критические события (24ч)', lines };
  }

  const entries = out.split('\n').filter(l => l.trim()).slice(0, 30);
  lines.push(`Критические события (${entries.length}, последние 24ч):`);
  for (const l of entries) {
    lines.push('  ' + l.trim());
  }

  return { title: 'Критические события (24ч)', lines };
}

function sectionSelinuxDenials(): LogSection {
  const lines: string[] = [];

  const denials = grepFile('/var/log/audit/audit.log', /avc:.*denied/i, 20);

  if (denials.length === 0) {
    lines.push('✓ Нет SELinux denials в audit.log');
    return { title: 'SELinux denials', lines };
  }

  lines.push(`SELinux denials (${denials.length}):`);
  for (const l of denials) {
    // Извлекаем ключевую информацию: comm, name, scontext, tcontext
    const comm = l.match(/comm="([^"]+)"/)?.[1] ?? '';
    const name = l.match(/name="([^"]+)"/)?.[1] ?? '';
    const denied = l.match(/\{ ([^}]+) \}/)?.[1] ?? '';
    if (comm || name) {
      lines.push(`  ✗ ${comm} → ${name}  [${denied}]`);
    } else {
      lines.push('  ' + l.trim().slice(0, 120));
    }
  }

  return { title: 'SELinux denials', lines };
}

function sectionSummary(): LogSection {
  const lines: string[] = [];

  const failed = grepFile('/var/log/secure', /Failed password/i, 10000);
  const accepted = grepFile('/var/log/secure', /Accepted\s+(password|publickey)/i, 10000);
  const sudo = grepFile('/var/log/secure', /sudo:/i, 10000);

  lines.push(`Неудачных SSH-входов:    ${failed.length}`);
  lines.push(`Успешных SSH-входов:     ${accepted.length}`);
  lines.push(`Операций sudo:           ${sudo.length}`);

  return { title: 'Сводка', lines };
}

// ─── public API ───────────────────────────────────────────────────────────────

const LOG_STEPS: { label: string; fn: () => LogSection }[] = [
  { label: 'Сводка',                fn: sectionSummary },
  { label: 'Неудачные SSH-входы',   fn: sectionFailedSSH },
  { label: 'Успешные SSH-входы',    fn: sectionAcceptedSSH },
  { label: 'Операции sudo',         fn: sectionSudo },
  { label: 'Блокировки',           fn: sectionLockedAccounts },
  { label: 'Критические события',  fn: sectionCriticalEvents },
  { label: 'SELinux denials',       fn: sectionSelinuxDenials },
];

export async function runLogAnalysis(
  onProgress?: (step: number, total: number, label: string) => void,
): Promise<LogSection[]> {
  const sections: LogSection[] = [];
  for (let i = 0; i < LOG_STEPS.length; i++) {
    const { label, fn } = LOG_STEPS[i];
    onProgress?.(i + 1, LOG_STEPS.length, label);
    await new Promise(r => setTimeout(r, 0));
    sections.push(fn());
  }
  return sections;
}

export function formatLogs(sections: LogSection[]): string {
  const lines: string[] = [
    '=== Анализ логов безопасности ===',
    `Дата: ${new Date().toLocaleString('ru-RU')}`,
    `Хост: ${process.env.HOSTNAME ?? 'неизвестно'}`,
    '',
  ];
  for (const s of sections) {
    lines.push(`── ${s.title} ──`);
    lines.push(...s.lines.map(l => '  ' + l));
    lines.push('');
  }
  return lines.join('\n');
}
