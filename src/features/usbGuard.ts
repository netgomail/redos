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
import { joinScsiName } from '../utils/scsi';
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
 * Опознаются по идентификатору, а не по классу интерфейса, и это
 * принципиально: класс у них не отражает назначение. Rutoken lite HID и
 * Rutoken ECP HID объявляют себя устройствами ввода, Rutoken S — вендорским
 * классом, Rutoken Mass Storage — накопителем. Запрет категории «накопители»
 * иначе отрубил бы вход по токену и подпись.
 *
 * Перечислены конкретные модели, а не весь производитель (было `0a89:*`).
 * Причина в том, что идентификатор подделывается тривиально: с шаблоном на
 * весь вендор достаточно было перепрошить VID обычной флешки, чтобы она
 * прошла мимо заблокированной категории «накопители». Список выверен по
 * системной базе /usr/share/hwdata/usb.ids (вендор 0a89, «Aktiv»).
 *
 * Модели, которых в списке нет, вносятся администратором поимённо — в
 * исключения, по хешу дескриптора.
 */
export const TOKEN_DEVICE_IDS = [
  '0a89:0001',  // Guardant Stealth/Net
  '0a89:0002',  // Guardant ID
  '0a89:0003',  // Guardant Stealth 2
  '0a89:0004',  // Rutoken
  '0a89:0005',  // Guardant Fidus
  '0a89:0006',  // Guardant Stealth 3
  '0a89:0007',  // Guardant Stealth 2
  '0a89:0008',  // Guardant Stealth 3 Sign/Time
  '0a89:0009',  // Guardant Code
  '0a89:000a',  // Guardant Sign Pro
  '0a89:000b',  // Guardant Sign Pro HID
  '0a89:000c',  // Guardant Stealth 3 Sign/Time
  '0a89:000d',  // Guardant Code HID
  '0a89:000f',  // Guardant System Firmware Update
  '0a89:0020',  // Rutoken S
  '0a89:0025',  // Rutoken lite
  '0a89:0026',  // Rutoken lite HID
  '0a89:002a',  // Rutoken Mass Storage
  '0a89:002b',  // Guardant Mass Storage
  '0a89:0030',  // Rutoken ECP
  '0a89:0040',  // Rutoken ECP HID
  '0a89:0060',  // Rutoken Magistra
  '0a89:0061',  // Rutoken Magistra
  '0a89:0069',  // Reader
  '0a89:0080',  // Rutoken PinPad Ex
  '0a89:0081',  // Rutoken PinPad In
  '0a89:0082',  // Rutoken PinPad 2
];

/**
 * Класс интерфейса «накопитель». Устройство, которое его объявляет, не
 * проходит по правилу токена, даже если совпал идентификатор: подделать VID
 * и PID проще, чем что-либо ещё, а накопитель — тот самый канал утечки,
 * ради которого всё и делается.
 */
const STORAGE_CLASS = '08';

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
  { id: 'token',     title: 'Криптотокены (Рутокен)', classes: [], ids: TOKEN_DEVICE_IDS, locked: true,
    hint: 'Рутокен и Guardant — по производителю Актив: часть моделей объявляет себя HID или накопителем' },
  { id: 'input',     title: 'Клавиатуры и мыши',    classes: ['03:*:*'], locked: true,
    hint: 'класс HID: без них машиной не управлять, блокировать нечего' },
  { id: 'storage',   title: 'Накопители',           classes: ['08:*:*'],
    hint: 'флешки, внешние диски, картридеры, USB-приводы' },
  { id: 'printer',   title: 'Принтеры',             classes: ['07:*:*'], locked: true,
    hint: 'принтеры и часть МФУ — рабочая необходимость' },
  { id: 'imaging',   title: 'Сканеры и камеры',     classes: ['06:*:*'], locked: true,
    hint: 'PTP/MTP: сканеры, фотоаппараты' },
  { id: 'video',     title: 'Веб-камеры',           classes: ['0e:*:*'],
    hint: 'в том числе встроенная камера ноутбука' },
  { id: 'audio',     title: 'Звук и гарнитуры',     classes: ['01:*:*'],
    hint: 'USB-наушники, микрофоны, звуковые карты' },
  { id: 'network',   title: 'Сеть и модемы',        classes: ['02:*:*', '0a:*:*'],
    hint: 'USB-сетевые адаптеры, модемы, режим модема у телефона' },
  { id: 'wireless',  title: 'Bluetooth и радио',    classes: ['e0:*:*'],
    hint: 'в том числе встроенный Bluetooth' },
  { id: 'smartcard', title: 'Смарт-карты и токены', classes: ['0b:*:*'], locked: true,
    hint: 'считыватели смарт-карт и CCID-модели Рутокена' },
];

