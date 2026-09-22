/**
 * Контроль USB-устройств на правилах udev.
 *
 * Устройство вне политики деавторизуется ядром: в /sys/…/authorized пишется 0,
 * ядро отвязывает драйверы, блочного узла не появляется вовсе. Прежняя
 * udev-подсказка UDISKS_IGNORE так не умела — она гасила только
 * автомонтирование, устройство оставалось в системе, и «Диски» монтировали его
 * по кнопке. Отсюда же берётся отказ от USBGuard: тот же результат достигается
 * штатным udev, без пакета из репозитория, недоступного на изолированных
 * машинах.
 *
 * Категории устройств — классы интерфейсов USB по спецификации usb.org. Их
 * udev видит напрямую: как ATTR{bInterfaceClass} на событии usb_interface и как
 * файлы bInterfaceClass в sysfs. Это те же величины, которыми оперировал
 * USBGuard в with-interface, поэтому набор категорий переносится без потерь.
 *
 * Модель — белый список: разрешено то, что выбрано, всё прочее блокируется.
 * Проверка идёт по ВСЕМ интерфейсам устройства сразу: иначе композитное
 * устройство {08, 03} прошло бы по разрешённому HID и протащило накопитель.
 *
 * С одной оговоркой. Блокирует интерфейс, чей класс относится к выключенной
 * категории; класс, не покрытый категориями вовсе (вендорский ff), устройство
 * не блокирует — разрешить его всё равно нечем, галочки для него нет. Без
 * оговорки не работал ни один принтер HP: он объявляет 07 и рядом свой ff, и
 * запрет срабатывал даже при всех включённых категориях. Пройти по одному ff
 * устройство не может: нужен хотя бы один интерфейс из разрешённых.
 *
 * Три файла на машине:
 *   /etc/udev/rules.d/99-block-usb.rules   правило: вызвать скрипт на событии
 *   /usr/local/sbin/redos-block-usb.sh     решение: читает политику и sysfs
 *   /etc/redos/device-control.conf         сама политика (её же читает утилита)
 *
 * Политика вынесена из правил в отдельный файл намеренно. Решение принимается
 * по всем интерфейсам устройства, а udev-правило видит их по одному: GOTO,
 * пропустивший доверенное устройство на одном интерфейсе, не помешал бы
 * заблокировать его же на другом.
 *
 * Отличие от USBGuard, которое стоит знать: демон решал до конфигурации
 * устройства, а udev-правило срабатывает после — устройство успевает
 * подняться и деавторизуется через доли секунды.
 */

