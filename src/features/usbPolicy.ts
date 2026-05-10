import { readFile } from '../utils/fs';
import { sudoRun, writeSudo } from '../utils/sudo';
import type { FixResult } from '../utils/sudo';

/**
 * Политика USB-накопителей: запрет автомонтирования через udev-правило
 * с UDISKS_IGNORE=1 и список доверенных устройств (по idVendor:idProduct + serial).
 *
 * Файл правил: /etc/udev/rules.d/99-redos-usb.rules — наш, с маркером в шапке.
 * Применение: udevadm control --reload-rules && udevadm trigger.
 *
 * Подход взят из официальной БЗ РедОС 8 (UDISKS_IGNORE-вариант).
 * Источник: https://redos.red-soft.ru/base/redos-8_0/8_0-security/8_0-sec-usb-config/8_0-restriction-usb/
 */

export const RULES_FILE = '/etc/udev/rules.d/99-redos-usb.rules';
const HEADER_MARK = '# redos-usb-policy: managed';

// ─── типы ─────────────────────────────────────────────────────────────────────

export interface UsbDevice {
  block:        string;  // sdb
  size:         string;  // 238,5G
  vendor:       string;  // idVendor (4 hex), напр. "174c"
  product:      string;  // idProduct (4 hex), напр. "55aa"
  serial:       string;  // ATTRS{serial} с USB-уровня
  manufacturer: string;
  productName:  string;
  modelLabel:   string;  // имя из lsblk: "Apacer AS350 256GB"
  driver:       string;  // usb-storage | uas
  trusted:      boolean; // отмечен в allowlist
}

export interface AllowedDevice {
  vendor:  string;
  product: string;
  serial:  string;
  label?:  string;
}

export type PolicyMode = 'open' | 'blocked';

export interface Policy {
  mode:    PolicyMode;
  allowed: AllowedDevice[];
}

// ─── чтение состояния системы ─────────────────────────────────────────────────

interface LsblkDev {
  name:    string;
  size?:   string;
  tran?:   string | null;
  type?:   string;
  vendor?: string | null;
  model?:  string | null;
  serial?: string | null;
  hotplug?: boolean;
}

function runRead(args: string[]): string {
  try {
    const r = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    return new TextDecoder().decode(r.stdout);
  } catch { return ''; }
}

function parseUdevInfo(output: string): { vendor: string; product: string; serial: string; manufacturer: string; productName: string } | null {
  const blocks = output.split(/looking at parent device/);
  for (const block of blocks) {
    const v = block.match(/ATTRS\{idVendor\}=="([^"]+)"/)?.[1];
    const p = block.match(/ATTRS\{idProduct\}=="([^"]+)"/)?.[1];
    const s = block.match(/ATTRS\{serial\}=="([^"]+)"/)?.[1];
    if (v && p && s && !block.includes('xHCI Host Controller') && !block.includes('xhci-hcd')) {
      return {
        vendor:       v,
        product:      p,
        serial:       s,
        manufacturer: (block.match(/ATTRS\{manufacturer\}=="([^"]+)"/)?.[1] ?? '').trim(),
        productName:  (block.match(/ATTRS\{product\}=="([^"]+)"/)?.[1] ?? '').trim(),
      };
    }
  }
  return null;
}

function getDriver(devNode: string): string {
  const out = runRead(['udevadm', 'info', '-q', 'property', '-n', devNode]);
  return out.match(/^ID_USB_DRIVER=(.+)$/m)?.[1] ?? '';
}

export async function listUsbBlockDevices(allowed: AllowedDevice[]): Promise<UsbDevice[]> {
  const json = runRead(['lsblk', '-J', '-o', 'NAME,SIZE,TRAN,VENDOR,MODEL,SERIAL,TYPE,HOTPLUG']);
  if (!json) return [];

  let parsed: { blockdevices?: LsblkDev[] };
  try { parsed = JSON.parse(json); } catch { return []; }
  const devs = parsed.blockdevices ?? [];

  const result: UsbDevice[] = [];
  for (const d of devs) {
    if (d.type !== 'disk') continue;
    if (d.tran !== 'usb') continue;

    const info = parseUdevInfo(runRead(['udevadm', 'info', '-a', '-p', `/sys/block/${d.name}`]));
    if (!info) continue;

    const trusted = allowed.some(a =>
      a.vendor === info.vendor && a.product === info.product && a.serial === info.serial,
    );

    result.push({
      block:        d.name,
      size:         d.size ?? '',
      vendor:       info.vendor,
      product:      info.product,
      serial:       info.serial,
      manufacturer: info.manufacturer,
      productName:  info.productName,
      modelLabel:   [d.vendor?.trim(), d.model?.trim()].filter(Boolean).join(' ') || info.productName || '(без модели)',
      driver:       getDriver(`/dev/${d.name}`),
      trusted,
    });
  }
  return result;
}

// ─── чтение политики из файла правил ──────────────────────────────────────────

