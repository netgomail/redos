import { readFile } from '../utils/fs';

interface AuditSection {
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

function spawnLines(args: string[], limit = 20): string[] {
  const out = spawn(args);
  if (!out) return [];
  return out.split('\n').filter(l => l.trim()).slice(0, limit);
}

// ─── sections ─────────────────────────────────────────────────────────────────

function sectionUsers(): AuditSection {
  const lines: string[] = [];
  const passwd = readFile('/etc/passwd');
  if (!passwd) return { title: 'Пользователи', lines: ['Не удалось прочитать /etc/passwd'] };

  const users = passwd.split('\n')
    .filter(l => l.trim())
    .map(l => l.split(':'))
    .filter(p => parseInt(p[2] ?? '0', 10) >= 1000 && p[0] !== 'nobody' && p[0] !== 'nfsnobody');

  if (users.length === 0) {
    lines.push('Нет пользователей с UID ≥ 1000');
  } else {
    for (const p of users) {
      const shell = p[6] ?? '/bin/bash';
      const nologin = shell.includes('nologin') || shell.includes('false');
      lines.push(
        `  ${p[0].padEnd(16)} uid=${p[2].padEnd(6)} ${p[5] ?? ''}  shell=${shell}` +
        (nologin ? '  [нет входа]' : ''),
      );
    }
  }

  // Проверка UID 0 (кроме root)
  const uid0 = passwd.split('\n')
    .filter(l => l.trim())
    .map(l => l.split(':'))
    .filter(p => p[2] === '0' && p[0] !== 'root');

  if (uid0.length > 0) {
    lines.push('');
    lines.push('⚠ Пользователи с UID 0 (кроме root):');
    for (const p of uid0) lines.push(`  ✗ ${p[0]}`);
  }

  return { title: 'Пользователи (UID ≥ 1000)', lines };
}

function sectionPasswords(): AuditSection {
  const lines: string[] = [];
  const shadow = readFile('/etc/shadow');
  if (!shadow) return { title: 'Пароли', lines: ['Не удалось прочитать /etc/shadow (нужен root)'] };

  const now = Math.floor(Date.now() / 86400000); // дней с epoch

  const entries = shadow.split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split(':'))
    .filter(p => {
      const hash = p[1] ?? '';
      // Пропускаем заблокированные и системные
      return !hash.startsWith('!') && hash !== '*' && hash !== '!!' && hash.length > 2;
    });

  // Пустые пароли
  const emptyPw = shadow.split('\n')
    .filter(l => l.trim())
    .map(l => l.split(':'))
    .filter(p => p[1] === '' || p[1] === '::');

  if (emptyPw.length > 0) {
    lines.push('✗ Пользователи с пустым паролем:');
    for (const p of emptyPw) lines.push(`    ${p[0]}`);
    lines.push('');
  } else {
    lines.push('✓ Нет пользователей с пустым паролем');
  }

  // Возраст паролей
  const aged: string[] = [];
  for (const p of entries) {
    const lastChange = parseInt(p[2] ?? '0', 10);
    if (!lastChange || lastChange === 0) continue;
    const ageDays = now - lastChange;
    const maxDays = parseInt(p[4] ?? '99999', 10);
    const user = p[0];

    if (ageDays > 90) {
      aged.push(`  ⚠ ${user.padEnd(16)} пароль ${ageDays} дн. назад` +
        (maxDays < 99999 ? ` (макс. ${maxDays} дн.)` : ' (без ограничения)'));
    }
  }

  if (aged.length > 0) {
    lines.push(`⚠ Пароли старше 90 дней (${aged.length}):`);
    lines.push(...aged);
  } else {
    lines.push('✓ Все пароли моложе 90 дней');
  }

  return { title: 'Анализ паролей', lines };
}

