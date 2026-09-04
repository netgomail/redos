/**
 * Контроль устройств на базе USBGuard.
 *
 * Почему USBGuard, а не самодельные udev-правила (как было в прошлой версии):
 * udev-подсказка UDISKS_IGNORE гасит только автомонтирование. Устройство при
 * этом остаётся авторизованным, /dev/sdX создаётся, и обычный пользователь
 * спокойно монтирует его через «Диски» или udisksctl — polkit по умолчанию
 * разрешает монтирование активному локальному пользователю без пароля.
 * USBGuard запрещает на уровне ядра: неавторизованное устройство не
 * конфигурируется вообще, блочного узла не появляется, монтировать нечего.
 *
 * Модель — белый список, как рекомендуют разработчики USBGuard: всё, что не
 * разрешено явно, блокируется неявно (ImplicitPolicyTarget=block). Обратная
 * модель («разрешено всё, блокируем выбранное») в документации USBGuard прямо
 * названа неверной: устройство может объявить нестандартный класс интерфейса
 * и проскочить мимо чёрного списка. Живой пример с этой машины — встроенный
 * картридер Realtek, который даёт /dev/sda, но объявляет класс ff:06:50,
 * а вовсе не 08 (mass storage).
 *
 * Категории устройств здесь — это классы интерфейсов USB по спецификации
 * usb.org, то есть родная для USBGuard величина: в правилах они и задаются
 * через with-interface. Группировка нужна только для интерфейса, чтобы
 * администратор выбирал «накопители», а не набор шестнадцатеричных кодов.
 */