import { readdirSync, realpathSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { readFile } from '../utils/fs';
import { joinScsiName } from '../utils/scsi';
import { sudoRun, writeSudo } from '../utils/sudo';
import type { FixResult } from '../utils/sudo';
import { findUsbGuardTraces } from './usbGuardLegacy';
import type { UsbGuardTraces } from './usbGuardLegacy';

export const RULES_FILE   = '/etc/udev/rules.d/99-block-usb.rules';
export const BLOCK_SCRIPT = '/usr/local/sbin/redos-block-usb.sh';
export const POLICY_FILE  = '/etc/redos/device-control.conf';

const HEADER_MARK = '# redos-device-control: managed';

/**
 * Следы udev-политики версии 0.9: она блокировала только накопители и метила
 * файлы своим маркером. Их надо не показывать как чужие правила, а убирать при
 * включении контроля — иначе старое правило продолжит работать рядом с новым.
 */
const LEGACY_MARK  = '# redos-usb-policy: managed';
const LEGACY_FILES = [
  '/etc/udev/rules.d/99-redos-usb.rules',
  '/usr/local/sbin/redos-block-usb-storage.sh',
];

/** Файл писала эта утилита — текущей версией или прошлой. */
function isOurs(content: string): boolean {
  return content.includes(HEADER_MARK) || content.includes(LEGACY_MARK);
}

/** Удаляет файлы прошлой udev-политики (только свои, по маркеру). */
function removeLegacyFiles(): number {
  let removed = 0;
  for (const f of LEGACY_FILES) {
    const content = readFile(f);
    if (!content?.includes(LEGACY_MARK)) continue;
    if (sudoRun(['rm', '-f', f]).ok) removed++;
  }
  return removed;
}

/**
 * Маркеры формата политики.
 *
 * Разрешённые категории записываются явно, а не восстанавливаются из набора
 * классов: обратный разбор ошибается, как только категория состоит больше чем
 * из одного класса. «Сеть и модемы» — это 02 и 0a: потеряется один, и
 * категория прочитается как запрещённая, хотя запрещали не её.
 *
 * Версия 2 — udev-политика; 1 была у файла правил USBGuard. Версия 3 добавила
 * второй рубеж по блочному узлу и опознание накопителя по SCSI-переносу.
 * Версия 4 перестала блокировать устройство из-за класса, не покрытого ни
 * одной категорией, — из-за него не проходил ни один принтер HP. Всё это
 * живёт в скрипте и правиле, поэтому старую установку нужно переприменить.
 */
const POLICY_VERSION  = 4;
const VERSION_MARK    = '# redos-device-control-version:';
const CATEGORIES_MARK = '# redos-device-control-categories:';
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

/**
 * Подкласс SCSI и протоколы переноса, по которым интерфейс опознаётся как
 * накопитель независимо от заявленного класса.
 *
 * Встроенный картридер Realtek объявляет ff:06:50 — вендорский класс, — но
 * 06 это SCSI, а 50 Bulk-Only Transport: перед нами накопитель, и ядро видит
 * его так же, привязывая ums-realtek по совпадению class/subclass/protocol.
 * Считать такой интерфейс вендорским значило бы оставить его вне категорий
 * навсегда: администратор разрешает «Накопители», а картридер остаётся
 * заблокированным, хотя это ровно накопитель и есть.
 *
 * Обратная сторона важнее: нормализация загоняет замаскированный накопитель
 * ПОД запрет категории, а не выводит из-под него. Устройство, объявившее
 * ff:06:50, при выключенных накопителях блокируется по той же галочке.
 */
const SCSI_SUBCLASS   = '06';
const SCSI_PROTOCOLS  = ['50', '62'];   // Bulk-Only Transport и UAS

/**
 * Класс интерфейса, по которому принимается решение: заявленный, а для
 * SCSI-переноса — накопитель, чем бы устройство себя ни называло.
 */
export function effectiveClass(iface: string): string {
  const [cls, sub, proto] = iface.toLowerCase().split(':');
  if (sub === SCSI_SUBCLASS && SCSI_PROTOCOLS.includes(proto ?? '')) return STORAGE_CLASS;
  return cls ?? '';
}

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

/**
 * Классы интерфейсов, покрытые хоть какой-нибудь категорией.
 *
 * Отделяют запрет от непокрытости. Класс выключенной категории — осознанное
 * решение администратора, и устройство с таким интерфейсом блокируется.
 * Класс, которого в категориях нет вовсе, — это вендорский ff и подобные:
 * включить их нечем, галочки для них не существует.
 *
 * Различие появилось из-за принтеров. HP объявляет, кроме 07, ещё и
 * проприетарный ff — и при проверке «все интерфейсы должны быть разрешены»
 * ни один аппарат HP не проходил даже при всех включённых категориях, хотя
 * «Принтеры» стоят в locked как рабочая необходимость.
 */
export const KNOWN_CLASSES: string[] = [...new Set(
  CATEGORIES.flatMap(c => c.classes).map(p => p.split(':')[0]!.toLowerCase()),
)].sort();

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
      const cls = effectiveClass(iface);
      if (cls && c.classes.some(p => p.split(':')[0].toLowerCase() === cls)) { out.add(c.id); break; }
    }
  }
  return [...out];
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
export function describeDevice(d: UsbDevice): string {
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
export function describeSize(d: UsbDevice): { text: string; stale: boolean } {
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
export function describeKind(d: UsbDevice): string {
  const disk = d.sysfs?.storage?.[0];
  if (disk) {
    if (disk.sizeBytes) return disk.kind;
    return disk.kind === 'картридер' ? 'картридер (нет карты)' : `${disk.kind} (пусто)`;
  }
  if (d.remembered?.kind) return d.remembered.kind;

  // У заблокированного устройства живых интерфейсов нет — берём заявленные.
  const { interfaces: ifaces } = interfacesOf(d);
  const cats = d.interfaces.length ? d.categories : categoriesOf(ifaces, d.deviceId);
  if (cats.length) {
    return CATEGORIES.find(c => c.id === cats[0])?.title ?? cats[0];
  }
  // Пустой список классов — не «ни в одну категорию не попал», а «сказать
  // нечего»: устройство заблокировано и ни разу не виделось разрешённым.
  if (ifaces.length === 0) return 'классы не видны';
  // Только коды: в колонке на расшифровку словами нет ширины, и обрезанное
  // «вне категорий: …» не говорит ровно ничего. Классы словами — в разборе
  // под таблицей, где место есть.
  const codes = [...new Set(ifaces.map(i => i.split(':')[0].toLowerCase()))];
  return `вне категорий ${codes.join(',')}`;
}

/**
 * Классы интерфейсов устройства и откуда они взяты.
 *
 * Порядок источников — по убыванию достоверности:
 *  live       — ядро сконфигурировало интерфейсы, ровно по ним решает политика;
 *  declared   — дескрипторы самого устройства; есть и у заблокированного,
 *               но это его собственные слова, а не проверенный факт;
 *  remembered — что было видно при последнем подключении; устройство с тех
 *               пор могли подменить.
 *
 * Источник важен не меньше самих классов: показывать заявленное как
 * действующее — значит выдавать слова устройства за решение системы.
 */
export type InterfaceSource = 'live' | 'declared' | 'remembered' | 'none';

export function interfacesOf(d: UsbDevice): { interfaces: string[]; source: InterfaceSource } {
  if (d.interfaces.length)          return { interfaces: d.interfaces, source: 'live' };
  if (d.sysfs?.declared?.length)    return { interfaces: d.sysfs.declared, source: 'declared' };
  if (d.remembered?.interfaces?.length)
    return { interfaces: d.remembered.interfaces, source: 'remembered' };
  return { interfaces: [], source: 'none' };
}

/** Оговорка к данным не из ядра — чтобы заявленное не читалось как факт. */
const SOURCE_NOTE: Record<InterfaceSource, string> = {
  live:       '',
  declared:   ' (со слов устройства: оно заблокировано и ядром не опрошено)',
  remembered: ' (по данным последнего подключения)',
  none:       '',
};

/**
 * Почему устройство не проходит по категориям — словами, для строки деталей.
 *
 * Повторяет разбор из allowedByCategories, но вместо «да/нет» называет
 * виновный класс: администратору нужно знать, какую категорию включить, а
 * когда включать нечего — что путь один, поимённое исключение.
 */
export function explainPolicy(d: UsbDevice, allowed: Set<CategoryId>): string {
  const { interfaces: ifaces, source } = interfacesOf(d);
  if (ifaces.length === 0) {
    return 'классы интерфейсов не видны: ядро не конфигурирует их у заблокированного устройства';
  }

  const active = CATEGORIES.filter(c => c.locked || allowed.has(c.id));
  const classes = ifaces.map(effectiveClass);
  const has = (c: string) => classes.includes(c);

  if (has(STORAGE_CLASS) && (has('03') || has('02') || has('e0'))) {
    return 'накопитель вместе с клавиатурой, сетевой картой или радиомодулем — ' +
           'такое устройство блокируется независимо от категорий';
  }
  if (!has(STORAGE_CLASS) && active.some(c => c.ids?.some(pat => idMatches(d.deviceId, pat)))) {
    return 'разрешено по идентификатору: криптотокен';
  }

  const stale = SOURCE_NOTE[source];
  const known = new Set(KNOWN_CLASSES);
  const blocking:  string[] = [];   // класс выключенной категории — причина блокировки
  const uncovered: string[] = [];   // класс вне категорий — сам по себе не блокирует
  let anyAllowed = false;
  const seen = new Set<string>();
  for (const iface of ifaces) {
    const cls = effectiveClass(iface);
    if (active.some(c => c.classes.some(p => p.split(':')[0].toLowerCase() === cls))) {
      anyAllowed = true;
      continue;
    }
    if (seen.has(cls)) continue;
    seen.add(cls);

    // Заявленный класс называем как есть, а если решение приняли не по нему —
    // говорим об этом прямо: иначе строка спорит с колонкой типа.
    const declared = iface.split(':')[0]?.toLowerCase() ?? cls;
    const name = declared === cls
      ? `${cls} — ${CLASS_NAMES[cls] ?? 'неизвестный класс'}`
      : `${iface} — накопитель по SCSI-переносу, хоть и класс ${declared}`;

    const owner = CATEGORIES.find(c => c.classes.some(p => p.split(':')[0].toLowerCase() === cls));
    if (owner && known.has(cls)) blocking.push(`${name}: категория «${owner.title}» выключена`);
    else uncovered.push(name);
  }

  // Порядок ответа — от того, что решает, к тому, что просто стоит знать.
  if (blocking.length) return blocking.join('; ') + stale;
  if (!anyAllowed) {
    return `${uncovered.join('; ')}: ни одна категория его не покрывает — только поимённо${stale}`;
  }
  if (uncovered.length) {
    return `разрешено по категориям; ${uncovered.join('; ')} — вне категорий, ` +
           `но устройство из-за него не блокируется${stale}`;
  }
  return `все интерфейсы разрешены категориями${stale}`;
}

// ─── чтение sysfs ────────────────────────────────────────────────────────────

/**
 * Всё, что известно о USB-устройствах из sysfs.
 *
 * Читается напрямую, без внешних утилит, и работает даже для заблокированных
 * устройств: деавторизованное устройство остаётся в дереве /sys, у него просто
 * не конфигурируются интерфейсы. Поэтому модель и производителя видно и тогда,
 * когда блочного узла уже нет.
 */
export interface UsbSysfsDevice {
  port:         string;   // 2-4 — положение в дереве USB
  deviceId:     string;   // 24a9:205a
  serial:       string;
  manufacturer: string;
  product:      string;
  authorized:   boolean;
  /** Классы интерфейсов в виде «08:06:50» — то же представление, что у USBGuard. */
  interfaces:   string[];
  /**
   * Классы из дескрипторов, заявленных самим устройством.
   *
   * Читаются из sysfs-файла descriptors, который остаётся на месте и у
   * деавторизованного устройства, — в отличие от каталогов интерфейсов, за
   * которыми стоит уже сконфигурированное ядром. Это единственный способ
   * сказать про заблокированное устройство, что оно вообще такое.
   *
   * Решение по ним не принимается: заявленному верить нельзя, политику
   * применяет скрипт по тому, что ядро действительно сконфигурировало.
   */
  declared:     string[];
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

/**
 * Классы интерфейсов устройства из sysfs.
 *
 * Каталоги интерфейсов лежат рядом с устройством и называются «2-4:1.0».
 * У деавторизованного устройства их нет: ядро не конфигурирует интерфейсы,
 * пока не разрешена авторизация, — поэтому пустой список здесь означает не
 * «устройство без интерфейсов», а «устройство заблокировано».
 */
function readInterfaces(dir: string, port: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }

  const out: string[] = [];
  for (const e of entries) {
    if (!e.startsWith(port + ':')) continue;
    const cls = sysRead(join(dir, e, 'bInterfaceClass'));
    if (!cls) continue;
    out.push([cls, sysRead(join(dir, e, 'bInterfaceSubClass')), sysRead(join(dir, e, 'bInterfaceProtocol'))]
      .map(v => (v || '00').toLowerCase()).join(':'));
  }
  return out;
}

/**
 * Классы интерфейсов из дескрипторов устройства.
 *
 * Файл descriptors — сырой дамп: сначала дескриптор устройства, затем
 * конфигурации, а внутри них — интерфейсы. Каждая запись начинается с длины и
 * типа, так что перебор идёт по длинам, без разбора незнакомых типов.
 *
 * Берётся только первая конфигурация и только основная альтернатива каждого
 * интерфейса: ядро конфигурирует именно их, и сравнение должно идти с тем же
 * набором, что попадёт в sysfs после авторизации.
 */
function declaredInterfaces(dir: string): string[] {
  let buf: Buffer;
  try { buf = readFileSync(join(dir, 'descriptors')); } catch { return []; }

  const DESC_CONFIG = 0x02, DESC_INTERFACE = 0x04;
  const out: string[] = [];
  const seen = new Set<string>();
  let configs = 0;

  for (let i = 0; i + 1 < buf.length; ) {
    const len = buf[i]!;
    if (len < 2) break;                       // мусор: дальше не разобрать
    const type = buf[i + 1]!;
    if (type === DESC_CONFIG && ++configs > 1) break;
    // i+3 — bAlternateSetting, i+5..7 — класс, подкласс, протокол
    if (type === DESC_INTERFACE && i + 7 < buf.length && buf[i + 3] === 0) {
      const key = [buf[i + 5]!, buf[i + 6]!, buf[i + 7]!]
        .map(v => v.toString(16).padStart(2, '0')).join(':');
      if (!seen.has(key)) { seen.add(key); out.push(key); }
    }
    i += len;
  }
  return out;
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
      interfaces:   readInterfaces(dir, port),
      declared:     declaredInterfaces(dir),
      storage:      blocks.get(real) ?? [],
    });
  }
  return out;
}

