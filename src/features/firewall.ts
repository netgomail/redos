interface FirewallSection {
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

function spawnOk(args: string[]): boolean {
  try {
    return Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0;
  } catch { return false; }
}

function spawnLines(args: string[], limit = 30): string[] {
  const out = spawn(args);
  if (!out) return [];
  return out.split('\n').filter(l => l.trim()).slice(0, limit);
}

// ─── sections ─────────────────────────────────────────────────────────────────

function sectionFirewalldStatus(): FirewallSection {
  const lines: string[] = [];

  const active = spawnOk(['systemctl', 'is-active', '--quiet', 'firewalld']);
  const enabled = spawnOk(['systemctl', 'is-enabled', '--quiet', 'firewalld']);

  if (active) {
    lines.push('✓ firewalld: активен' + (enabled ? ', включён в автозапуск' : ''));
  } else {
    lines.push('✗ firewalld: не запущен' + (enabled ? ' (но включён в автозапуск)' : ''));
    if (!spawnOk(['which', 'firewall-cmd'])) {
      lines.push('  firewall-cmd не найден — firewalld не установлен?');
    }
  }

  return { title: 'Статус firewalld', lines };
}

function sectionZones(): FirewallSection {
  const lines: string[] = [];

  const zonesOut = spawn(['firewall-cmd', '--get-active-zones']);
  if (!zonesOut) {
    lines.push('Нет активных зон (firewalld не запущен?)');
    return { title: 'Зоны firewalld', lines };
  }

  // Парсим вывод: имя зоны на отдельной строке, затем отступы с interfaces/sources
  const zoneNames: string[] = [];
  for (const line of zonesOut.split('\n')) {
    if (!line.startsWith(' ') && !line.startsWith('\t') && line.trim()) {
      zoneNames.push(line.trim());
    }
  }

  const defaultZone = spawn(['firewall-cmd', '--get-default-zone']);
  if (defaultZone) lines.push(`Зона по умолчанию: ${defaultZone}`);
  lines.push(`Активные зоны: ${zoneNames.join(', ') || 'нет'}`);
  lines.push('');

  for (const zone of zoneNames) {
    const detail = spawn(['firewall-cmd', '--zone=' + zone, '--list-all']);
    if (detail) {
      lines.push(`── ${zone} ──`);
      for (const dl of detail.split('\n')) {
        lines.push('  ' + dl);
      }
      lines.push('');
    }
  }

  return { title: 'Зоны firewalld', lines };
}

function sectionRichRules(): FirewallSection {
  const lines: string[] = [];

  const rules = spawnLines(['firewall-cmd', '--list-rich-rules'], 30);
  if (rules.length > 0) {
    lines.push(`Rich rules (${rules.length}):`);
    for (const r of rules) lines.push(`  • ${r}`);
  } else {
    lines.push('Нет rich rules');
  }

  return { title: 'Rich rules', lines };
}

function sectionPorts(): FirewallSection {
  const lines: string[] = [];

  const ssOut = spawnLines(['ss', '-tlnp'], 30);
  if (ssOut.length > 0) {
    lines.push('Прослушиваемые порты (ss -tlnp):');
    for (const l of ssOut) lines.push('  ' + l);
  } else {
    lines.push('Нет прослушиваемых портов');
  }

  return { title: 'Открытые порты', lines };
}

function sectionIptables(): FirewallSection {
  const lines: string[] = [];

  // Fallback: iptables если firewalld не запущен
  const active = spawnOk(['systemctl', 'is-active', '--quiet', 'firewalld']);
  if (active) {
    lines.push('firewalld активен — iptables управляется через firewalld');
    return { title: 'iptables', lines };
  }

  const rules = spawnLines(['iptables', '-L', '-n', '--line-numbers'], 40);
  if (rules.length > 0) {
    lines.push('Правила iptables:');
    for (const r of rules) lines.push('  ' + r);
  } else {
    lines.push('Нет правил iptables (или нет доступа)');
  }

  return { title: 'iptables (fallback)', lines };
}

function sectionSelinux(): FirewallSection {
  const lines: string[] = [];

  const enforce = spawn(['getenforce']);
  if (enforce) {
    const icon = enforce === 'Enforcing' ? '✓' : (enforce === 'Permissive' ? '⚠' : '✗');
    lines.push(`${icon} Режим SELinux: ${enforce}`);
  } else {
    lines.push('⚠ getenforce не найден — SELinux не установлен?');
  }

  const status = spawn(['sestatus']);
  if (status) {
    for (const l of status.split('\n').filter(l => l.trim())) {
      lines.push('  ' + l);
    }
  }

  return { title: 'SELinux', lines };
}

// ─── public API ───────────────────────────────────────────────────────────────

const FW_STEPS: { label: string; fn: () => FirewallSection }[] = [
  { label: 'Статус firewalld',  fn: sectionFirewalldStatus },
  { label: 'Зоны',             fn: sectionZones },
  { label: 'Rich rules',       fn: sectionRichRules },
  { label: 'Открытые порты',   fn: sectionPorts },
  { label: 'iptables',         fn: sectionIptables },
  { label: 'SELinux',          fn: sectionSelinux },
];

export async function runFirewallAnalysis(
  onProgress?: (step: number, total: number, label: string) => void,
): Promise<FirewallSection[]> {
  const sections: FirewallSection[] = [];
  for (let i = 0; i < FW_STEPS.length; i++) {
    const { label, fn } = FW_STEPS[i];
    onProgress?.(i + 1, FW_STEPS.length, label);
    await new Promise(r => setTimeout(r, 0));
    sections.push(fn());
  }
  return sections;
}

export function formatFirewall(sections: FirewallSection[]): string {
  const lines: string[] = [
    '=== Анализ фаервола ===',
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
