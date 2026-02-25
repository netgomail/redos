import { existsSync } from 'fs';
import { cpus, totalmem, freemem, networkInterfaces, hostname } from 'os';
import { readFile } from '../utils/fs';

export interface InventorySection {
  title: string;
  lines: string[];
}

const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

// ─── helpers ──────────────────────────────────────────────────────────────────

function spawn(args: string[]): string {
  try {
    const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    return new TextDecoder().decode(result.stdout).trim();
  } catch { return ''; }
}

// PowerShell с принудительным UTF-8 — для Windows-команд с кириллицей
function spawnPS(command: string): string {
  try {
    const result = Bun.spawnSync(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
       `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    return new TextDecoder('utf-8').decode(result.stdout).trim();
  } catch { return ''; }
}

function fmtBytes(n: number): string {
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' ГБ';
  if (n >= 1048576)    return (n / 1048576).toFixed(1)    + ' МБ';
  return n + ' Б';
}

const MAX_OUTPUT_LINES = 25;

const PS_COMMANDS = {
  disks:
    'Get-PSDrive -PSProvider FileSystem | ' +
    'Where-Object { $_.Used -ne $null } | ' +
    'ForEach-Object { $total = $_.Used + $_.Free; "{0}:  всего {1}  свободно {2}  ({3}%)" -f ' +
    '$_.Name, [math]::Round($total/1GB,1).ToString()+"ГБ", [math]::Round($_.Free/1GB,1).ToString()+"ГБ", ' +
    '[math]::Round(($_.Used/$total)*100) }',
  users:
    'Get-LocalUser | Select-Object Name, Enabled, LastLogon | ' +
    'ForEach-Object { "{0,-24} enabled={1,-5} lastLogon={2}" -f $_.Name, $_.Enabled, $_.LastLogon }',
} as const;

// ─── sections ─────────────────────────────────────────────────────────────────

function sectionSystem(): InventorySection {
  const lines: string[] = [];

  if (isLinux) {
    const osRelease = readFile('/etc/os-release');
    if (osRelease) {
      const name    = osRelease.match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] ?? '';
      const version = osRelease.match(/^VERSION_ID="?([^"\n]+)/m)?.[1]  ?? '';
      if (name)    lines.push(`ОС:             ${name}`);
      if (version) lines.push(`Версия ОС:      ${version}`);
    }
    const kernel = spawn(['uname', '-r']);
    if (kernel) lines.push(`Ядро:           ${kernel}`);
  } else if (isWindows) {
    const info = spawn(['cmd', '/c', 'ver']);
    if (info) lines.push(`ОС:             ${info}`);
  }

  lines.push(`Платформа:      ${process.platform} / ${process.arch}`);
  lines.push(`Хост:           ${hostname()}`);
  lines.push(`Bun:            ${process.version}`);

  return { title: 'Система', lines };
}

function sectionHardware(): InventorySection {
  const lines: string[] = [];
  const cpu = cpus();
  const total = totalmem();
  const free  = freemem();
  const used  = total - free;

  if (cpu.length > 0) {
    lines.push(`CPU:            ${cpu[0].model.trim()}`);
    lines.push(`Ядра CPU:       ${cpu.length}`);
  }
  lines.push(`RAM всего:      ${fmtBytes(total)}`);
  lines.push(`RAM занято:     ${fmtBytes(used)}  (${Math.round(used / total * 100)}%)`);
  lines.push(`RAM свободно:   ${fmtBytes(free)}`);

  return { title: 'Железо', lines };
}

function sectionDisks(): InventorySection {
  let lines: string[] = [];

  if (isLinux) {
    const out = spawn(['df', '-h', '--output=target,size,used,avail,pcent']);
    if (out) lines = out.split('\n').filter(l => l.trim());
  } else if (isWindows) {
    const out = spawnPS(PS_COMMANDS.disks);
    if (out) lines.push(...out.split('\n').filter(l => l.trim()));
  }

  if (lines.length === 0) lines = ['Нет данных'];
  return { title: 'Диски', lines };
}

function sectionUsers(): InventorySection {
  const lines: string[] = [];

  if (isLinux) {
    const passwd = readFile('/etc/passwd');
    if (passwd) {
      const users = passwd.split('\n')
        .filter(l => l.trim())
        .map(l => l.split(':'))
        .filter(p => parseInt(p[2] ?? '0', 10) >= 1000 && p[0] !== 'nobody')
        .map(p => `${p[0]}  uid=${p[2]}  ${p[5] ?? ''}  ${p[6] ?? ''}`);
      lines.push(...users.length ? users : ['Нет пользователей с UID ≥ 1000']);
    }
  } else if (isWindows) {
    const out = spawnPS(PS_COMMANDS.users);
    if (out) lines.push(...out.split('\n').filter(l => l.trim()));
  }

  if (lines.length === 0) lines.push('Нет данных');
  return { title: 'Пользователи', lines };
}

function sectionNetwork(): InventorySection {
  const lines: string[] = [];
  const ifaces = networkInterfaces();

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      lines.push(`${name.padEnd(16)} ${addr.family.padEnd(6)} ${addr.address}`);
    }
  }

  if (lines.length === 0) lines.push('Нет внешних интерфейсов');
  return { title: 'Сеть', lines };
}

function sectionPorts(): InventorySection {
  const lines: string[] = [];

  if (isLinux) {
    const out = spawn(['ss', '-tlnp']);
    if (out) {
      lines.push(...out.split('\n').filter(l => l.trim()).slice(0, MAX_OUTPUT_LINES));
    }
  } else if (isWindows) {
    const out = spawn(['netstat', '-ano', '-p', 'TCP']);
    if (out) {
      const listening = out.split('\n')
        .filter(l => l.includes('LISTENING'))
        .slice(0, MAX_OUTPUT_LINES);
      lines.push(...listening.length ? listening : ['Нет прослушиваемых портов']);
    }
  }

  if (lines.length === 0) lines.push('Нет данных');
  return { title: 'Открытые порты', lines };
}

function sectionServices(): InventorySection {
  if (!isLinux) return { title: 'Сервисы', lines: ['Доступно только на Linux'] };

  const out = spawn([
    'systemctl', 'list-units', '--type=service', '--state=running',
    '--no-pager', '--no-legend',
  ]);

  if (!out) return { title: 'Сервисы', lines: ['Не удалось получить список (systemctl не найден)'] };

  const lines = out.split('\n')
    .filter(l => l.trim())
    .map(l => l.replace(/\s+/g, ' ').trim())
    .slice(0, MAX_OUTPUT_LINES);

  return { title: `Активные сервисы (${lines.length})`, lines };
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function collectInventory(): Promise<InventorySection[]> {
  return [
    sectionSystem(),
    sectionHardware(),
    sectionDisks(),
    sectionUsers(),
    sectionNetwork(),
    sectionPorts(),
    sectionServices(),
  ];
}

export function formatInventory(sections: InventorySection[]): string {
  const lines: string[] = [
    '=== Инвентаризация системы ===',
    `Дата: ${new Date().toLocaleString('ru-RU')}`,
    '',
  ];
  for (const s of sections) {
    lines.push(`── ${s.title} ──`);
    lines.push(...s.lines.map(l => '  ' + l));
    lines.push('');
  }
  return lines.join('\n');
}