import { readdirSync, realpathSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { readFile } from '../utils/fs';
import { sudoRun, writeSudo } from '../utils/sudo';
import type { FixResult } from '../utils/sudo';
import { runPty, runPtyLines } from '../utils/terminal';

export const RULES_FILE  = '/etc/usbguard/rules.conf';
export const DAEMON_CONF = '/etc/usbguard/usbguard-daemon.conf';
const HEADER_MARK = '# redos-device-control: managed';

const C_LOCALE = { LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };

// ─── категории устройств ─────────────────────────────────────────────────────

export type CategoryId =
  | 'hub' | 'token' | 'input' | 'storage' | 'printer' | 'imaging'
  | 'video' | 'audio' | 'network' | 'wireless' | 'smartcard';

/**
 * Криптотокены «Актив» (Рутокен, Guardant) — производитель 0a89.
 *
 * Опознаются по производителю, а не по классу интерфейса, и это принципиально:
 * класс у них не отражает назначение. По системной базе /usr/share/hwdata/usb.ids:
 *
 *   0a89:0020  Rutoken S            — вендорский класс, драйвер ifd-rutokens
 *   0a89:0025  Rutoken lite
 *   0a89:0026  Rutoken lite HID     — объявляет себя устройством ВВОДА
 *   0a89:002a  Rutoken Mass Storage — объявляет себя НАКОПИТЕЛЕМ
 *   0a89:0030  Rutoken ECP
 *   0a89:0040  Rutoken ECP HID      — тоже ввод
 *   0a89:0060  Rutoken Magistra
 *   0a89:0080  Rutoken PinPad Ex
 *
 * То есть запрет категории «накопители» отрубил бы Rutoken Mass Storage, а с
 * ним вход по токену и подпись. Поэтому весь производитель разрешён всегда.
 */
export const TOKEN_VENDOR_IDS = ['0a89:*'];

export interface Category {
  id:      CategoryId;
  title:   string;
  hint:    string;
  /** Классы интерфейсов USB в формате with-interface. */
  classes: string[];
  /**
   * Опознание по идентификатору производителя, а не по классу интерфейса.
   * Нужно для устройств, чей класс не отражает их назначение, — см. токены.
   */
  ids?:    string[];
  /** Нельзя выключить: без этого система развалится. */
  locked?: boolean;
  /** Выключение опасно — требуется подтверждение. */
  risky?:  boolean;
}

/**
 * Классы интерфейсов USB по спецификации usb.org, сгруппированные так, как
 * их воспринимает администратор. Один класс может давать несколько привычных
 * устройств: 08 — это и флешка, и внешний диск, и картридер, и USB-привод,
 * поэтому категория одна и названа честно.
 *
 * Важно: класс интерфейса описывает не всё. Встроенный картридер Realtek на
 * тестовой машине объявляет ff:06:50 (вендорский класс), но даёт /dev/sda.
 * Под белым списком это безопасно — такое устройство просто не попадёт ни в
 * одну категорию и будет заблокировано, пока его не внесут в доверенные.
 */
export const CATEGORIES: Category[] = [
  { id: 'hub',       title: 'Хабы и контроллеры',   classes: ['09:*:*'], locked: true,
    hint: 'разветвители USB. Заблокировав их, вы отключите всё, что подключено через них' },
  { id: 'token',     title: 'Криптотокены (Рутокен)', classes: [], ids: TOKEN_VENDOR_IDS, locked: true,
    hint: 'Рутокен и Guardant — по производителю Актив: часть моделей объявляет себя HID или накопителем' },
  { id: 'input',     title: 'Клавиатуры и мыши',    classes: ['03:*:*'], risky: true,
    hint: 'класс HID. Сняв разрешение, вы потеряете управление машиной' },
  { id: 'storage',   title: 'Накопители',           classes: ['08:*:*'],
    hint: 'флешки, внешние диски, картридеры, USB-приводы' },
  { id: 'printer',   title: 'Принтеры',             classes: ['07:*:*'],
    hint: 'принтеры и часть МФУ' },
  { id: 'imaging',   title: 'Камеры и сканеры',     classes: ['06:*:*'],
    hint: 'PTP/MTP: фотоаппараты, сканеры, телефоны' },
  { id: 'video',     title: 'Веб-камеры',           classes: ['0e:*:*'],
    hint: 'в том числе встроенная камера ноутбука' },
  { id: 'audio',     title: 'Звук и гарнитуры',     classes: ['01:*:*'],
    hint: 'USB-наушники, микрофоны, звуковые карты' },
  { id: 'network',   title: 'Сеть и модемы',        classes: ['02:*:*', '0a:*:*'],
    hint: 'USB-сетевые адаптеры, модемы, режим модема у телефона' },
  { id: 'wireless',  title: 'Bluetooth и радио',    classes: ['e0:*:*'],
    hint: 'в том числе встроенный Bluetooth' },
  { id: 'smartcard', title: 'Смарт-карты и токены', classes: ['0b:*:*'],
    hint: 'считыватели смарт-карт, часть USB-токенов' },
];

/** Категории, которые всегда разрешены и не показываются переключателем. */
export const LOCKED_CATEGORIES: CategoryId[] = CATEGORIES.filter(c => c.locked).map(c => c.id);

/** Совпадает ли идентификатор устройства с шаблоном вида "0a89:*". */
function idMatches(deviceId: string, pattern: string): boolean {
  const [pv, pp] = pattern.toLowerCase().split(':');
  const [dv, dp] = deviceId.toLowerCase().split(':');
  if (!dv || !dp) return false;
  return (pv === '*' || pv === dv) && (pp === '*' || pp === dp);
}

/**
 * К каким категориям относится устройство. Учитываются и классы интерфейсов,
 * и идентификатор: у токенов класс не отражает назначение, поэтому они
 * опознаются по производителю.
 *
 * Пустой результат означает, что устройство не покрыто ни одной категорией
 * (вендорский класс ff и подобные) — такое разрешается только поимённо.
 */
export function categoriesOf(interfaces: string[], deviceId = ''): CategoryId[] {
  const out = new Set<CategoryId>();
  for (const c of CATEGORIES) {
    if (c.ids?.some(p => idMatches(deviceId, p))) { out.add(c.id); continue; }
    for (const iface of interfaces) {
      const cls = iface.split(':')[0]?.toLowerCase();
      if (cls && c.classes.some(p => p.split(':')[0].toLowerCase() === cls)) { out.add(c.id); break; }
    }
  }
  return [...out];
}

// ─── состояние USBGuard ──────────────────────────────────────────────────────

export interface GuardStatus {
  installed:      boolean;
  version:        string;
  serviceUnit:    string;   // usbguard.service | usbguard-daemon.service
  serviceEnabled: boolean;
  serviceActive:  boolean;
  implicitTarget: string;   // из usbguard-daemon.conf
  /** rules.conf написан нами (есть маркер). */
  managed:        boolean;
  rulesCount:     number;
  /** Остатки прошлой udev-политики redos. */
  legacyUdev:     LegacyUdev | null;
}

export interface LegacyUdev {
  file:    string;
  /** Доверенные устройства из старой политики — их можно перенести. */
  allowed: { vendor: string; product: string; serial: string; label?: string }[];
}

const LEGACY_UDEV_FILE = '/etc/udev/rules.d/99-redos-usb.rules';
const LEGACY_MARK      = '# redos-usb-policy: managed';

/**
 * Ищет правила от прошлой версии redos и разбирает их белый список,
 * чтобы не потерять уже отобранные администратором доверенные устройства.
 */
export function findLegacyUdev(): LegacyUdev | null {
  const content = readFile(LEGACY_UDEV_FILE);
  if (!content || !content.includes(LEGACY_MARK)) return null;

  const allowed: LegacyUdev['allowed'] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const v = line.match(/ATTRS\{idVendor\}=="([^"]+)"/)?.[1];
    const p = line.match(/ATTRS\{idProduct\}=="([^"]+)"/)?.[1];
    const s = line.match(/ATTRS\{serial\}=="([^"]+)"/)?.[1];
    if (v && p && s && /UDISKS_IGNORE\}="0"/.test(line)) {
      const prev = lines[i - 1] ?? '';
      allowed.push({
        vendor: v, product: p, serial: s,
        label: prev.startsWith('#') ? prev.replace(/^#\s*/, '').trim() : undefined,
      });
    }
  }
  return { file: LEGACY_UDEV_FILE, allowed };
}