/**
 * Всегда разрешены и не показываются переключателем: блокировать их незачем,
 * а возможность это сделать — только источник ошибок. Хабы держат всё дерево
 * устройств, ввод — управление машиной, принтеры и сканеры нужны для работы,
 * токены и смарт-карты — для входа и подписи. Каналом утечки ни один из них
 * не является.
 */
export const LOCKED_CATEGORIES: CategoryId[] = CATEGORIES.filter(c => c.locked).map(c => c.id);

/** Категории, которые администратор действительно выбирает. */
export const SELECTABLE_CATEGORIES: Category[] = CATEGORIES.filter(c => !c.locked);

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

/**
 * Наличие usbguard определяется по файлу, а не запуском.
 *
 * У утилиты нет ни --version, ни --help как опции: `usbguard --version`
 * печатает справку и выходит с кодом 1, а `usbguard` без аргументов —
 * с кодом 0. То есть по коду возврата присутствие не определить, а по тексту
 * тем более: сообщение runPty об отсутствующей команде само содержит слово
 * «usbguard». Проверяем файл, версию спрашиваем у пакетного менеджера.
 */
const USBGUARD_PATHS = ['/usr/bin/usbguard', '/usr/sbin/usbguard', '/bin/usbguard'];

function usbguardBinary(): string | null {
  return USBGUARD_PATHS.find(p => existsSync(p)) ?? null;
}

async function packageVersion(): Promise<string> {
  const out = await runPtyLines(['rpm', '-q', '--qf', '%{VERSION}', 'usbguard'],
                                { env: C_LOCALE, timeoutMs: 10_000 });
  const v = out.join('').trim();
  return /^\d+\.\d+/.test(v) ? 'usbguard ' + v : '';
}

export async function readStatus(): Promise<GuardStatus> {
  const installed = usbguardBinary() !== null;
  const verLine = installed ? await packageVersion() : '';

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

// ─── имена устройств ─────────────────────────────────────────────────────────

/**
 * Человекочитаемые имена классов интерфейсов — чтобы «вне категорий» не было
 * загадкой: администратор должен видеть, что перед ним, а не только код.
 */
const CLASS_NAMES: Record<string, string> = {
  '00': 'на уровне интерфейсов', '01': 'аудио', '02': 'связь', '03': 'ввод',
  '05': 'физический', '06': 'изображение', '07': 'принтер', '08': 'накопитель',
  '09': 'хаб', '0a': 'данные связи', '0b': 'смарт-карта', '0d': 'защита контента',
  '0e': 'видео', '0f': 'здоровье', '10': 'аудио/видео', '11': 'billboard',
  '12': 'мост Type-C', 'dc': 'диагностика', 'e0': 'беспроводной',
  'ef': 'разное', 'fe': 'специальный', 'ff': 'вендорский',
};

export function describeInterfaces(interfaces: string[]): string {
  const names = new Set<string>();
  for (const i of interfaces) {
    const c = i.split(':')[0]?.toLowerCase();
    if (c) names.add(`${c} — ${CLASS_NAMES[c] ?? 'неизвестный класс'}`);
  }
  return [...names].join(', ');
}

/**
 * Имя устройства из системной базы /usr/share/hwdata/usb.ids.
 *
 * Нужно потому, что дескриптор часто пуст: флешка 24a9:205a на тестовой
 * машине сообщает в iProduct одни пробелы, и usbguard показывает пустое имя.
 * Формат базы: строка "vvvv  Название производителя", ниже строки с отступом
 * табуляцией "pppp  Название модели".
 */
let usbIdsCache: Map<string, { vendor: string; products: Map<string, string> }> | null = null;

function loadUsbIds(): Map<string, { vendor: string; products: Map<string, string> }> {
  if (usbIdsCache) return usbIdsCache;
  const map = new Map<string, { vendor: string; products: Map<string, string> }>();
  const text = readFile('/usr/share/hwdata/usb.ids') ?? readFile('/usr/share/misc/usb.ids') ?? '';
  let current: { vendor: string; products: Map<string, string> } | null = null;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const v = line.match(/^([0-9a-f]{4})\s+(.+)$/);
    if (v) { current = { vendor: v[2].trim(), products: new Map() }; map.set(v[1], current); continue; }
    const p = line.match(/^\t([0-9a-f]{4})\s+(.+)$/);
    if (p && current) current.products.set(p[1], p[2].trim());
    // Строки с двумя табуляциями — протоколы интерфейсов, они нам не нужны,
    // как и секции после списка производителей (C 00, AT ...): их отсеет
    // проверка на 4 hex-символа.
  }
  usbIdsCache = map;
  return map;
}