function sectionWheel(): AuditSection {
  const lines: string[] = [];
  const group = readFile('/etc/group');
  if (!group) return { title: 'Группа wheel (sudo)', lines: ['Не удалось прочитать /etc/group'] };

  const wheelLine = group.split('\n').find(l => l.startsWith('wheel:'));
  if (!wheelLine) {
    lines.push('⚠ Группа wheel не найдена');
  } else {
    const members = wheelLine.split(':')[3]?.split(',').filter(Boolean) ?? [];
    if (members.length === 0) {
      lines.push('Нет пользователей в группе wheel');
    } else {
      lines.push(`Члены группы wheel (${members.length}):`);
      for (const m of members) lines.push(`  • ${m}`);
    }
  }

  // Также проверяем sudoers.d
  const sudoersLines = spawnLines(['find', '/etc/sudoers.d', '-type', 'f', '-name', '*'], 10);
  if (sudoersLines.length > 0) {
    lines.push('');
    lines.push(`Файлы в /etc/sudoers.d (${sudoersLines.length}):`);
    for (const f of sudoersLines) lines.push(`  • ${f}`);
  }

  return { title: 'Привилегированный доступ (wheel/sudo)', lines };
}

function sectionSuid(): AuditSection {
  const lines: string[] = [];

  const suid = spawnLines(
    ['find', '/', '-perm', '-4000', '-type', 'f',
     '-not', '-path', '/proc/*', '-not', '-path', '/sys/*'],
    25,
  );

  if (suid.length > 0) {
    lines.push(`SUID-файлы (${suid.length}, топ-25):`);
    for (const f of suid) lines.push(`  • ${f}`);
  } else {
    lines.push('✓ SUID-файлы не найдены');
  }

  lines.push('');

  const sgid = spawnLines(
    ['find', '/', '-perm', '-2000', '-type', 'f',
     '-not', '-path', '/proc/*', '-not', '-path', '/sys/*'],
    25,
  );

  if (sgid.length > 0) {
    lines.push(`SGID-файлы (${sgid.length}, топ-25):`);
    for (const f of sgid) lines.push(`  • ${f}`);
  } else {
    lines.push('✓ SGID-файлы не найдены');
  }

  return { title: 'SUID/SGID файлы', lines };
}

function sectionWorldWritable(): AuditSection {
  const lines: string[] = [];

  const dirs = spawnLines(
    ['find', '/', '-type', 'd', '-perm', '-0002',
     '-not', '-path', '/proc/*', '-not', '-path', '/sys/*',
     '-not', '-path', '/dev/*', '-not', '-path', '/run/*'],
    20,
  );

  if (dirs.length > 0) {
    lines.push(`World-writable директории (${dirs.length}, топ-20):`);
    for (const d of dirs) lines.push(`  ⚠ ${d}`);
  } else {
    lines.push('✓ World-writable директории не найдены');
  }

  return { title: 'World-writable', lines };
}

function sectionOrphanFiles(): AuditSection {
  const lines: string[] = [];

  const orphans = spawnLines(
    ['find', '/', '-nouser', '-o', '-nogroup',
     '-not', '-path', '/proc/*', '-not', '-path', '/sys/*'],
    20,
  );

  if (orphans.length > 0) {
    lines.push(`Файлы без владельца (${orphans.length}, топ-20):`);
    for (const f of orphans) lines.push(`  ⚠ ${f}`);
  } else {
    lines.push('✓ Нет файлов без владельца');
  }

  return { title: 'Файлы без владельца', lines };
}

function sectionMountOptions(): AuditSection {
  const lines: string[] = [];
  const mounts = readFile('/proc/mounts') ?? '';

  const critical = ['/tmp', '/var/tmp', '/dev/shm'];
  const requiredOpts = ['nosuid', 'noexec', 'nodev'];

  for (const mp of critical) {
    const line = mounts.split('\n').find(l => l.split(' ')[1] === mp);
    if (!line) {
      lines.push(`⚠ ${mp} — не является отдельным разделом`);
      continue;
    }
    const opts = line.split(' ')[3] ?? '';
    const missing = requiredOpts.filter(o => !opts.includes(o));
    if (missing.length === 0) {
      lines.push(`✓ ${mp} — ${requiredOpts.join(',')}`);
    } else {
      lines.push(`✗ ${mp} — отсутствуют: ${missing.join(', ')}`);
    }
  }

  return { title: 'Опции монтирования', lines };
}

// ─── public API ───────────────────────────────────────────────────────────────

export function runAudit(): AuditSection[] {
  return [
    sectionUsers(),
    sectionPasswords(),
    sectionWheel(),
    sectionSuid(),
    sectionWorldWritable(),
    sectionOrphanFiles(),
    sectionMountOptions(),
  ];
}

export function formatAudit(sections: AuditSection[]): string {
  const lines: string[] = [
    '=== Аудит безопасности ===',
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