async function detectServiceUnit(): Promise<string> {
  for (const unit of ['usbguard.service', 'usbguard-daemon.service']) {
    const r = await runPtyLines(['systemctl', 'cat', unit], { env: C_LOCALE, timeoutMs: 8000 });
    if (r.some(l => l.includes('[Unit]'))) return unit;
  }
  return 'usbguard.service';
}

export async function readStatus(): Promise<GuardStatus> {
  // Проверяем по коду возврата, а не по тексту: при отсутствии утилиты runPty
  // возвращает код 127 и сообщение, в котором само слово «usbguard» и стоит.
  const ver = await runPty(['usbguard', '--version'], { env: C_LOCALE, timeoutMs: 8000 });
  const installed = ver.code === 0;
  const verLine = installed
    ? ver.output.split('\n').find(l => /\d+\.\d+/.test(l))?.trim() ?? ''
    : '';

  const base: GuardStatus = {
    installed,
    version:        verLine,
    serviceUnit:    'usbguard.service',
    serviceEnabled: false,
    serviceActive:  false,
    implicitTarget: '',
    managed:        false,
    rulesCount:     0,
    legacyUdev:     findLegacyUdev(),
  };
  if (!installed) return base;

  base.serviceUnit = await detectServiceUnit();
  const [en, act] = await Promise.all([
    runPtyLines(['systemctl', 'is-enabled', base.serviceUnit], { env: C_LOCALE, timeoutMs: 8000 }),
    runPtyLines(['systemctl', 'is-active',  base.serviceUnit], { env: C_LOCALE, timeoutMs: 8000 }),
  ]);
  base.serviceEnabled = en.some(l => l.trim() === 'enabled');
  base.serviceActive  = act.some(l => l.trim() === 'active');

  const conf = readFile(DAEMON_CONF) ?? '';
  base.implicitTarget = conf.match(/^\s*ImplicitPolicyTarget\s*=\s*(\S+)/m)?.[1] ?? '';

  const rules = readFile(RULES_FILE) ?? '';
  base.managed    = rules.includes(HEADER_MARK);
  base.rulesCount = rules.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length;

  return base;
}

// ─── устройства ──────────────────────────────────────────────────────────────

export interface GuardDevice {
  /** Внутренний номер правила устройства в usbguard. */
  id:         number;
  target:     'allow' | 'block' | 'reject';
  deviceId:   string;    // 24a9:205a
  name:       string;
  serial:     string;
  hash:       string;
  viaPort:    string;
  interfaces: string[];  // ['08:06:50']
  categories: CategoryId[];
  /** Ни один класс интерфейса не попал в известные категории. */
  uncategorized: boolean;
  /**
   * Блочные устройства, которые даёт этот аппарат (sda, sdc...). Заполняется
   * из /sys/block, а не из класса интерфейса: картридер с вендорским классом
   * — такой же канал утечки, как флешка, и это должно быть видно.
   */
  storageNodes?: string[];
}

