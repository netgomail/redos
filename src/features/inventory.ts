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
    let prettyName  = '';
    let versionId   = '';
    let edition     = '';
    if (osRelease) {
      prettyName = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1]?.replace(/"$/, '') ?? '';
      versionId  = osRelease.match(/^VERSION_ID="?([^"\n]+)"?/m)?.[1]?.replace(/"$/, '')  ?? '';
      edition    = osRelease.match(/^EDITION="?([^"\n]+)"?/m)?.[1]?.replace(/"$/, '')     ?? '';
    }

    // Редакция (DESKTOP / SERVER / WORKSTATION) живёт в /etc/redos-release или /etc/system-release.
    const releaseFile = readFile('/etc/redos-release') ?? readFile('/etc/system-release') ?? '';
    const redosEdition = releaseFile.match(/release\s*\(\s*[\d.]+\s*\)\s+(\S+)/i)?.[1] ?? '';

    // Собираем человекочитаемую строку: «RED OS 8.0 — DESKTOP, Certified Edition»
    if (prettyName) {
      const tags: string[] = [];
      if (redosEdition) tags.push(redosEdition);
      if (edition)      tags.push(`${edition} Edition`);
      const suffix = tags.length ? ` — ${tags.join(', ')}` : '';
      lines.push(`ОС:             ${prettyName}${suffix}`);
    }
    if (versionId) lines.push(`Версия ОС:      ${versionId}`);

    // ID сборки ISO (полезно для журнала: однозначно идентифицирует образ установки).
    const isoid = readFile('/etc/redos-isoid');
    if (isoid) {
      const iso = isoid.match(/ID:\s*(\S+)/)?.[1];
      if (iso) lines.push(`Сборка ISO:     ${iso}`);
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

// Серийник USB-устройства с уровня самого устройства (тот, что обычно на наклейке).
// lsblk для USB возвращает SCSI-инкапсулированный serial — он может отличаться.
function getUsbSerial(devNode: string): { vendor: string; product: string; serial: string } | null {
  const out = spawn(['udevadm', 'info', '-a', '-n', devNode]);
  if (!out) return null;
  for (const block of out.split(/looking at parent device/)) {
    const v = block.match(/ATTRS\{idVendor\}=="([^"]+)"/)?.[1];
    const p = block.match(/ATTRS\{idProduct\}=="([^"]+)"/)?.[1];
    const s = block.match(/ATTRS\{serial\}=="([^"]+)"/)?.[1];
    if (v && p && s && !/xHCI Host Controller|xhci-hcd/.test(block)) {
      return { vendor: v, product: p, serial: s };
    }
  }
  return null;
}

interface LsblkDisk {
  name:    string;
  type:    string;
  size:    number;
  model?:  string | null;
  serial?: string | null;
  vendor?: string | null;
  tran?:   string | null;
  rota:    boolean;
  rm:      boolean;
  hotplug: boolean;
  wwn?:    string | null;
}

function classifyDisk(d: LsblkDisk): string {
  const tran = (d.tran || '').toLowerCase();
  if (tran === 'nvme') return 'NVMe SSD';
  if (tran === 'sata') return d.rota ? 'SATA HDD' : 'SATA SSD';
  if (tran === 'sas')  return d.rota ? 'SAS HDD'  : 'SAS SSD';
  if (tran === 'usb')  return d.rm   ? 'USB-флешка' : 'USB-накопитель';
  if (tran === 'mmc')  return 'SD-карта';
  if (tran)            return tran.toUpperCase();
  return d.rota ? 'HDD' : 'SSD';
}

function sectionStorageMedia(): InventorySection {
  const lines: string[] = [];

  if (!isLinux) {
    return { title: 'Носители информации (журнал учёта МН)', lines: ['Доступно только на Linux'] };
  }

  const json = spawn([
    'lsblk', '-J', '-d', '-b',
    '-o', 'NAME,TYPE,SIZE,MODEL,SERIAL,VENDOR,TRAN,ROTA,RM,HOTPLUG,WWN',
  ]);
  if (!json) {
    return { title: 'Носители информации (журнал учёта МН)', lines: ['lsblk недоступен'] };
  }

  let parsed: { blockdevices?: LsblkDisk[] };
  try { parsed = JSON.parse(json); }
  catch { return { title: 'Носители информации (журнал учёта МН)', lines: ['ошибка разбора lsblk'] }; }

  // Только физические носители: исключаем zram, loop и подобное виртуальное.
  // У них tran пустой и /sys-имя начинается с zram/loop/dm/md/sr.
  const disks = (parsed.blockdevices ?? []).filter(d =>
    d.type === 'disk' && !/^(zram|loop|dm-|md|ram|sr)/i.test(d.name),
  );
  if (disks.length === 0) return { title: 'Носители информации (журнал учёта МН)', lines: ['Носителей не найдено'] };

  let idx = 1;
  for (const d of disks) {
    const tran        = (d.tran || '').toLowerCase();
    const kind        = classifyDisk(d);
    const sizeStr     = d.size > 0 ? fmtBytes(d.size) : '— (носитель не вставлен)';
    const model       = [d.vendor?.trim(), d.model?.trim()].filter(Boolean).join(' ') || '—';
    const driveSerial = (d.serial || '').trim();
    let   usbSerial   = '';
    let   usbId       = '';

    // Для USB читаем серийник с USB-уровня (моста / контроллера).
    // У USB-флешек это совпадает с тем, что на корпусе.
    // У USB-SSD/HDD (внешний диск через USB-SATA bridge) это серийник МОСТА,
    // а на корпусе самого диска — driveSerial с ATA/SCSI-уровня.
    if (tran === 'usb') {
      const usb = getUsbSerial(`/dev/${d.name}`);
      if (usb) {
        usbSerial = usb.serial;
        usbId     = `${usb.vendor}:${usb.product}`;
      }
    }

    // Для журнала учёта: USB и SD считаем съёмными независимо от RM-бита
    // (USB-SSD у него RM=0, но физически устройство всё равно отчуждаемо).
    const removable = tran === 'usb' || tran === 'mmc' || d.rm;

    lines.push(`[${idx}]  ${kind}  ${sizeStr}  /dev/${d.name}`);
    lines.push(`     Модель:    ${model}`);

    if (usbSerial && driveSerial && usbSerial !== driveSerial) {
      // Внешний накопитель: показываем оба, чтобы пользователь выбрал нужный для журнала
      lines.push(`     S/N диска: ${driveSerial}`);
      lines.push(`     S/N USB:   ${usbSerial}`);
    } else {
      lines.push(`     S/N:       ${usbSerial || driveSerial || '—'}`);
    }
    if (usbId) lines.push(`     USB ID:    ${usbId}`);
    if (d.wwn) lines.push(`     WWN:       ${d.wwn}`);
    lines.push(`     Носитель:  ${removable ? 'съёмный (отчуждаемый)' : 'фиксированный (внутренний)'}`);
    lines.push('');
    idx++;
  }
  // убираем хвостовую пустую строку
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  return { title: 'Носители информации (журнал учёта МН)', lines };
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

// ─── public API ───────────────────────────────────────────────────────────────

export async function collectInventory(): Promise<InventorySection[]> {
  return [
    sectionSystem(),
    sectionHardware(),
    sectionStorageMedia(),
    sectionDisks(),
    sectionUsers(),
    sectionNetwork(),
    sectionPorts(),
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