// ─── устройства ──────────────────────────────────────────────────────────────

export interface UsbDevice {
  /** Порт в дереве USB: «2-4». Он же идентифицирует устройство в списке. */
  port:       string;
  /** Разрешено ли устройство прямо сейчас — по состоянию authorized в ядре. */
  target:     'allow' | 'block';
  deviceId:   string;    // 24a9:205a
  name:       string;
  serial:     string;
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
 * Все USB-устройства машины — целиком из sysfs, без внешних утилит.
 *
 * Прежняя версия брала список у `usbguard list-devices` и дополняла его
 * sysfs. Теперь источник один, и это заодно снимает прошлое ограничение:
 * список виден и когда никакой демон не запущен.
 *
 * Корневые хабы (usb1, usb2…) пропускаются: это контроллеры шины, их
 * блокировка обрушила бы всё дерево устройств, и решать по ним нечего.
 */
export async function listDevices(): Promise<UsbDevice[]> {
  const sysfs = listUsbSysfs();

  const devices: UsbDevice[] = sysfs
    .filter(s => !/^usb\d+$/.test(s.port))
    .map(s => {
      const categories = categoriesOf(s.interfaces, s.deviceId);
      return {
        port:       s.port,
        target:     s.authorized ? 'allow' as const : 'block' as const,
        deviceId:   s.deviceId,
        name:       [s.manufacturer, s.product].map(x => x.trim()).filter(Boolean).join(' '),
        serial:     s.serial,
        interfaces: s.interfaces,
        categories,
        uncategorized: s.interfaces.length > 0 && categories.length === 0,
        storageNodes: s.storage.length ? s.storage.map(n => n.block) : undefined,
        sysfs:      s,
      };
    });

  // Запоминаем, что видно у разрешённых, и подставляем запомненное заблокированным
  saveRemembered(devices);
  const cache = loadRemembered();
  for (const d of devices) {
    if (d.sysfs?.storage?.length && d.interfaces.length) continue;
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
  /**
   * Классы интерфейсов, какими они были при последнем подключении.
   *
   * Заблокированное устройство их не показывает — ядро не конфигурирует
   * интерфейсы, пока не разрешена авторизация. Без памяти о них колонка типа
   * у заблокированного устройства говорила «вне категорий:» с пустым списком,
   * то есть ровно наоборот: будто классы известны и ни во что не попали.
   */
  interfaces?: string[];
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

/**
 * Ключ памяти об устройстве. USBGuard давал хеш дескриптора, udev его не
 * считает, поэтому ключ собирается из идентификатора и серийного номера —
 * для подстановки модели и размера этого достаточно.
 */
function rememberKey(d: UsbDevice): string {
  return `${d.deviceId}:${d.serial}`;
}

function saveRemembered(devices: UsbDevice[]): void {
  const cache = loadRemembered();
  let changed = false;
  for (const d of devices) {
    // Запоминать нечего, пока устройство заблокировано: ни интерфейсов, ни
    // носителя оно не показывает, и запись затёрла бы то, что уже известно.
    if (d.interfaces.length === 0) continue;
    const disk = d.sysfs?.storage?.[0];
    const model = disk?.fullName ?? '';
    const key = rememberKey(d);
    const prev = cache[key];
    const next: RememberedDevice = {
      model:     model || prev?.model || '',
      kind:      disk?.sizeBytes ? disk.kind : (prev?.kind ?? ''),
      sizeBytes: disk?.sizeBytes || prev?.sizeBytes || 0,
      seen:      new Date().toISOString(),
      interfaces: d.interfaces,
    };
    if (prev && prev.model === next.model && prev.kind === next.kind &&
        prev.sizeBytes === next.sizeBytes &&
        (prev.interfaces ?? []).join() === next.interfaces!.join()) continue;
    cache[key] = next;
    changed = true;
  }
  if (!changed) return;
  sudoRun(['mkdir', '-p', '/var/lib/redos']);
  writeSudo(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
}

/**
 * Пропустит ли устройство политика при таком наборе разрешённых категорий.
 *
 * Повторяет семантику сгенерированных правил: опасные комбинации, разрешение
 * по идентификатору для категорий вроде криптотокенов и проверку классов.
 * Нужна, чтобы показывать в списке только те устройства, судьбу которых
 * администратор ещё должен решить.
 */
export function allowedByCategories(d: UsbDevice, allowed: Set<CategoryId>): boolean {
  const active  = CATEGORIES.filter(c => c.locked || allowed.has(c.id));
  const classes = d.interfaces.map(effectiveClass);
  const has = (c: string) => classes.includes(c);

  // Опасные комбинации (BadUSB) — до разрешений, как в скрипте: накопитель,
  // притворяющийся ещё и клавиатурой, сетевой картой или радиомодулем, иначе
  // прошёл бы по разрешённой категории.
  if (has(STORAGE_CLASS) && (has('03') || has('02') || has('e0'))) return false;

  // Категории, опознаваемые по идентификатору (токены), — отдельным правилом.
  // Условие none-of { 08:*:* } из правил повторяем здесь: устройство с
  // накопительным интерфейсом по идентификатору токена не проходит.
  if (!has(STORAGE_CLASS) && active.some(c => c.ids?.some(pat => idMatches(d.deviceId, pat)))) return true;

  if (classes.length === 0) return false;
  const ok    = new Set(active.flatMap(c => c.classes).map(p => p.split(':')[0].toLowerCase()));
  const known = new Set(KNOWN_CLASSES);

  // Блокирует интерфейс выключенной категории. Интерфейс, чей класс не
  // покрыт категориями, сам по себе не блокирует — иначе принтер с
  // вендорским ff не разрешить никакой галочкой. Но и разрешать устройство
  // ему нечем: нужен хотя бы один интерфейс из разрешённой категории,
  // поэтому флешка, замаскированная под сплошной ff, по-прежнему не пройдёт.
  return classes.some(c => ok.has(c)) && classes.every(c => ok.has(c) || !known.has(c));
}

/**
 * Каким станет устройство, когда политика будет применена.
 *
 * Отличается от allowedByCategories тем, что смотрит и на запомненные классы:
 * та повторяет семантику правил и решает по живым интерфейсам, а у
 * заблокированного устройства их нет — по ней всё заблокированное выглядело бы
 * одинаково, и администратор не видел бы, что снятая галочка уже вернёт ему
 * флешку. Отсюда и третий ответ: про устройство, которое ни разу не видели
 * разрешённым, сказать заранее нечего.
 */
export function predictTarget(
  d: UsbDevice,
  allowed: Set<CategoryId>,
  trusted: boolean,
): 'allow' | 'block' | 'unknown' {
  if (trusted) return 'allow';
  const { interfaces } = interfacesOf(d);
  if (interfaces.length === 0) return 'unknown';
  return allowedByCategories({ ...d, interfaces }, allowed) ? 'allow' : 'block';
}

// ─── политика ────────────────────────────────────────────────────────────────

export interface TrustedDevice {
  deviceId: string;   // 24a9:205a
  serial:   string;
  name:     string;
}

export interface PolicyInput {
  /** Разрешённые категории (locked добавляются принудительно). */
  allowed: CategoryId[];
  trusted: TrustedDevice[];
}

/** Классы интерфейсов, которые политика пропускает. */
function allowedClasses(input: PolicyInput): string[] {
  const allowed = new Set<CategoryId>([...input.allowed, ...LOCKED_CATEGORIES]);
  return [...new Set(CATEGORIES
    .filter(c => allowed.has(c.id))
    .flatMap(c => c.classes)
    .map(p => p.split(':')[0].toLowerCase()))].sort();
}

/** Ключ доверенного устройства в файле политики. */
function trustedKey(t: TrustedDevice): string {
  return `${t.deviceId.toLowerCase()}:${t.serial}`;
}

/**
 * Файл политики. Читают двое: скрипт блокировки на каждом событии udev и сама
 * утилита — чтобы показать, что применено. Формат нарочно простой, чтобы
 * разбираться в нём мог `sed` из скрипта.
 */
export function generatePolicy(input: PolicyInput): string {
  const allowed = new Set<CategoryId>([...input.allowed, ...LOCKED_CATEGORIES]);
  const markedCategories = CATEGORIES
    .filter(c => allowed.has(c.id) && c.classes.length > 0)
    .map(c => c.id);

  const lines = [
    HEADER_MARK,
    `${VERSION_MARK} ${POLICY_VERSION}`,
    `${CATEGORIES_MARK} ${markedCategories.join(',')}`,
    '# Управляется утилитой redos (/usb-policy). Не редактируйте вручную:',
    '# при следующем применении политики файл будет перезаписан.',
    `# Сгенерировано: ${new Date().toISOString()}`,
    '#',
    '# ALLOWED_CLASSES — классы интерфейсов USB, которые политика пропускает.',
    '#   Устройство проходит, если разрешён хотя бы один его интерфейс и ни',
    '#   один не относится к выключенной категории: иначе связка {накопитель,',
    '#   клавиатура} прошла бы по разрешённому HID. Классы вне категорий',
    '#   (вендорский ff у принтеров) не блокируют — включить их нечем.',
    '# TOKEN_IDS — криптотокены, разрешённые по идентификатору. Условие «не',
    '#   объявляет накопитель» проверяет скрипт: VID подделывается тривиально,',
    '#   и без него хватило бы перешить флешку, чтобы обойти запрет.',
    '# TRUSTED — доверенные устройства: vendor:product:serial.',
    '',
    ...wrapComment(CATEGORIES.filter(c => allowed.has(c.id) && c.classes.length)
                             .map(c => c.title.toLowerCase()).join(', '), 'Разрешено: '),
    `ALLOWED_CLASSES=${allowedClasses(input).join(' ')}`,
    `TOKEN_IDS=${CATEGORIES.filter(c => allowed.has(c.id)).flatMap(c => c.ids ?? []).join(' ')}`,
    `TRUSTED=${input.trusted.filter(t => t.deviceId).map(trustedKey).join(' ')}`,
  ];

  for (const t of input.trusted) {
    if (!t.deviceId || !t.name) continue;
    lines.push(`#NAME ${trustedKey(t)} ${t.name.replace(/[\r\n]+/g, ' ')}`);
  }
  return lines.join('\n') + '\n';
}

/** Разбивает длинный перечень на строки-комментарии по ширине 72 символа. */
function wrapComment(text: string, prefix: string): string[] {
  const out: string[] = [];
  let line = prefix;
  for (const word of text.split(' ')) {
    if (line.length + word.length > 72) { out.push(`# ${line}`); line = ''; }
    line += (line && line !== prefix ? ' ' : '') + word;
  }
  if (line.trim()) out.push(`# ${line}`);
  return out;
}

/**
 * Читает применённую политику обратно.
 *
 * Восстанавливать выбор по списку подключённых устройств нельзя: если ни одна
 * веб-камера сейчас не воткнута, категория «веб-камеры» выглядела бы
 * запрещённой, хотя в политике она разрешена. Источник истины — сам файл.
 */
export function readAppliedPolicy(): PolicyInput | null {
  return parseAppliedPolicy(readFile(POLICY_FILE));
}

/**
 * Версия, которой записан файл политики. 0 — файл не наш или без отметки.
 *
 * Читать её обязательно: скрипт и правило меняются от версии к версии, а на
 * машине остаётся то, что записали при последнем применении. Версия 3
 * принесла рубеж по блочному узлу — без переприменения его там просто нет,
 * и об этом администратор должен узнать от утилиты, а не из README.
 */
export function appliedVersion(text: string | null): number {
  if (!text || !text.includes(HEADER_MARK)) return 0;
  const line = text.split('\n').find(l => l.startsWith(VERSION_MARK));
  return Number(line?.slice(VERSION_MARK.length).trim()) || 0;
}

/** Текущая версия формата — с ней сравнивается записанное на машине. */
export const CURRENT_POLICY_VERSION = POLICY_VERSION;

/** Разбор файла политики. Отделён от чтения, чтобы поддаваться проверке. */
export function parseAppliedPolicy(text: string | null): PolicyInput | null {
  if (!text || !text.includes(HEADER_MARK)) return null;
  const lines = text.split('\n');

  const known = new Set<string>(CATEGORIES.map(c => c.id));
  const catLine = lines.find(l => l.startsWith(CATEGORIES_MARK)) ?? '';
  const allowed = catLine.slice(CATEGORIES_MARK.length).split(',')
    .map(v => v.trim()).filter(v => known.has(v)) as CategoryId[];

  const names = new Map<string, string>();
  for (const l of lines) {
    const m = l.match(/^#NAME\s+(\S+)\s+(.*)$/);
    if (m) names.set(m[1].toLowerCase(), m[2].trim());
  }

  const trusted: TrustedDevice[] = [];
  const trustedLine = lines.find(l => l.startsWith('TRUSTED='))?.slice('TRUSTED='.length) ?? '';
  for (const item of trustedLine.trim().split(/\s+/).filter(Boolean)) {
    const m = item.match(/^([0-9a-f]{4}:[0-9a-f]{4}):(.*)$/i);
    if (!m) continue;
    trusted.push({
      deviceId: m[1].toLowerCase(),
      serial:   m[2],
      name:     names.get(item.toLowerCase()) ?? '',
    });
  }
  return { allowed, trusted };
}

// ─── файлы на машине ─────────────────────────────────────────────────────────

/**
 * udev-правило: два рубежа, оба ведут в один скрипт.
 *
 * Первый — событие usb_interface, а не usb_device: на нём класс уже известен
 * ядру, тогда как в момент add самого устройства каталоги интерфейсов могут
 * ещё не появиться. Решение всё равно принимается по устройству целиком —
 * скрипт поднимается к нему сам.
 *
 * Второй — появление блочного узла. Он ловит то, что первый пропускает по
 * определению: политика по классам верит дескриптору, а ядро привязывает
 * драйверы ещё и по vid:pid. Устройство, объявившее себя клавиатурой, но
 * подставившее идентификаторы известного накопителя, получит usb-storage —
 * класс при этом остаётся разрешённым, и первый рубеж его пропустит.
 * Появившийся /dev/sdX подделать уже нечем: это факт, а не заявление.
 */
export function generateRules(): string {
  return [
    HEADER_MARK,
    '# Управляется утилитой redos (/usb-policy). Не редактируйте вручную.',
    '#',
    '# Политика — в /etc/redos/device-control.conf, решение принимает',
    '# /usr/local/sbin/redos-block-usb.sh. Здесь только вызовы: udev видит',
    '# интерфейсы по одному, а разрешение зависит от всех сразу.',
    '',
    'ACTION!="add",             GOTO="redos_dc_end"',
    '',
    '# Рубеж по факту: блочный узел на USB-устройстве, которому накопитель',
    '# не разрешён. Проверка идёт вместо класса, а не вместе с ним.',
    `SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", RUN+="${BLOCK_SCRIPT} --storage $devpath", GOTO="redos_dc_end"`,
    '',
    'SUBSYSTEM!="usb",          GOTO="redos_dc_end"',
    'ENV{DEVTYPE}!="usb_interface", GOTO="redos_dc_end"',
    '',
    `RUN+="${BLOCK_SCRIPT} $devpath"`,
    '',
    'LABEL="redos_dc_end"',
  ].join('\n') + '\n';
}

/**
 * Скрипт решения. Статичен: всё, что меняется от политики к политике, лежит
 * в /etc/redos/device-control.conf, поэтому смена набора категорий не требует
 * переписывать исполняемый файл.
 */
export const BLOCK_SCRIPT_BODY = `#!/bin/sh
${HEADER_MARK}
# Управляется утилитой redos (/usb-policy). Не редактируйте вручную.
#
# Вызывается из ${RULES_FILE} в двух режимах:
#   $1 = DEVPATH интерфейса             — решение по классам интерфейсов;
#   --storage, $2 = DEVPATH блочного    — решение по факту появления диска.
# Оба поднимаются к USB-устройству и снимают авторизацию, если устройство не
# проходит политику из ${POLICY_FILE}.

mode=interface
if [ "$1" = --storage ]; then mode=storage; shift; fi

conf=${POLICY_FILE}
[ -r "$conf" ] || exit 0

# Разрешённое читается из политики, а перечень классов, вообще покрытых
# категориями, вшит в скрипт: он не зависит от выбора администратора и
# меняется только вместе с самими категориями, то есть с этим файлом.
allowed=$(sed -n 's/^ALLOWED_CLASSES=//p' "$conf")
tokens=$(sed -n 's/^TOKEN_IDS=//p' "$conf")
trusted=$(sed -n 's/^TRUSTED=//p' "$conf")

# Пустой список разрешённого — признак обрезанного или чужого файла, а не
# политики «запретить всё»: даже при полностью снятых категориях в нём
# остаются всегда разрешённые классы (ввод, хабы, принтеры, смарт-карты).
# Блокировать по такому файлу нельзя — машина осталась бы без клавиатуры.
[ -n "$allowed" ] || exit 0

# Поднимаемся до самого USB-устройства: idVendor есть только у него.
# У интерфейсов (2-4:1.0) тоже есть authorized, но деавторизация интерфейса
# оставляет устройство в системе.
dev="/sys$1"
while [ "$dev" != /sys ] && [ "$dev" != / ]; do
  if [ -e "$dev/idVendor" ] && [ -e "$dev/authorized" ]; then break; fi
  dev=$(dirname "$dev")
done
[ -e "$dev/idVendor" ] || exit 0
[ "$(cat "$dev/authorized" 2>/dev/null)" = "0" ] && exit 0

vid=$(cat "$dev/idVendor" 2>/dev/null)
pid=$(cat "$dev/idProduct" 2>/dev/null)
serial=$(cat "$dev/serial" 2>/dev/null)
port=\${dev##*/}

block() {
  # Если с этого устройства смонтирована системная ФС — не трогаем: так
  # выглядит машина, загруженная с USB, и блокировка убила бы её на ходу.
  # Автомонтирование в /run/media, /media и /mnt системным не считается.
  if [ -r /proc/self/mounts ]; then
    while read -r src mnt rest; do
      case "$src" in /dev/sd*) ;; *) continue ;; esac
      case "$mnt" in /run/media/*|/media/*|/mnt/*) continue ;; esac
      base=\${src#/dev/}
      base=$(printf '%s' "$base" | sed 's/[0-9]*$//')
      link=$(readlink -f "/sys/block/$base" 2>/dev/null) || continue
      case "$link/" in "$dev"/*) exit 0 ;; esac
    done < /proc/self/mounts
  fi
  printf 0 > "$dev/authorized"
  exit 0
}

has() {
  case " $classes " in *" $1 "*) return 0 ;; esac
  return 1
}

# Разрешён ли накопитель — нужно и рубежу по блочному узлу, и проверке ниже.
storage_ok=no
case " $allowed " in *" ${STORAGE_CLASS} "*) storage_ok=yes ;; esac

# Доверенные поимённо проходят в обоих режимах: администратор внёс устройство
# в исключения зная, что это, и его слово выше любой категории.
for t in $trusted; do
  [ "$t" = "$vid:$pid:$serial" ] && exit 0
done

# Рубеж по факту: на устройстве появился блочный узел. Класс интерфейса тут
# уже не спрашиваем — он и был тем, чему верить нельзя.
if [ "$mode" = storage ]; then
  [ "$storage_ok" = yes ] && exit 0
  block
fi

# Классы всех интерфейсов устройства: решение принимается по ним целиком.
#
# Класс нормализуется: подкласс 06 (SCSI) с протоколом 50 (Bulk-Only) или 62
# (UAS) — это накопитель, каким бы класс себя ни объявлял. Так встроенный
# картридер с вендорским ff:06:50 подчиняется галочке «Накопители», а не висит
# вне категорий, и замаскированный накопитель попадает под её запрет.
classes=""
for i in "$dev"/"$port":*; do
  [ -r "$i/bInterfaceClass" ] || continue
  cls=$(cat "$i/bInterfaceClass")
  sub=$(cat "$i/bInterfaceSubClass" 2>/dev/null)
  proto=$(cat "$i/bInterfaceProtocol" 2>/dev/null)
  if [ "$sub" = "${SCSI_SUBCLASS}" ]; then
    case "$proto" in ${SCSI_PROTOCOLS.join('|')}) cls=${STORAGE_CLASS} ;; esac
  fi
  classes="$classes $cls"
done
[ -n "$classes" ] || exit 0

# 1. Опасные комбинации (BadUSB): накопитель, притворяющийся ещё и
#    клавиатурой, сетевой картой или радиомодулем. Проверяется до разрешений:
#    иначе такое устройство прошло бы по разрешённой категории.
if has 08 && { has 03 || has 02 || has e0; }; then
  block
fi

# 2. Криптотокены по идентификатору — но не те, что объявляют накопитель.
if ! has 08; then
  for t in $tokens; do
    [ "$t" = "$vid:$pid" ] && exit 0
  done
fi

# 3. Решение по классам интерфейсов.
#
#    Блокирует класс выключенной категории. Класс, не покрытый категориями
#    вовсе (вендорский ff у принтеров и МФУ), сам по себе не блокирует: его
#    не разрешить ни одной галочкой, и при прежней проверке «все интерфейсы
#    разрешены» ни один HP не проходил даже с включёнными «Принтерами».
#
#    Разрешать устройство непокрытому классу тоже нечем, поэтому нужен хотя
#    бы один интерфейс из разрешённых: устройство целиком из ff не пройдёт.
ok=no
for c in $classes; do
  case " $allowed " in
    *" $c "*) ok=yes; continue ;;
  esac
  # Класс относится к категории, которую администратор выключил.
  case " ${KNOWN_CLASSES.join(' ')} " in
    *" $c "*) block ;;
  esac
done
[ "$ok" = yes ] || block
exit 0
`;

// ─── проверка политики ───────────────────────────────────────────────────────

const DEVICE_ID_RE = /^[0-9a-f]{4}:[0-9a-f]{4}$/i;

/**
 * Проверяет политику до записи файлов.
 *
 * Смысл в том, чтобы неверные данные останавливались здесь, а не превращались
 * в строку, которую скрипт поймёт слишком широко. Пробел в списке TRUSTED
 * разделяет записи, поэтому серийный номер с пробелом сделал бы доверенным
 * не то устройство.
 */
export function validatePolicyInput(input: PolicyInput): string[] {
  const errors: string[] = [];
  const known = new Set<string>(CATEGORIES.map(c => c.id));

  for (const id of input.allowed) {
    if (!known.has(id)) errors.push(`неизвестная категория: ${id}`);
  }
  for (const t of input.trusted) {
    if (!t.deviceId) { errors.push('доверенное устройство без идентификатора'); continue; }
    if (!DEVICE_ID_RE.test(t.deviceId)) errors.push(`неверный идентификатор: ${t.deviceId}`);
    if (/\s/.test(t.serial)) errors.push(`серийный номер с пробелом: ${t.deviceId}`);
  }
  return errors;
}

// ─── состояние ───────────────────────────────────────────────────────────────

export interface PolicyStatus {
  /** Политика записана и правило на месте. */
  active:      boolean;
  applied:     PolicyInput | null;
  /** На машине лежат файлы udev-политики версии 0.9 — их уберёт применение. */
  legacyUdev:  boolean;
  rulesFile:   boolean;
  scriptFile:  boolean;
  /** Сколько устройств деавторизовано прямо сейчас. */
  blockedNow:  number;
  /**
   * Политика записана прошлой версией утилиты: файлы на месте, но скрипт и
   * правило — старые. Лечится повторным применением.
   */
  outdated:    boolean;
  /** Чужие udev-правила по USB — они применяются вместе с нашим. */
  conflicts:   string[];
  /** Остатки контроля на USBGuard: пакет, служба, правила. */
  usbguard:    UsbGuardTraces;
}

export async function readStatus(): Promise<PolicyStatus> {
  const policyText = readFile(POLICY_FILE);
  const applied = parseAppliedPolicy(policyText);
  const rules   = readFile(RULES_FILE);
  const legacyPresent = LEGACY_FILES.some(f => readFile(f)?.includes(LEGACY_MARK) ?? false);
  const script  = readFile(BLOCK_SCRIPT);
  const blocked = listUsbSysfs().filter(s => !s.authorized).length;

  return {
    active:     applied !== null && (rules?.includes(HEADER_MARK) ?? false),
    applied,
    legacyUdev: legacyPresent,
    rulesFile:  rules?.includes(HEADER_MARK) ?? false,
    scriptFile: script?.includes(HEADER_MARK) ?? false,
    blockedNow: blocked,
    outdated:   applied !== null && appliedVersion(policyText) < POLICY_VERSION,
    conflicts:  findConflictingRules(),
    usbguard:   await findUsbGuardTraces(),
  };
}

/**
 * Чужие udev-правила, тоже управляющие USB: 99-usb.rules из статьи БЗ РЕД ОС,
 * remove_usb.sh и подобные. Они применяются вместе с нашим правилом, а RUN+=
 * накапливается — чужой скрипт заблокирует и разрешённое устройство.
 */
export function findConflictingRules(): string[] {
  let files: string[];
  try { files = readdirSync('/etc/udev/rules.d'); } catch { return []; }

  const found: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.rules')) continue;
    const path = `/etc/udev/rules.d/${f}`;
    if (path === RULES_FILE) continue;
    const content = readFile(path);
    if (!content || isOurs(content)) continue;
    if (/UDISKS_IGNORE|remove_usb|authorized|ID_USB_DRIVER/.test(content)) found.push(path);
  }
  return found;
}

/**
 * Отключает чужие правила переименованием: udev читает только *.rules, а файл
 * остаётся рядом и возвращается одной командой.
 */
export function disableConflictingRules(files: string[]): FixResult {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const moved: string[] = [];

  for (const f of files) {
    const content = readFile(f);
    if (!content || isOurs(content)) continue;
    const r = sudoRun(['mv', f, `${f}.disabled-${stamp}`]);
    if (!r.ok) return { ok: false, msg: `${f}: ${r.msg}` };
    moved.push(f);
  }
  if (moved.length === 0) return { ok: true, msg: 'нечего отключать' };

  sudoRun(['udevadm', 'control', '--reload-rules']);
  authorizeAll();
  return { ok: true, msg: `Отключено правил: ${moved.length} (переименованы в *.disabled-${stamp})` };
}

// ─── авторизация устройств ───────────────────────────────────────────────────

/** Вернуть authorized=1 указанным устройствам (одним вызовом sudo). */
function authorize(ports: string[]): number {
  if (ports.length === 0) return 0;
  const cmd = ports
    .map(p => `printf 1 > '/sys/bus/usb/devices/${p}/authorized' 2>/dev/null;`)
    .join(' ');
  sudoRun(['sh', '-c', cmd + ' exit 0']);
  return ports.length;
}

/**
 * Вернуть авторизацию всем деавторизованным устройствам.
 *
 * authorized=0 живёт до физического переподключения, поэтому снятие политики
 * без этого шага оставило бы устройства мёртвыми, хотя правил уже нет.
 */
function authorizeAll(): number {
  return authorize(listUsbSysfs().filter(s => !s.authorized).map(s => s.port));
}

/**
 * Ждёт, пока ядро сконфигурирует интерфейсы у перечисленных портов.
 *
 * Авторизация асинхронна: запись 1 в authorized только запускает
 * переперечисление, каталоги интерфейсов (2-4:1.0) появляются позже. Без
 * ожидания следующий за этим udevadm settle отработал бы вхолостую — очередь
 * ещё пуста, — и решение по устройству принято бы не было.
 */
async function waitForInterfaces(ports: string[], timeoutMs = 3000): Promise<void> {
  if (ports.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const byPort = new Map(listUsbSysfs().map(s => [s.port, s]));
    // Заблокированное скриптом устройство тоже считается готовым: решение по
    // нему уже принято, ждать больше нечего.
    const pending = ports.filter(p => {
      const s = byPort.get(p);
      return s && s.authorized && s.interfaces.length === 0;
    });
    if (pending.length === 0) return;
    await Bun.sleep(100);
  }
}

/**
 * Порты, которым нужно вернуть авторизацию перед прогоном правил.
 *
 * Корневые хабы исключены: их authorized относится ко всей шине, и трогать
 * контроллер, чтобы переподнять устройство на нём, незачем.
 */
export function portsToReauthorize(devices: UsbSysfsDevice[]): string[] {
  return devices.filter(s => !s.authorized && !/^usb\d+$/.test(s.port)).map(s => s.port);
}

/**
 * Возвращает авторизацию заблокированным устройствам, чтобы правило приняло
 * по ним решение заново.
 *
 * Без этого шага снятие блокировки не работает без похода к машине:
 * у деавторизованного устройства нет интерфейсов, а правило висит на событии
 * usb_interface — `udevadm trigger` по нему не порождает ни одного события,
 * и authorized=0 переживает и перечитывание правил, и новую политику.
 *
 * Авторизуются все заблокированные, а не только те, что стали разрешёнными:
 * какие у устройства интерфейсы, пока оно заблокировано, неизвестно — ядро их
 * не конфигурирует. Устройство поднимается ровно так же, как при физическом
 * переподключении, и запрещённое политика гасит здесь же, на событии
 * интерфейса, до появления блочного узла.
 */
async function reauthorizeBlocked(): Promise<string[]> {
  const ports = portsToReauthorize(listUsbSysfs());
  if (ports.length === 0) return [];
  authorize(ports);
  await waitForInterfaces(ports);
  return ports;
}

// ─── применение ──────────────────────────────────────────────────────────────

export interface ApplyResult extends FixResult {}

/**
 * Применяет политику с сеткой безопасности.
 *
 * Порядок такой, чтобы машина не осталась без клавиатуры:
 *  1. запоминаем, какие устройства ввода разрешены сейчас;
 *  2. пишем политику, скрипт и правило;
 *  3. возвращаем авторизацию заблокированным — иначе по ним не будет событий
 *     и снятая блокировка не подействует до переподключения;
 *  4. прогоняем через правило уже подключённые устройства;
 *  5. ПРОВЕРКА: каждое устройство ввода, разрешённое до применения, разрешено
 *     и после; потерявшим доступ возвращаем его точечно.
 *
 * Шаг 5 страхует и от ошибки в самой политике: если разрешение класса HID
 * почему-то не сработало, клавиатура вернётся здесь же, а не после поездки
 * к машине.
 */
export async function applyPolicy(
  input: PolicyInput,
  onStep: (m: string) => void = () => {},
): Promise<ApplyResult> {
  const errors = validatePolicyInput(input);
  if (errors.length) {
    return { ok: false, msg: ['Политика не применена:', ...errors].join('\n') };
  }

  // 0. Что разрешено сейчас — чтобы потом сравнить
  const before = await listDevices();
  const inputBefore = before.filter(d => d.categories.includes('input') && d.target === 'allow');

  // 1. Запись
  onStep('Записываю политику и правило udev');
  sudoRun(['mkdir', '-p', dirname(POLICY_FILE)]);
  const w1 = writeSudo(POLICY_FILE, generatePolicy(input));
  if (!w1.ok) return { ok: false, msg: `${POLICY_FILE}: ${w1.msg}` };
  sudoRun(['chmod', '0644', POLICY_FILE]);

  const w2 = writeSudo(BLOCK_SCRIPT, BLOCK_SCRIPT_BODY);
  if (!w2.ok) return { ok: false, msg: `${BLOCK_SCRIPT}: ${w2.msg}` };
  const chmod = sudoRun(['chmod', '0755', BLOCK_SCRIPT]);
  if (!chmod.ok) return { ok: false, msg: `${BLOCK_SCRIPT}: ${chmod.msg}` };

  const w3 = writeSudo(RULES_FILE, generateRules());
  if (!w3.ok) return { ok: false, msg: `${RULES_FILE}: ${w3.msg}` };
  sudoRun(['chmod', '0644', RULES_FILE]);

  // Правила версии 0.9 работали бы рядом с новыми и блокировали разрешённое
  const legacy = removeLegacyFiles();
  if (legacy) onStep(`Убрано файлов прошлой политики: ${legacy}`);

  // 2. Применение к уже подключённым устройствам
  onStep('Перечитываю правила udev');
  const reload = sudoRun(['udevadm', 'control', '--reload-rules']);
  if (!reload.ok) return { ok: false, msg: `udevadm: ${reload.msg}` };

  // Заблокированным возвращаем авторизацию до триггера: пока устройство
  // деавторизовано, у него нет интерфейсов, а правило висит на usb_interface —
  // событий по нему не будет, и снятие блокировки не сработало бы без
  // физического переподключения. Поднятое устройство запрещённой категории
  // правило гасит тут же, на событии интерфейса.
  const revived = await reauthorizeBlocked();
  if (revived.length) onStep(`Переподнимаю заблокированные устройства: ${revived.length}`);

  sudoRun(['udevadm', 'trigger', '--subsystem-match=usb', '--action=add']);
  sudoRun(['udevadm', 'settle']);

  // 4. Сетка безопасности по устройствам ввода
  onStep('Проверяю, что устройства ввода остались доступны');
  const after = await listDevices();
  const lost = inputBefore.filter(b =>
    after.some(a => a.port === b.port && a.target === 'block'));
  const restored = authorize(lost.map(d => d.port));

  const blocked = after.filter(d => d.target === 'block').length;
  const parts = [`Политика применена, заблокировано устройств: ${blocked}`];
  if (restored) parts.push(`возвращён доступ устройствам ввода: ${restored}`);
  return { ok: true, msg: parts.join('; ') };
}

/** Снимает политику: удаляет свои файлы и возвращает устройствам авторизацию. */
export async function removePolicy(onStep: (m: string) => void = () => {}): Promise<FixResult> {
  for (const f of [RULES_FILE, BLOCK_SCRIPT, POLICY_FILE]) {
    const content = readFile(f);
    if (!content) continue;
    if (!isOurs(content)) {
      return { ok: false, msg: `${f} создан не утилитой redos — снимите политику вручную` };
    }
    const r = sudoRun(['rm', '-f', f]);
    if (!r.ok) return r;
  }
  removeLegacyFiles();

  onStep('Перечитываю правила udev');
  sudoRun(['udevadm', 'control', '--reload-rules']);

  onStep('Возвращаю авторизацию устройствам');
  const restored = authorizeAll();

  const others = findConflictingRules();
  const tail = others.length ? `; остались чужие правила: ${others.join(', ')}` : '';
  return {
    ok: true,
    msg: `Политика снята${restored ? `, восстановлено устройств: ${restored}` : ''}${tail}`,
  };
}