/**
 * Разбирает строку правила USBGuard. В таком же виде устройства выдаёт
 * `usbguard list-devices`, и в таком же виде правила лежат в rules.conf:
 *
 *   12: block id 24a9:205a serial "89880401" name "" hash "…" \
 *       via-port "2-4" with-interface { 08:06:50 } with-connect-type "hotplug"
 */
export function parseDeviceLine(line: string): GuardDevice | null {
  const m = line.match(/^\s*(\d+):\s*(allow|block|reject)\s+(.*)$/);
  if (!m) return null;
  const rest = m[3];

  const str = (attr: string) =>
    rest.match(new RegExp(`\\b${attr}\\s+"((?:[^"\\\\]|\\\\.)*)"`))?.[1]?.replace(/\\(.)/g, '$1') ?? '';

  const ifaceBlock = rest.match(/with-interface\s+(?:[a-z-]+\s+)?\{([^}]*)\}/)?.[1]
                  ?? rest.match(/with-interface\s+([0-9a-fA-F*]{2}:[0-9a-fA-F*]{2}:[0-9a-fA-F*]{2})/)?.[1]
                  ?? '';
  const interfaces = ifaceBlock.trim().split(/\s+/).filter(Boolean);

  const deviceId = rest.match(/\bid\s+([0-9a-fA-F*]{4}:[0-9a-fA-F*]{4})/)?.[1] ?? '';
  const categories = categoriesOf(interfaces, deviceId);
  return {
    id:       parseInt(m[1], 10),
    target:   m[2] as GuardDevice['target'],
    deviceId,
    name:     str('name'),
    serial:   str('serial'),
    hash:     str('hash'),
    viaPort:  str('via-port'),
    interfaces,
    categories,
    uncategorized: interfaces.length > 0 && categories.length === 0,
  };
}

/**
 * USB-устройства, которые реально дают блочный узел.
 *
 * Класс интерфейса — не гарантия: встроенный картридер Realtek объявляет
 * ff:06:50 (вендорский), но даёт /dev/sda, то есть является таким же каналом
 * утечки, как флешка. Поэтому «накопитель ли это» определяется не по классу,
 * а по факту наличия /sys/block/*, поднятого через USB.
 */