export function readPolicy(): Policy {
  const content = readFile(RULES_FILE);
  if (!content || !content.includes(HEADER_MARK)) {
    return { mode: 'open', allowed: [] };
  }

  const allowed: AllowedDevice[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // ATTRS{idVendor}=="...", ATTRS{idProduct}=="...", ATTRS{serial}=="...", ENV{UDISKS_IGNORE}="0"
    const v = line.match(/ATTRS\{idVendor\}=="([^"]+)"/)?.[1];
    const p = line.match(/ATTRS\{idProduct\}=="([^"]+)"/)?.[1];
    const s = line.match(/ATTRS\{serial\}=="([^"]+)"/)?.[1];
    const allow = /UDISKS_IGNORE\}="0"/.test(line);
    if (v && p && s && allow) {
      // комментарий-метка над правилом
      const labelLine = lines[i - 1] ?? '';
      const label = labelLine.startsWith('#') ? labelLine.replace(/^#\s*/, '').trim() : undefined;
      allowed.push({ vendor: v, product: p, serial: s, label });
    }
  }

  return { mode: 'blocked', allowed };
}

// ─── применение политики ─────────────────────────────────────────────────────

function generateRules(allowed: AllowedDevice[]): string {
  const lines = [
    HEADER_MARK,
    '# Управляется утилитой redos (/usb-policy). Не редактируйте вручную.',
    `# Сгенерировано: ${new Date().toISOString()}`,
    '',
    '# Применяемся только к блочным sd*-устройствам (диск + все партиции)',
    '# с USB в пути. SUBSYSTEMS=="usb" в udev новых версий ненадёжно',
    '# срабатывает для уже-pop\'нутого блочного event\'а, поэтому фильтруем',
    '# по ENV{ID_PATH} — он содержит "-usb-" для всех USB-накопителей,',
    '# включая USB-SATA bridge (внешние SSD/HDD), и наследуется в партициях.',
    'ACTION!="add|change", GOTO="redos_usb_end"',
    'KERNEL!="sd*", GOTO="redos_usb_end"',
    'ENV{ID_PATH}!="*-usb-*", GOTO="redos_usb_end"',
    '',
    '# Блокируем автомонтирование всех USB-накопителей',
    'ENV{UDISKS_IGNORE}="1"',
  ];
  if (allowed.length > 0) {
    lines.push('', '# Доверенные устройства (whitelist) — ATTRS ищет атрибуты у предков,');
    lines.push('# поэтому правило срабатывает и для самого диска, и для его разделов:');
    for (const a of allowed) {
      if (a.label) lines.push(`# ${a.label}`);
      lines.push(
        `ATTRS{idVendor}=="${a.vendor}", ATTRS{idProduct}=="${a.product}", ATTRS{serial}=="${a.serial}", ENV{UDISKS_IGNORE}="0"`,
      );
    }
  }
  lines.push('', 'LABEL="redos_usb_end"');
  return lines.join('\n') + '\n';
}

function reloadUdev(): FixResult {
  const r1 = sudoRun(['udevadm', 'control', '--reload-rules']);
  if (!r1.ok) return r1;

  // Применяем новые правила к уже подключённым устройствам — обновляет ENV{UDISKS_IGNORE}
  // в udev-БД (но не вызывает (раз)монтирование).
  sudoRun(['udevadm', 'trigger', '--subsystem-match=block', '--action=change']);

  // Рестарт UDisks2: при смене политики через trigger он не всегда подхватывает изменения,
  // и устройства, ранее проигнорированные из-за UDISKS_IGNORE=1, так и остаются «забытыми»
  // в его внутренней БД (caja/gvfs их не видят). После рестарта он пересканирует все
  // блочные устройства через libudev и заново пошлёт add-сигналы автомонтировщикам.
  // Уже смонтированные ФС не размонтируются — их держат отдельные процессы (mount.ntfs и т.п.).
  const r2 = sudoRun(['systemctl', 'restart', 'udisks2']);
  return r2.ok
    ? { ok: true, msg: 'udev перезагружен, UDisks2 перезапущен' }
    : { ok: true, msg: 'правила записаны (UDisks2 не перезапущен: ' + r2.msg + ')' };
}

export function applyBlockPolicy(allowed: AllowedDevice[]): FixResult {
  const w = writeSudo(RULES_FILE, generateRules(allowed));
  if (!w.ok) return w;
  const r = reloadUdev();
  return r.ok
    ? { ok: true, msg: `Заблокированы все USB-накопители кроме ${allowed.length} доверенных` }
    : { ok: false, msg: r.msg };
}

export function removePolicy(): FixResult {
  // Безопасно удаляем только если файл наш (содержит HEADER_MARK)
  const content = readFile(RULES_FILE);
  if (!content) return { ok: true, msg: 'политика не была установлена' };
  if (!content.includes(HEADER_MARK)) {
    return { ok: false, msg: `файл ${RULES_FILE} не управляется redos — удалите вручную` };
  }
  const r1 = sudoRun(['rm', '-f', RULES_FILE]);
  if (!r1.ok) return r1;
  const r2 = reloadUdev();
  return r2.ok
    ? { ok: true, msg: 'Блокировка снята' }
    : { ok: false, msg: r2.msg };
}