/** «Realtek Semiconductor Corp. RTS5129 Card Reader Controller» или ''. */
export function lookupUsbName(deviceId: string): string {
  const [v, p] = (deviceId || '').toLowerCase().split(':');
  if (!v || !p) return '';
  const entry = loadUsbIds().get(v);
  if (!entry) return '';
  const product = entry.products.get(p);
  return product ? `${entry.vendor} ${product}` : entry.vendor;
}

/**
 * Как показать устройство человеку. Дескриптор бывает пустым или из пробелов,
 * поэтому имя собирается по цепочке: дескриптор → системная база → серийный
 * номер → блочный узел.
 */
export function describeDevice(d: GuardDevice): string {
  // Модель носителя информативнее дескриптора: у внешнего диска в дескрипторе
  // стоит название USB-SATA-моста («ASMT105x»), а не самого диска.
  const disk = d.sysfs?.storage?.[0];
  if (disk?.fullName) return disk.fullName;
  if (d.remembered?.model) return d.remembered.model;

  const fromSysfs = [d.sysfs?.manufacturer, d.sysfs?.product]
    .map(x => (x ?? '').trim()).filter(Boolean).join(' ');
  if (fromSysfs) return fromSysfs;

  const fromDescriptor = d.name.trim();
  if (fromDescriptor) return fromDescriptor;

  const fromDb = lookupUsbName(d.deviceId);
  if (fromDb) return fromDb;

  if (d.serial) return `без имени, S/N ${d.serial}`;
  return 'без имени';
}

/** Размер устройства с пометкой, если он взят из памяти, а не с живого носителя. */
export function describeSize(d: GuardDevice): { text: string; stale: boolean } {
  const disk = d.sysfs?.storage?.[0];
  if (disk?.sizeBytes) return { text: fmtSize(disk.sizeBytes), stale: false };
  if (disk)            return { text: 'нет носителя', stale: false };
  if (d.remembered?.sizeBytes) return { text: fmtSize(d.remembered.sizeBytes), stale: true };
  return { text: '—', stale: false };
}