export function listUsbStorage(): UsbStorageNode[] {
  const out: UsbStorageNode[] = [];
  let names: string[];
  try { names = readdirSync('/sys/block'); } catch { return out; }

  for (const name of names) {
    let real: string;
    try { real = realpathSync(`/sys/block/${name}`); } catch { continue; }
    if (!/\/usb\d+\//.test(real)) continue;

    // Поднимаемся до ближайшего предка с idVendor — это и есть usb_device
    let dir = real;
    while (dir !== '/' && !existsSync(join(dir, 'idVendor'))) dir = dirname(dir);
    if (dir === '/') continue;

    const read = (f: string) => (readFile(join(dir, f)) ?? '').trim();
    out.push({
      block:    name,
      sysPath:  dir,
      deviceId: `${read('idVendor')}:${read('idProduct')}`,
      serial:   read('serial'),
      size:     (readFile(`/sys/block/${name}/size`) ?? '0').trim(),
    });
  }
  return out;
}

export interface UsbStorageNode {
  block:    string;   // sda
  sysPath:  string;   // /sys/bus/usb/devices/1-12
  deviceId: string;   // 0bda:0129
  serial:   string;
  size:     string;   // в секторах по 512 байт; 0 — носитель не вставлен
}

export async function listDevices(): Promise<GuardDevice[]> {
  const lines = await runPtyLines(['usbguard', 'list-devices'], { env: C_LOCALE, timeoutMs: 20_000 });
  const devices = lines.map(parseDeviceLine).filter((d): d is GuardDevice => d !== null);

  // Отмечаем те, что дают блочный узел, — независимо от класса интерфейса
  const storage = listUsbStorage();
  for (const d of devices) {
    const nodes = storage.filter(s =>
      s.deviceId.toLowerCase() === d.deviceId.toLowerCase() &&
      (!d.serial || !s.serial || s.serial === d.serial));
    if (nodes.length > 0) {
      d.storageNodes = nodes.map(n => n.block);
    }
  }
  return devices;
}

// ─── установка ───────────────────────────────────────────────────────────────

/** Ставит usbguard из репозитория. Пакет есть в штатном репозитории РЕД ОС. */
export async function install(onStep: (m: string) => void = () => {}): Promise<FixResult> {
  onStep('Устанавливаю usbguard из репозитория...');
  const r = await runPty(['dnf', 'install', '-y', 'usbguard'], {
    env: C_LOCALE,
    timeoutMs: 300_000,
    onLine: l => { if (l.trim()) onStep(l.trim()); },
  });
  if (r.code !== 0) {
    return { ok: false, msg: `dnf install usbguard завершился с кодом ${r.code}` };
  }
  const st = await readStatus();
  return st.installed
    ? { ok: true, msg: `usbguard установлен${st.version ? ' (' + st.version + ')' : ''}` }
    : { ok: false, msg: 'dnf отработал, но usbguard в системе не появился' };
}

// ─── генерация политики ──────────────────────────────────────────────────────

export interface TrustedDevice {
  deviceId: string;   // 24a9:205a
  serial:   string;
  name:     string;
  hash:     string;
}

export interface PolicyInput {
  /** Разрешённые категории (hub всегда добавляется принудительно). */
  allowed: CategoryId[];
  trusted: TrustedDevice[];
}

/**
 * Собирает rules.conf.
 *
 * Порядок важен: USBGuard идёт по правилам сверху вниз до первого совпадения.
 *
 *  1. reject для опасных комбинаций. Устройство, которое одновременно
 *     накопитель и клавиатура, — классическая атака BadUSB. Эти правила стоят
 *     первыми, иначе разрешение категории «клавиатуры» пропустило бы такое
 *     устройство целиком. Набор взят из примеров документации USBGuard.
 *
 *  2. Одно allow с оператором match-all по разрешённым классам. match-all
 *     требует, чтобы ВСЕ интерфейсы устройства входили в разрешённый набор.
 *     Через one-of устройство с интерфейсами {08, 03} прошло бы по одному
 *     лишь HID и протащило накопитель — match-all это исключает.
 *
 *  3. Поимённые разрешения доверенных устройств: по хешу дескриптора, а не по
 *     serial, — serial подделывается тривиально, хеш USBGuard считает по всему
 *     дескриптору.
 *
 *  4. Всё остальное блокируется неявно через ImplicitPolicyTarget=block.
 */
export function generateRules(input: PolicyInput): string {
  const allowed = new Set<CategoryId>([...input.allowed, ...LOCKED_CATEGORIES]);
  const classes = CATEGORIES
    .filter(c => allowed.has(c.id))
    .flatMap(c => c.classes);   // категории, опознаваемые по id, идут отдельным правилом

  const lines = [
    HEADER_MARK,
    '# Управляется утилитой redos (/usb-policy). Не редактируйте вручную:',
    '# при следующем применении политики файл будет перезаписан.',
    `# Сгенерировано: ${new Date().toISOString()}`,
    '',
    '# ── Опасные комбинации ──────────────────────────────────────────────────',
    '# Устройство, которое притворяется накопителем и клавиатурой одновременно,',
    '# — классическая атака BadUSB. Правила стоят первыми: иначе разрешение',
    '# категории пропустило бы такое устройство целиком.',
    'reject with-interface all-of { 08:*:* 03:00:* }',
    'reject with-interface all-of { 08:*:* 03:01:* }',
    'reject with-interface all-of { 08:*:* e0:*:* }',
    'reject with-interface all-of { 08:*:* 02:*:* }',
    '',
    '# ── Криптотокены ────────────────────────────────────────────────────────',
    '# Разрешены всегда и опознаются по производителю, а не по классу:',
    '# Rutoken Mass Storage объявляет себя накопителем, Rutoken ECP HID —',
    '# устройством ввода, Rutoken S — вендорским классом. Запрет категории',
    '# «накопители» иначе отрубил бы вход по токену и подпись.',
    '#',
    '# Правило стоит ПОСЛЕ reject-ов выше — намеренно: идентификатор',
    '# производителя подделывается тривиально, и подложное устройство',
    '# «Рутокен + клавиатура» должно быть отклонено, а не разрешено.',
    ...CATEGORIES.filter(c => c.locked && c.ids?.length)
                 .flatMap(c => (c.ids ?? []).map(id => `allow id ${id}`)),
    '',
    '# ── Разрешённые категории ───────────────────────────────────────────────',
    '# match-all: устройство проходит, только если ВСЕ его интерфейсы входят',
    '# в разрешённый набор. Разрешено: ' +
      CATEGORIES.filter(c => allowed.has(c.id) && c.classes.length)
                .map(c => c.title.toLowerCase()).join(', '),
    `allow with-interface match-all { ${classes.join(' ')} }`,
  ];

  if (input.trusted.length > 0) {
    lines.push(
      '',
      '# ── Доверенные устройства ───────────────────────────────────────────────',
      '# Опознаются по хешу дескриптора: serial подделывается, хеш — нет.',
    );
    for (const t of input.trusted) {
      const parts: string[] = ['allow'];
      if (t.deviceId) parts.push(`id ${t.deviceId}`);
      if (t.serial)   parts.push(`serial "${escapeQ(t.serial)}"`);
      if (t.hash)     parts.push(`hash "${escapeQ(t.hash)}"`);
      if (t.name)     lines.push(`# ${t.name}`);
      lines.push(parts.join(' '));
    }
  }

  lines.push(
    '',
    '# Всё, что не совпало, блокируется неявно: ImplicitPolicyTarget=block',
    '',
  );
  return lines.join('\n');
}

function escapeQ(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Приводит usbguard-daemon.conf к нужному виду, сохраняя прочие параметры. */
export function generateDaemonConf(current: string): string {
  const wanted: Record<string, string> = {
    RuleFile:                    RULES_FILE,
    ImplicitPolicyTarget:        'block',
    // Уже подключённые устройства прогоняем через политику — иначе воткнутая
    // до применения флешка осталась бы доступной.
    PresentDevicePolicy:         'apply-policy',
    // Контроллеры (корневые хабы) не трогаем: их блокировка убивает всю шину.
    PresentControllerPolicy:     'keep',
    InsertedDevicePolicy:        'apply-policy',
    // Не возвращать разрешающее состояние при остановке демона — иначе
    // политику можно обойти, уронив демон.
    RestoreControllerDeviceState: 'false',
  };

  const seen = new Set<string>();
  const out = (current || '').split('\n').map(line => {
    const key = line.match(/^\s*([A-Za-z]+)\s*=/)?.[1];
    if (key && key in wanted) {
      seen.add(key);
      return `${key}=${wanted[key]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(wanted)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ─── применение ──────────────────────────────────────────────────────────────

export interface ApplyResult extends FixResult {
  /** Политика откачена из-за неудачной проверки. */
  rolledBack?: boolean;
  backupDir?:  string;
}

/**
 * Применяет политику с сеткой безопасности.
 *
 * Порядок такой, чтобы машина не осталась без клавиатуры:
 *  1. бэкап текущих конфигов;
 *  2. запись новых;
 *  3. перезапуск демона;
 *  4. ПРОВЕРКА: демон жив, правила загрузились, и все устройства ввода,
 *     которые были разрешены до применения, разрешены и после;
 *  5. если проверка не прошла — откат из бэкапа и перезапуск.
 *
 * Проверка на устройствах ввода заодно ловит и то, что версия usbguard не
 * поняла оператор match-all: тогда правило не загрузится, клавиатура окажется
 * заблокированной, и мы откатимся, а не оставим систему без управления.
 */
export async function applyPolicy(
  input: PolicyInput,
  onStep: (m: string) => void = () => {},
): Promise<ApplyResult> {
  const status = await readStatus();
  if (!status.installed) return { ok: false, msg: 'usbguard не установлен' };

  // 0. Что разрешено сейчас — чтобы потом сравнить
  const before = await listDevices();
  const inputBefore = before.filter(d => d.categories.includes('input') && d.target === 'allow');

  // 1. Бэкап
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const backupDir = `/root/redos-usbguard-backup-${stamp}`;
  onStep(`Бэкап конфигурации в ${backupDir}`);
  const mk = sudoRun(['mkdir', '-p', backupDir]);
  if (!mk.ok) return { ok: false, msg: `не удалось создать ${backupDir}: ${mk.msg}` };
  sudoRun(['cp', '-a', RULES_FILE, backupDir + '/']);
  sudoRun(['cp', '-a', DAEMON_CONF, backupDir + '/']);

  const restore = (): void => {
    sudoRun(['cp', '-a', `${backupDir}/rules.conf`, RULES_FILE]);
    sudoRun(['cp', '-a', `${backupDir}/usbguard-daemon.conf`, DAEMON_CONF]);
    sudoRun(['systemctl', 'restart', status.serviceUnit]);
  };

  // 2. Запись
  onStep('Записываю правила и конфигурацию демона');
  const w1 = writeSudo(RULES_FILE, generateRules(input));
  if (!w1.ok) return { ok: false, msg: `${RULES_FILE}: ${w1.msg}`, backupDir };
  const w2 = writeSudo(DAEMON_CONF, generateDaemonConf(readFile(DAEMON_CONF) ?? ''));
  if (!w2.ok) { restore(); return { ok: false, msg: `${DAEMON_CONF}: ${w2.msg}`, backupDir, rolledBack: true }; }
  sudoRun(['chmod', '600', RULES_FILE]);

  // 3. Запуск
  onStep('Перезапускаю usbguard');
  sudoRun(['systemctl', 'enable', status.serviceUnit]);
  const rs = sudoRun(['systemctl', 'restart', status.serviceUnit]);
  if (!rs.ok) {
    restore();
    return { ok: false, msg: `демон не запустился: ${rs.msg}. Политика откачена.`, backupDir, rolledBack: true };
  }
  await new Promise<void>(r => setTimeout(r, 1500));

  // 4. Проверка
  onStep('Проверяю, что клавиатура и мышь остались доступны');
  const active = await runPtyLines(['systemctl', 'is-active', status.serviceUnit],
                                   { env: C_LOCALE, timeoutMs: 8000 });
  if (!active.some(l => l.trim() === 'active')) {
    restore();
    return { ok: false, msg: 'демон не удержался запущенным. Политика откачена.', backupDir, rolledBack: true };
  }

  const after = await listDevices();
  if (after.length === 0) {
    restore();
    return { ok: false, msg: 'usbguard не отдал список устройств. Политика откачена.', backupDir, rolledBack: true };
  }
  const lost = inputBefore.filter(b =>
    !after.some(a => a.hash === b.hash && a.target === 'allow'));
  if (lost.length > 0) {
    restore();
    return {
      ok: false,
      rolledBack: true,
      backupDir,
      msg: `после применения оказались заблокированы устройства ввода (${lost.map(d => d.name || d.deviceId).join(', ')}). ` +
           'Политика откачена — машина не осталась бы без клавиатуры.',
    };
  }

  const blocked = after.filter(d => d.target !== 'allow').length;
  return {
    ok: true,
    backupDir,
    msg: `Политика применена: разрешено ${after.length - blocked} устройств, заблокировано ${blocked}. Откат: ${backupDir}`,
  };
}

/** Снимает политику: демон останавливается, устройства снова доступны. */
export async function removePolicy(onStep: (m: string) => void = () => {}): Promise<FixResult> {
  const status = await readStatus();
  if (!status.installed) return { ok: true, msg: 'usbguard не установлен — снимать нечего' };

  const rules = readFile(RULES_FILE) ?? '';
  if (rules && !rules.includes(HEADER_MARK)) {
    return {
      ok: false,
      msg: `${RULES_FILE} создан не утилитой redos — снимите политику вручную, чтобы не потерять чужие правила`,
    };
  }

  onStep('Останавливаю usbguard');
  sudoRun(['systemctl', 'disable', '--now', status.serviceUnit]);

  // Демон при остановке оставляет устройства как есть, поэтому возвращаем
  // авторизацию сами — иначе заблокированные останутся мёртвыми до перезагрузки.
  onStep('Возвращаю авторизацию устройствам');
  let restored = 0;
  const r = await runPty(['sh', '-c',
    'for f in /sys/bus/usb/devices/*/authorized; do [ "$(cat "$f")" = "0" ] && echo 1 > "$f" && echo "$f"; done'],
    { env: C_LOCALE, timeoutMs: 20_000, onLine: l => { if (l.includes('authorized')) restored++; } });
  if (r.code !== 0 && restored === 0) onStep('часть устройств может потребовать переподключения');

  return { ok: true, msg: `Политика снята, usbguard выключен${restored ? `, восстановлено устройств: ${restored}` : ''}` };
}

/** Удаляет правила прошлой udev-политики redos (только свои, с маркером). */
export function removeLegacyUdev(): FixResult {
  const legacy = findLegacyUdev();
  if (!legacy) return { ok: true, msg: 'старых правил нет' };
  const r = sudoRun(['rm', '-f', legacy.file]);
  if (!r.ok) return r;
  sudoRun(['udevadm', 'control', '--reload-rules']);
  sudoRun(['udevadm', 'trigger', '--subsystem-match=block', '--action=change']);
  sudoRun(['systemctl', 'restart', 'udisks2']);
  return { ok: true, msg: `удалены старые правила ${legacy.file}` };
}