/** Читаемый размер: 238,5 ГБ. */
export function fmtSize(bytes: number): string {
  if (!bytes) return '';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i < 2 ? 0 : 1).replace('.', ',')} ${u[i]}`;
}

/**
 * Тип устройства человеческим языком — как в разделе «Носители информации»
 * инвентаризации. Для накопителей берётся из sysfs, для прочего — категория.
 */
export function describeKind(d: GuardDevice): string {
  const disk = d.sysfs?.storage?.[0];
  if (disk) {
    if (disk.sizeBytes) return disk.kind;
    return disk.kind === 'картридер' ? 'картридер (нет карты)' : `${disk.kind} (пусто)`;
  }
  if (d.remembered) return d.remembered.kind;
  if (d.categories.length) {
    return CATEGORIES.find(c => c.id === d.categories[0])?.title ?? d.categories[0];
  }
  return `вне категорий: ${describeInterfaces(d.interfaces)}`;
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
  /** Данные из sysfs: модель, производитель, размер, тип носителя. */
  sysfs?: UsbSysfsDevice;
  /** Что было известно, когда устройство в последний раз было разрешено. */
  remembered?: RememberedDevice;
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
 * Всё, что известно о USB-устройствах из sysfs.
 *
 * Читается напрямую, без внешних утилит, и работает даже для заблокированных
 * устройств: деавторизованное устройство остаётся в дереве /sys, у него просто
 * не конфигурируются интерфейсы. Поэтому модель и производителя видно и тогда,
 * когда блочного узла уже нет.
 */
export interface UsbSysfsDevice {
  port:         string;   // 2-4 — он же via-port в правилах usbguard
  deviceId:     string;   // 24a9:205a
  serial:       string;
  manufacturer: string;
  product:      string;
  authorized:   boolean;
  storage:      UsbStorageNode[];
}

export interface UsbStorageNode {
  block:     string;   // sdc
  sizeBytes: number;   // 0 — носитель не вставлен
  model:     string;   // из /sys/block/sdX/device/model
  vendor:    string;
  /** Производитель и модель, склеенные с учётом границы SCSI-полей. */
  fullName:  string;
  removable: boolean;
  rotational: boolean;
  /** «USB-флешка», «USB-накопитель» — та же классификация, что в /inventory. */
  kind:      string;
}

const sysRead = (p: string): string => (readFile(p) ?? '').trim();

/**
 * Тип носителя словами. Основа та же, что в разделе «Носители информации»
 * инвентаризации, плюс распознавание картридеров.
 *
 * Картридер отличается от флешки двумя признаками. Первый надёжный: флешка
 * всегда сообщает свой размер, а пустой слот отдаёт ноль. Второй —
 * перечисление форматов карт в модели («xD/SD/M.S.» у встроенного Realtek).
 */
function classifyUsbBlock(removable: boolean, sizeBytes: number, model: string): string {
  if (!removable) return 'USB-накопитель';
  const looksLikeReader = /xD|SD\b|M\.S\.|MMC|CF\b|CRW|card\s*reader/i.test(model);
  if (looksLikeReader || sizeBytes === 0) return 'картридер';
  return 'USB-флешка';
}

/** Блочные узлы, поднятые через USB, с привязкой к каталогу usb_device. */
function usbBlockNodes(): Map<string, UsbStorageNode[]> {
  const byUsbDir = new Map<string, UsbStorageNode[]>();
  let names: string[];
  try { names = readdirSync('/sys/block'); } catch { return byUsbDir; }

  for (const name of names) {
    let real: string;
    try { real = realpathSync(`/sys/block/${name}`); } catch { continue; }
    if (!/\/usb\d+\//.test(real)) continue;

    // Поднимаемся до ближайшего предка с idVendor — это usb_device
    let dir = real;
    while (dir !== '/' && !existsSync(join(dir, 'idVendor'))) dir = dirname(dir);
    if (dir === '/') continue;

    const rawVendor  = readFile(`/sys/block/${name}/device/vendor`) ?? '';
    const rawModel   = readFile(`/sys/block/${name}/device/model`)  ?? '';
    const removable  = sysRead(`/sys/block/${name}/removable`) === '1';
    const sizeBytes  = Number(sysRead(`/sys/block/${name}/size`) || 0) * 512;
    const rotational = sysRead(`/sys/block/${name}/queue/rotational`) === '1';
    const node: UsbStorageNode = {
      block:     name,
      sizeBytes,
      model:     rawModel.trim(),
      vendor:    rawVendor.trim(),
      fullName:  joinScsiName(rawVendor, rawModel),
      removable,
      rotational,
      kind: classifyUsbBlock(removable, sizeBytes, joinScsiName(rawVendor, rawModel)),
    };
    byUsbDir.set(dir, [...(byUsbDir.get(dir) ?? []), node]);
  }
  return byUsbDir;
}

export function listUsbSysfs(): UsbSysfsDevice[] {
  const blocks = usbBlockNodes();
  const out: UsbSysfsDevice[] = [];
  let ports: string[];
  try { ports = readdirSync('/sys/bus/usb/devices'); } catch { return out; }

  for (const port of ports) {
    const dir = `/sys/bus/usb/devices/${port}`;
    if (!existsSync(join(dir, 'idVendor'))) continue;
    let real = dir;
    try { real = realpathSync(dir); } catch { /* оставляем как есть */ }

    out.push({
      port,
      deviceId:     `${sysRead(join(dir, 'idVendor'))}:${sysRead(join(dir, 'idProduct'))}`,
      serial:       sysRead(join(dir, 'serial')),
      manufacturer: sysRead(join(dir, 'manufacturer')),
      product:      sysRead(join(dir, 'product')),
      authorized:   sysRead(join(dir, 'authorized')) === '1',
      storage:      blocks.get(real) ?? [],
    });
  }
  return out;
}

export async function listDevices(): Promise<GuardDevice[]> {
  const lines = await runPtyLines(['usbguard', 'list-devices'], { env: C_LOCALE, timeoutMs: 20_000 });
  const devices = lines.map(parseDeviceLine).filter((d): d is GuardDevice => d !== null);

  // Обогащаем данными из sysfs: модель, размер, тип носителя. usbguard их не
  // знает — он оперирует только атрибутами дескриптора, — а администратору
  // нужно видеть то же, что показывает инвентаризация.
  const sysfs = listUsbSysfs();
  for (const d of devices) {
    const match = sysfs.find(s => s.port === d.viaPort)
      ?? sysfs.find(s => s.deviceId.toLowerCase() === d.deviceId.toLowerCase() &&
                         (!d.serial || !s.serial || s.serial === d.serial));
    if (!match) continue;
    d.sysfs = match;
    if (match.storage.length > 0) d.storageNodes = match.storage.map(n => n.block);
  }

  // Запоминаем размеры разрешённых и подставляем запомненное заблокированным
  saveRemembered(devices);
  const cache = loadRemembered();
  for (const d of devices) {
    if (d.sysfs?.storage?.length) continue;
    const r = cache[rememberKey(d)];
    if (r) d.remembered = r;
  }
  return devices;
}

// ─── память об устройствах ───────────────────────────────────────────────────

const CACHE_FILE = '/var/lib/redos/usb-devices.json';

export interface RememberedDevice {
  model:     string;
  kind:      string;
  sizeBytes: number;
  seen:      string;   // ISO-дата последнего подключения
}

/**
 * Заблокированное устройство не отдаёт ни размера, ни типа носителя: ядро не
 * конфигурирует его интерфейсы, блочного узла не появляется. Производитель и
 * модель в sysfs остаются, а размер спросить не у кого.
 *
 * Поэтому то, что удалось узнать, пока устройство было разрешено, сохраняется
 * и показывается с пометкой «по данным последнего подключения». Выдавать это
 * за текущее состояние нельзя — флешку могли подменить.
 */
function loadRemembered(): Record<string, RememberedDevice> {
  try { return JSON.parse(readFile(CACHE_FILE) ?? '{}'); } catch { return {}; }
}

function rememberKey(d: GuardDevice): string {
  return d.hash || `${d.deviceId}:${d.serial}`;
}

function saveRemembered(devices: GuardDevice[]): void {
  const cache = loadRemembered();
  let changed = false;
  for (const d of devices) {
    const disk = d.sysfs?.storage?.[0];
    if (!disk || !disk.sizeBytes) continue;
    const model = disk.fullName;
    const key = rememberKey(d);
    const prev = cache[key];
    if (prev && prev.sizeBytes === disk.sizeBytes && prev.model === model) continue;
    cache[key] = { model, kind: disk.kind, sizeBytes: disk.sizeBytes, seen: new Date().toISOString() };
    changed = true;
  }
  if (!changed) return;
  sudoRun(['mkdir', '-p', '/var/lib/redos']);
  writeSudo(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
}

/**
 * Пропустит ли устройство политика при таком наборе разрешённых категорий.
 *
 * Повторяет семантику сгенерированных правил: match-all по классам плюс
 * разрешение по идентификатору для категорий вроде криптотокенов. Нужна,
 * чтобы показывать в списке только те устройства, судьбу которых
 * администратор ещё должен решить.
 */
export function allowedByCategories(d: GuardDevice, allowed: Set<CategoryId>): boolean {
  const active = CATEGORIES.filter(c => c.locked || allowed.has(c.id));

  // Категории, опознаваемые по идентификатору (токены), — отдельным правилом.
  // Условие none-of { 08:*:* } из правил повторяем здесь: устройство с
  // накопительным интерфейсом по идентификатору токена не проходит.
  const isStorage = d.interfaces.some(i => i.split(':')[0].toLowerCase() === STORAGE_CLASS);
  if (!isStorage && active.some(c => c.ids?.some(pat => idMatches(d.deviceId, pat)))) return true;

  if (d.interfaces.length === 0) return false;
  const classes = new Set(active.flatMap(c => c.classes).map(p => p.split(':')[0].toLowerCase()));
  return d.interfaces.every(i => classes.has(i.split(':')[0].toLowerCase()));
}

// ─── установка ───────────────────────────────────────────────────────────────

/** Ставит usbguard из репозитория. Пакет есть в штатном репозитории РЕД ОС. */
export async function install(onStep: (m: string) => void = () => {}): Promise<FixResult> {
  if (usbguardBinary()) {
    onStep('usbguard уже установлен');
    return { ok: true, msg: 'usbguard уже установлен' };
  }
  onStep('Устанавливаю usbguard из репозитория...');
  const r = await runPty(['dnf', 'install', '-y', 'usbguard'], {
    env: C_LOCALE,
    timeoutMs: 300_000,
    onLine: l => { if (l.trim()) onStep(l.trim()); },
  });
  if (r.code !== 0) {
    return { ok: false, msg: `dnf install usbguard завершился с кодом ${r.code}` };
  }
  const bin = usbguardBinary();
  if (!bin) {
    return { ok: false, msg: `dnf отработал, но исполняемого файла нет ни в одном из: ${USBGUARD_PATHS.join(', ')}` };
  }
  const ver = await packageVersion();
  return { ok: true, msg: `Установлено: ${bin}${ver ? ' (' + ver + ')' : ''}` };
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
    '# Разрешены всегда и опознаются по идентификатору, а не по классу:',
    '# Rutoken ECP HID объявляет себя устройством ввода, Rutoken S —',
    '# вендорским классом. Запрет категории «накопители» иначе отрубил бы',
    '# вход по токену и подпись.',
    '#',
    '# Модели перечислены поимённо, и к каждой добавлено условие',
    '# none-of { 08:*:* }: идентификатор подделывается тривиально, а без',
    '# этого условия достаточно было перепрошить VID обычной флешки, чтобы',
    '# она прошла мимо заблокированной категории «накопители».',
    '#',
    '# Токен, который объявляет накопитель (Rutoken Mass Storage), под это',
    '# правило не подпадает: он проходит по категории «накопители», а если',
    '# она закрыта — вносится в исключения по хешу дескриптора.',
    '#',
    '# Правила стоят ПОСЛЕ reject-ов выше — намеренно: подложное устройство',
    '# «Рутокен + клавиатура» должно быть отклонено, а не разрешено.',
    ...CATEGORIES.filter(c => c.locked && c.ids?.length)
                 .flatMap(c => (c.ids ?? [])
                   .map(id => `allow id ${id} with-interface none-of { ${STORAGE_CLASS}:*:* }`)),
    '',
    '# ── Разрешённые категории ───────────────────────────────────────────────',
    '# match-all: устройство проходит, только если ВСЕ его интерфейсы входят',
    '# в разрешённый набор. Заблокированного здесь нет: оно не упоминается',
    '# в правилах вовсе и отсекается неявной политикой в конце файла.',
    '#',
    // Перечень разрешённого переносим по строкам: файл читают глазами
    ...wrapComment(CATEGORIES.filter(c => allowed.has(c.id) && c.classes.length)
                             .map(c => c.title.toLowerCase()).join(', '), 'Разрешено: '),
    `allow with-interface match-all { ${classes.join(' ')} }`,
  ];

  if (input.trusted.some(t => t.deviceId || t.serial || t.hash)) {
    lines.push(
      '',
      '# ── Доверенные устройства ───────────────────────────────────────────────',
      '# Опознаются по хешу дескриптора: serial подделывается, хеш — нет.',
    );
    for (const t of input.trusted) {
      // Устройство без единого признака дало бы строку «allow» — правило,
      // разрешающее вообще всё и стоящее выше неявной блокировки. Такое
      // исключение молча пропускаем: разрешать нечего.
      if (!t.deviceId && !t.serial && !t.hash) continue;
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

/** Разбивает длинный перечень на строки-комментарии по ширине 72 символа. */
function wrapComment(text: string, prefix: string): string[] {
  const out: string[] = [];
  let line = prefix;
  for (const word of text.split(' ')) {
    if (line.length + word.length + 3 > 72) { out.push('# ' + line.trimEnd()); line = '  '; }
    line += word + ' ';
  }
  if (line.trim()) out.push('# ' + line.trimEnd());
  return out;
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

/**
 * Читает применённую политику обратно из rules.conf.
 *
 * Восстанавливать выбор по списку подключённых устройств нельзя: если ни одна
 * веб-камера сейчас не воткнута, категория «веб-камеры» выглядела бы
 * запрещённой, хотя в правилах она разрешена. Источник истины — сам файл.
 */
export function readAppliedPolicy(): PolicyInput | null {
  const text = readFile(RULES_FILE);
  if (!text || !text.includes(HEADER_MARK)) return null;

  const classes = text.match(/^allow\s+with-interface\s+match-all\s*\{([^}]*)\}/m)?.[1] ?? '';
  const allowedClasses = new Set(
    classes.trim().split(/\s+/).filter(Boolean).map(c => c.split(':')[0].toLowerCase()));

  const allowed = CATEGORIES
    .filter(c => c.classes.length > 0 &&
                 c.classes.every(p => allowedClasses.has(p.split(':')[0].toLowerCase())))
    .map(c => c.id);

  const trusted: TrustedDevice[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Правила категорий и токенов пропускаем: нас интересуют поимённые.
    // Токены теперь записаны конкретными идентификаторами и под регулярное
    // выражение подходят — отсекаем их по списку моделей.
    const m = l.match(/^allow\s+id\s+([0-9a-f]{4}:[0-9a-f]{4})\b(.*)$/i);
    if (!m) continue;
    if (TOKEN_DEVICE_IDS.includes(m[1].toLowerCase())) continue;
    const rest = m[2];
    const prev = (lines[i - 1] ?? '').trim();
    trusted.push({
      deviceId: m[1],
      serial:   rest.match(/\bserial\s+"((?:[^"\\]|\\.)*)"/)?.[1] ?? '',
      hash:     rest.match(/\bhash\s+"((?:[^"\\]|\\.)*)"/)?.[1] ?? '',
      name:     prev.startsWith('#') ? prev.replace(/^#\s*/, '') : '',
    });
  }
  return { allowed, trusted };
}

// ─── применение ──────────────────────────────────────────────────────────────

export interface ApplyResult extends FixResult {}

/**
 * Применяет политику с сеткой безопасности.
 *
 * Порядок такой, чтобы машина не осталась без клавиатуры:
 *  1. запоминаем, какие устройства ввода разрешены сейчас;
 *  2. пишем rules.conf и usbguard-daemon.conf;
 *  3. перезапускаем демона и ждём, пока он отдаст список устройств;
 *  4. приводим уже подключённые устройства в соответствие с политикой;
 *  5. ПРОВЕРКА: каждое устройство ввода, разрешённое до применения, разрешено
 *     и после; потерявшим доступ возвращаем его точечно.
 *
 * Отката к прежней конфигурации здесь нет — намеренно, вместо него точечная
 * страховка на шаге 5. Файлы отката жили в /etc, переживали перезагрузку и
 * сами становились источником путаницы: администратор видел рядом с активной
 * политикой её прошлую копию неизвестного возраста. Возврат к прежнему
 * состоянию делается осознанно — командой «снять политику».
 *
 * Проверка на устройствах ввода заодно ловит и то, что версия usbguard не
 * поняла оператор match-all: тогда правило не загрузится, клавиатура окажется
 * заблокированной, и доступ ей вернут здесь же.
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

  // 1. Запись
  onStep('Записываю правила и конфигурацию демона');
  const w1 = writeSudo(RULES_FILE, generateRules(input));
  if (!w1.ok) return { ok: false, msg: `${RULES_FILE}: ${w1.msg}` };
  const w2 = writeSudo(DAEMON_CONF, generateDaemonConf(readFile(DAEMON_CONF) ?? ''));
  if (!w2.ok) return { ok: false, msg: `${DAEMON_CONF}: ${w2.msg}` };
  sudoRun(['chmod', '600', RULES_FILE]);

  // 2. Запуск
  onStep('Перезапускаю usbguard');
  // Автозапуск и запуск — разные вещи, и провал автозапуска молчаливым быть не
  // должен: без него политика действует до первой перезагрузки, а
  // администратор видит «политика применена» и считает машину защищённой.
  const en = sudoRun(['systemctl', 'enable', status.serviceUnit]);
  const rs = sudoRun(['systemctl', 'restart', status.serviceUnit]);
  if (!rs.ok) {
    return { ok: false, msg: `демон не запустился: ${rs.msg}` };
  }

  // 3. Ждём, пока демон поднимется и разберёт устройства.
  // Фиксированная пауза здесь не годится: на холодном старте (первое
  // включение, служба ещё не была запущена) usbguard успевает ответить не
  // сразу, и проверка отрабатывала по пустому списку.
  let after: GuardDevice[] = [];
  for (let i = 0; i < 20; i++) {
    await new Promise<void>(r => setTimeout(r, 500));
    const active = await runPtyLines(['systemctl', 'is-active', status.serviceUnit],
                                     { env: C_LOCALE, timeoutMs: 8000 });
    if (!active.some(l => l.trim() === 'active')) continue;
    after = await listDevices();
    if (after.length > 0) break;
  }
  if (after.length === 0) {
    return { ok: false, msg: 'usbguard не отдал список устройств за 10 секунд — проверьте systemctl status usbguard' };
  }

  // 4. Приводим уже подключённые устройства в соответствие с политикой.
  // PresentDevicePolicy=apply-policy делает это при старте демона, но на
  // холодном старте часть устройств может остаться в прежнем состоянии —
  // тогда блокировка вступала в силу только со второго применения.
  const trustedKeys = new Set(input.trusted.map(t => t.hash || `${t.deviceId}:${t.serial}`));
  const allowedSet = new Set(input.allowed);
  let enforced = 0;
  for (const d of after) {
    const shouldAllow = allowedByCategories(d, allowedSet) ||
                        trustedKeys.has(d.hash || `${d.deviceId}:${d.serial}`);
    if (shouldAllow || d.target !== 'allow') continue;
    onStep(`Применяю блокировку к ${describeDevice(d)}`);
    if (sudoRun(['usbguard', 'block-device', String(d.id)]).ok) enforced++;
  }
  if (enforced > 0) {
    await new Promise<void>(r => setTimeout(r, 500));
    after = await listDevices();
  }

  onStep('Проверяю, что клавиатура и мышь остались доступны');
  // Отката конфигурации нет: вместо него точечная страховка. Если устройство
  // ввода вдруг оказалось заблокировано, разблокируем его сразу — иначе
  // администратор останется без клавиатуры и не сможет ничего исправить.
  const lost = inputBefore.filter(b => !after.some(a => a.hash === b.hash && a.target === 'allow'));
  for (const b of lost) {
    const now = after.find(a => a.hash === b.hash);
    if (!now) continue;
    onStep(`Возвращаю доступ устройству ввода: ${describeDevice(now)}`);
    sudoRun(['usbguard', 'allow-device', '-p', String(now.id)]);
  }
  if (lost.length > 0) {
    await new Promise<void>(r => setTimeout(r, 500));
    after = await listDevices();
  }

  // Итог описывает решение администратора: какие категории он закрыл и какие
  // устройства разрешил поимённо. Пересчёт заблокированных устройств здесь
  // неуместен — устройства политикой не блокируют, их блокирует категория.
  const blockedTitles = SELECTABLE_CATEGORIES
    .filter(c => !input.allowed.includes(c.id))
    .map(c => c.title.toLowerCase());

  const lines = ['Политика применена'];
  if (!en.ok) {
    lines.push('ВНИМАНИЕ: автозапуск usbguard включить не удалось — после ' +
               'перезагрузки политика действовать не будет.',
               `Причина: ${en.msg}`,
               `Включите вручную: systemctl enable ${status.serviceUnit}`);
  }
  lines.push(blockedTitles.length
    ? `Заблокированы категории: ${blockedTitles.join(', ')}`
    : 'Заблокированных категорий нет — разрешено всё');
  if (input.trusted.length) {
    lines.push(`Разрешены устройства: ${input.trusted.map(t => t.name || t.deviceId).join(', ')}`);
  }

  return { ok: true, msg: lines.join('\n') };
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
