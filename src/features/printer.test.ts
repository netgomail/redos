/**
 * Проверки перевода МФУ на driverless.
 *
 * Проверяется то, что опасно проверять на живой машине: разбор ответов CUPS и
 * самого МФУ, решение, какие очереди удалить, и что hplip не попадает в план,
 * когда его нет.
 *
 * Запуск: bun test
 */
import { describe, test, expect } from 'bun:test';
import { encodeGetPrinterAttributes, parseIppResponse, summarize, blockingReasons } from './ipp';
import {
  parseQueues, parseAirscanConf, airscanConf, stripLpoptions, errorPolicyFrom,
  planMigration, queuesToRemove, defaultQueueName, analyze, filterCupsJournal,
  migrationBlocker, discoveryHidden, rollbackScript, connOfUri, serialFromUri,
  isSameDevice, isDriverless, hplipQueuesLeft, hplipKept, connOfQueue,
  parseLpq, duplicateJobs, plannedUri, esclUrl, queueNameError,
} from './printer';
import type { SystemState, MigrateOptions, PrintQueue, PrinterProbe, Conn } from './printer';
import { usbPrintersFrom, matchesDevice, usbBlocker, usbPending } from './usbPrinter';
import type { UsbPrinter } from './usbPrinter';

/** Аппарат на USB: по умолчанию исправный и с IPP-over-USB. */
const usbDev = (over: Partial<UsbPrinter> = {}): UsbPrinter => ({
  port: '2-4', deviceId: '03f0:0f2a', serial: 'CNB1234567',
  model: 'HP LaserJet MFP M426fdn', vendor: 'HP', ippOverUsb: true, blocked: false,
  ...over,
});
const NET: Conn = { kind: 'net', ip: '10.82.230.207' };
const USB: Conn = { kind: 'usb', usb: usbDev() };

// ─── IPP ──────────────────────────────────────────────────────────────────────

/** Собирает ответ IPP так, как его отдаёт МФУ. */
function ippResponse(attrs: [number, string, Uint8Array | string][]): Uint8Array {
  const out: number[] = [0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x04]; // ok, printer group
  for (const [tag, name, value] of attrs) {
    const n = [...new TextEncoder().encode(name)];
    const v = typeof value === 'string' ? [...new TextEncoder().encode(value)] : [...value];
    out.push(tag, n.length >> 8, n.length & 0xff, ...n, v.length >> 8, v.length & 0xff, ...v);
  }
  out.push(0x03);
  return new Uint8Array(out);
}
const int = (x: number) => new Uint8Array([x >>> 24, (x >> 16) & 0xff, (x >> 8) & 0xff, x & 0xff]);

describe('IPP', () => {
  test('запрос Get-Printer-Attributes: заголовок, printer-uri и 1setOf requested-attributes', () => {
    const b = encodeGetPrinterAttributes('ipp://10.0.0.5/ipp/print', ['printer-state', 'sides-supported']);
    expect([...b.slice(0, 4)]).toEqual([0x02, 0x00, 0x00, 0x0b]);
    const text = new TextDecoder().decode(b);
    expect(text).toContain('ipp://10.0.0.5/ipp/print');
    expect(text).toContain('requested-attributes');
    expect(b[b.length - 1]).toBe(0x03);
    // разбор собственного запроса возвращает оба ключевых слова одного атрибута
    expect(parseIppResponse(b).attrs.get('requested-attributes')).toEqual(['printer-state', 'sides-supported']);
  });

  test('ответ МФУ: состояние, тонер, форматы, коллекции пропускаются', () => {
    const r = parseIppResponse(ippResponse([
      [0x41, 'printer-make-and-model', 'HP LaserJet MFP M426fdn'],
      [0x23, 'printer-state', int(3)],
      [0x44, 'printer-state-reasons', 'none'],
      [0x22, 'printer-is-accepting-jobs', new Uint8Array([1])],
      [0x49, 'document-format-supported', 'application/pdf'],
      [0x49, '', 'image/urf'],
      [0x49, '', 'image/pwg-raster'],
      [0x34, 'media-col-ready', ''],
      [0x4a, '', 'media-size'],
      [0x34, '', ''],
      [0x4a, '', 'x-dimension'],
      [0x21, '', int(21000)],
      [0x37, '', ''],
      [0x37, '', ''],
      [0x44, 'sides-supported', 'one-sided'],
      [0x44, '', 'two-sided-long-edge'],
      [0x41, 'marker-names', 'Black Cartridge HP CF226XB'],
      [0x21, 'marker-levels', int(98)],
    ]));
    expect(r.status).toBe(0);
    expect(r.attrs.has('media-col-ready')).toBe(false);
    expect(r.attrs.has('x-dimension')).toBe(false);
    const info = summarize(r.attrs);
    expect(info.model).toBe('HP LaserJet MFP M426fdn');
    expect(info.state).toBe('idle');
    expect(info.reasons).toEqual([]);
    expect(info.accepting).toBe(true);
    expect(info.everywhere).toBe(true);
    expect(info.sides).toEqual(['one-sided', 'two-sided-long-edge']);
    expect(info.markers).toEqual([{ name: 'Black Cartridge HP CF226XB', level: 98 }]);
  });

  test('без PWG-raster и URF IPP Everywhere недоступен', () => {
    const info = summarize(parseIppResponse(ippResponse([
      [0x49, 'document-format-supported', 'application/postscript'],
    ])).attrs);
    expect(info.everywhere).toBe(false);
  });

  test('мешающие печати причины отделяются от предупреждений', () => {
    expect(blockingReasons(['media-jam-error', 'toner-low-warning', 'media-empty-report', 'door-open'])).toEqual(
      ['media-jam-error', 'door-open']);
  });
});

// ─── CUPS ─────────────────────────────────────────────────────────────────────

const V = [
  'device for HP_LaserJet_MFP_M426fdn: ipp://10.82.230.207/ipp/print',
  'device for Psiholog_HP_LaserJet_MFP_M426fdn: hp:/net/HP_LaserJet_MFP_M426fdn?ip=10.82.230.207',
  'device for Other: ipp://10.82.230.50/ipp/print',
];
const P = [
  'printer HP_LaserJet_MFP_M426fdn is idle.  enabled since Mon 14 Sep 2026',
  'printer Psiholog_HP_LaserJet_MFP_M426fdn disabled since Mon 21 Sep 2026 -',
  '\tPrinter stopped due to backend errors',
  'printer Other is idle.  enabled since Mon 14 Sep 2026',
];

describe('очереди CUPS', () => {
  const qs = parseQueues(V, P, ['system default destination: HP_LaserJet_MFP_M426fdn'],
    ['Psiholog_HP_LaserJet_MFP_M426fdn-243 psiholog 951296 Mon 21 Sep 2026']);

  test('разбор lpstat', () => {
    expect(qs.map(q => q.name)).toEqual(['HP_LaserJet_MFP_M426fdn', 'Psiholog_HP_LaserJet_MFP_M426fdn', 'Other']);
    const hp = qs[1];
    expect(hp.backend).toBe('hp');
    expect(hp.ip).toBe('10.82.230.207');
    expect(hp.enabled).toBe(false);
    expect(hp.reason).toBe('Printer stopped due to backend errors');
    expect(hp.jobs).toBe(1);
    expect(qs[0].isDefault).toBe(true);
  });

  test('ErrorPolicy из printers.conf', () => {
    const conf = '<DefaultPrinter A>\nErrorPolicy retry-job\n</DefaultPrinter>\n<Printer B>\nErrorPolicy stop-printer\n</Printer>\n';
    expect(errorPolicyFrom(conf, 'A')).toBe('retry-job');
    expect(errorPolicyFrom(conf, 'B')).toBe('stop-printer');
    expect(errorPolicyFrom(conf, 'C')).toBe('');
  });

  test('имя очереди по умолчанию — существующая driverless-очередь на этом IP', () => {
    expect(defaultQueueName(qs, NET)).toBe('HP_LaserJet_MFP_M426fdn');
    expect(defaultQueueName(qs, { kind: 'net', ip: '10.82.230.99' })).toBe('HP_MFP_99');
  });

  test('имя очереди по умолчанию для USB — из модели аппарата', () => {
    expect(defaultQueueName([], USB)).toBe('HP_LaserJet_MFP_M426fdn');
  });

  test('удаляются очереди этого же аппарата, чужие — только по выбору', () => {
    const base = { conn: NET, queueName: 'HP_LaserJet_MFP_M426fdn' };
    expect(queuesToRemove(qs, { ...base, removeOthers: false }).map(q => q.name))
      .toEqual(['Psiholog_HP_LaserJet_MFP_M426fdn']);
    expect(queuesToRemove(qs, { ...base, removeOthers: true }).map(q => q.name))
      .toEqual(['Psiholog_HP_LaserJet_MFP_M426fdn', 'Other']);
  });

  test('hp:-очередь можно перевести под тем же именем — тогда её не удаляют', () => {
    const r = queuesToRemove(qs, { conn: NET, queueName: 'Psiholog_HP_LaserJet_MFP_M426fdn', removeOthers: false });
    expect(r.map(q => q.name)).toEqual(['HP_LaserJet_MFP_M426fdn']);
  });
});

// ─── транспорт очереди ────────────────────────────────────────────────────────

const USB_V = [
  'device for HP_USB: hp:/usb/HP_LaserJet_MFP_M426fdn?serial=CNB1234567',
  'device for HP_USB_PLAIN: usb://HP/LaserJet%20MFP%20M426fdn?serial=CNB1234567',
  'device for HP_IPPUSB: ipp://127.0.0.1:60000/ipp/print',
  'device for HP_NET: ipp://10.82.230.207/ipp/print',
];
const USB_P = USB_V.map(l => `printer ${l.slice(11).split(':')[0]} is idle.  enabled since Mon`);

describe('транспорт очереди', () => {
  const qs = parseQueues(USB_V, USB_P, [], []);
  const byName = (n: string) => qs.find(q => q.name === n)!;

  test('USB опознаётся и по hp:/usb/, и по usb:, и по локальному ipp-usb', () => {
    expect(connOfUri('hp:/usb/HP?serial=X')).toBe('usb');
    expect(connOfUri('usb://HP/LaserJet')).toBe('usb');
    expect(connOfUri('ipp://127.0.0.1:60000/ipp/print')).toBe('usb');
    expect(connOfUri('ipp://10.82.230.207/ipp/print')).toBe('net');
    expect(connOfUri('dnssd://HP%20LaserJet._ipp._tcp.local/')).toBe('other');
  });

  test('адрес 127.0.0.1 не выдаётся за сетевой', () => {
    const q = byName('HP_IPPUSB');
    expect(q.conn).toBe('usb');
    expect(q.ip).toBe('');
    expect(q.ippPort).toBe(60000);
  });

  test('очередь через ipp-usb — уже driverless, а usb: и hp:/usb/ — ещё нет', () => {
    expect(isDriverless(byName('HP_IPPUSB'))).toBe(true);
    expect(isDriverless(byName('HP_NET'))).toBe(true);
    expect(isDriverless(byName('HP_USB'))).toBe(false);
    expect(isDriverless(byName('HP_USB_PLAIN'))).toBe(false);
  });

  test('серийник вытаскивается из URI', () => {
    expect(serialFromUri('usb://HP/LaserJet%20MFP?serial=CNB1234567')).toBe('CNB1234567');
    expect(serialFromUri('ipp://10.0.0.5/ipp/print')).toBe('');
  });

  test('перевод сетевого МФУ не трогает очереди USB-аппарата', () => {
    // Из-за этого /printer молча сносил рабочий USB-принтер: любая очередь на
    // hplip считалась мусором, включая hp:/usb/.
    const r = queuesToRemove(qs, { conn: NET, queueName: 'HP_NET', removeOthers: false });
    expect(r.map(q => q.name)).toEqual([]);
  });

  test('перевод USB-аппарата не трогает сетевые очереди', () => {
    const r = queuesToRemove(qs, { conn: USB, queueName: 'HP_IPPUSB', removeOthers: false });
    expect(r.map(q => q.name)).toEqual(['HP_USB', 'HP_USB_PLAIN']);
  });

  test('разные USB-аппараты различаются по серийнику', () => {
    const other: Conn = { kind: 'usb', usb: usbDev({ serial: 'OTHER999' }) };
    expect(isSameDevice(byName('HP_USB'), USB)).toBe(true);
    expect(isSameDevice(byName('HP_USB'), other)).toBe(false);
  });

  test('аппарат очереди ищется в sysfs по серийнику', () => {
    const usb = [usbDev({ serial: 'OTHER999' }), usbDev()];
    const c = connOfQueue(byName('HP_USB'), usb);
    expect(c?.kind).toBe('usb');
    expect(c?.kind === 'usb' && c.usb.serial).toBe('CNB1234567');
    expect(connOfQueue(byName('HP_NET'), usb)).toEqual(NET);
  });
});

// ─── hplip держат оставшиеся очереди ──────────────────────────────────────────

describe('удаление hplip', () => {
  const s = () => state({ queues: parseQueues(USB_V, USB_P, [], []) });

  test('пока USB-очередь на hplip жива, пакет не удаляется', () => {
    const o = opts({ conn: NET, queueName: 'HP_NET' });
    expect(hplipQueuesLeft(s(), o).map(q => q.name)).toEqual(['HP_USB']);
    expect(hplipKept(s(), o)).toContain('HP_USB');
    expect(ids(s(), o)).not.toContain('hplip');
  });

  test('когда hplip-очередей не осталось, удаление возвращается в план', () => {
    const o = opts({ conn: USB, queueName: 'HP_USB' });
    expect(hplipQueuesLeft(s(), o)).toEqual([]);
    expect(hplipKept(s(), o)).toBe('');
    expect(ids(s(), o)).toContain('hplip');
  });
});

describe('lpoptions', () => {
  test('убираются только строки удалённых очередей', () => {
    const text = 'Default Old\nDest Old/copy sides=two-sided-long-edge\nDest Keep media=A4\nDest Older x=1\n';
    expect(stripLpoptions(text, ['Old'])).toBe('Dest Keep media=A4\nDest Older x=1\n');
  });
});

// ─── SANE ─────────────────────────────────────────────────────────────────────

describe('airscan.conf', () => {
  test('ручной конфиг с комментариями', () => {
    const c = parseAirscanConf([
      '[options]', '; discovery = enable', 'discovery = disable',
      '[devices]', '"HP LaserJet MFP M426fdn (10.82.230.207)" = http://10.82.230.207/eSCL/, eSCL',
    ].join('\n'));
    expect(c).toEqual({
      url: 'http://10.82.230.207/eSCL/', ip: '10.82.230.207',
      discoveryDisabled: true, managed: false,
    });
  });

  test('сгенерированный конфиг читается обратно', () => {
    const c = parseAirscanConf(airscanConf('HP "M426" (10.0.0.5)', 'http://10.0.0.5/eSCL/'));
    expect(c).toEqual({
      url: 'http://10.0.0.5/eSCL/', ip: '10.0.0.5', discoveryDisabled: true, managed: true,
    });
  });

  test('сканер по USB — локальный адрес ipp-usb, а не IP', () => {
    const c = parseAirscanConf(airscanConf('HP M426 (USB)', 'http://127.0.0.1:60000/eSCL/'));
    expect(c.url).toBe('http://127.0.0.1:60000/eSCL/');
    expect(c.ip).toBe('');
  });

  test('пустой файл', () => {
    expect(parseAirscanConf('')).toEqual({
      url: '', ip: '', discoveryDisabled: false, managed: false,
    });
  });
});

// ─── план ─────────────────────────────────────────────────────────────────────

const state = (over: Partial<SystemState> = {}): SystemState => ({
  queues: parseQueues(V, P, [], []),
  hplip: ['hplip', 'hplip-libs', 'libsane-hpaio'],
  hpSystray: true,
  units: [
    { unit: 'cups-browsed.service', enabled: 'masked', active: false },
    { unit: 'avahi-daemon.socket',  enabled: 'masked', active: false },
    { unit: 'avahi-daemon.service', enabled: 'masked', active: false },
  ],
  sharing: 'off',
  saneAirscan: true,
  airscan: {
    url: 'http://10.82.230.207/eSCL/', ip: '10.82.230.207',
    discoveryDisabled: true, managed: false,
  },
  usb: [],
  ippUsb: { installed: false, active: false },
  ...over,
});
const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({
  conn: NET, queueName: 'HP_LaserJet_MFP_M426fdn',
  testPage: true, removeHplip: true, hideDiscovery: true, scanner: true, removeOthers: false,
  ...over,
});
const ids = (s: SystemState, o: MigrateOptions, pr: PrinterProbe = probe()) =>
  planMigration(s, o, pr).map(p => p.id);

describe('план перевода', () => {
  test('уже скрытое автообнаружение и настроенный сканер не трогаются', () => {
    expect(ids(state(), opts())).toEqual(['backup', 'queue', 'remove-queues', 'test-page', 'hplip']);
  });

  test('бэкап всегда первый, hplip — всегда последний', () => {
    const p = ids(state({ sharing: 'on', saneAirscan: false, airscan: { url: '', ip: '', discoveryDisabled: false, managed: false } }), opts());
    expect(p[0]).toBe('backup');
    expect(p[p.length - 1]).toBe('hplip');
    expect(p).toContain('discovery');
    expect(p).toContain('airscan-install');
    expect(p).toContain('airscan');
  });

  test('без установленного hplip шага удаления нет', () => {
    expect(ids(state({ hplip: [] }), opts())).not.toContain('hplip');
  });

  test('работающая, хоть и замаскированная служба останавливается', () => {
    const s = state({ units: [{ unit: 'avahi-daemon.service', enabled: 'masked', active: true }] });
    expect(ids(s, opts())).toContain('discovery');
    expect(discoveryHidden(s)).toBe(false);
    expect(discoveryHidden(state())).toBe(true);
  });

  test('откат размаскирует только то, что маскировали', () => {
    const r = rollbackScript('/root/bk', ['avahi-daemon.service'], ['hplip']);
    expect(r).toContain('systemctl unmask avahi-daemon.service');
    expect(r).not.toContain('cups-browsed');
    expect(r).toContain('dnf install hplip');
  });
});

// ─── диагностика ──────────────────────────────────────────────────────────────

const probe = (over: Partial<PrinterProbe> = {}): PrinterProbe => ({
  conn: NET, host: '10.82.230.207', port: 631,
  reachable: true, ippOpen: true, escl: true, ippError: '',
  ippUsb: { installed: false, active: false }, usbBlock: '', usbPending: '',
  ipp: {
    model: 'HP LaserJet MFP M426fdn', deviceId: 'MFG:HP;MDL:LaserJet MFP M426fdn;SN:CNB1234567;',
    state: 'idle', reasons: [], message: '', accepting: true,
    formats: ['image/urf'], sides: ['one-sided'], media: [], markers: [], firmware: '', everywhere: true,
  },
  ...over,
});

/** Проба USB-аппарата, уже опубликованного ipp-usb. */
const usbProbe = (over: Partial<PrinterProbe> = {}): PrinterProbe => probe({
  conn: USB, host: '127.0.0.1', port: 60000,
  ippUsb: { installed: true, active: true },
  ...over,
});

describe('диагностика', () => {
  const qs = parseQueues(V, P, [], []);
  const journal = filterCupsJournal([
    'cupsd[792]: REQUEST localhost - root "POST /admin/ HTTP/1.1" 200 177 Resume-Printer successful-ok',
    'hp[3334]: io/hpmud/jd.c 94: unable to read device-id',
    'hp[3334]: prnt/backend/hp.c 824: ERROR: open device failed stat=12: hp:/net/HP?ip=10.82.230.207',
    'cupsd[792]: [Job 243] Backend hp returned status 1 (failed)',
  ]);

  test('из журнала берутся только строки об ошибках бэкенда', () => {
    expect(journal).toHaveLength(3);
  });

  test('hp:-очередь со сбоем hplip → перевод на driverless', () => {
    const d = analyze(qs[1], probe(), journal);
    expect(d.advice).toBe('migrate');
    expect(d.problems.some(p => p.includes('hplip'))).toBe(true);
  });

  test('рабочая driverless-очередь → проблем нет', () => {
    const q: PrintQueue = { ...qs[0], errorPolicy: 'retry-job' };
    expect(analyze(q, probe(), []).advice).toBe('none');
  });

  test('остановленная driverless-очередь → восстановить', () => {
    const q: PrintQueue = { ...qs[0], errorPolicy: 'retry-job', enabled: false };
    expect(analyze(q, probe(), []).advice).toBe('restore');
  });

  test('замятие на МФУ — проблема аппарата, не очереди', () => {
    const p = probe();
    p.ipp!.reasons = ['media-jam-error'];
    expect(analyze({ ...qs[0], errorPolicy: 'retry-job' }, p, []).advice).toBe('printer');
  });

  test('перевод блокируется, если МФУ не отвечает по IPP или не умеет Everywhere', () => {
    expect(migrationBlocker(probe())).toBe('');
    expect(migrationBlocker(probe({ reachable: false }))).toContain('ping');
    expect(migrationBlocker(probe({ ippOpen: false }))).toContain('631');
    expect(migrationBlocker(probe({ ipp: null, ippError: 'HTTP 404' }))).toContain('HTTP 404');
    const p = probe(); p.ipp!.everywhere = false;
    expect(migrationBlocker(p)).toContain('IPP Everywhere');
  });

  test('сломанный аппарат с копиями в очереди → сначала закрыть очередь', () => {
    const p = probe();
    p.ipp!.reasons = ['media-jam-error'];
    const q: PrintQueue = { ...qs[0], errorPolicy: 'retry-job', jobs: 9 };
    const jobs = Array.from({ length: 9 }, (_, i) => ({ id: `${i}`, user: 'u', title: 'Отчёт.odt' }));
    const d = analyze(q, p, [], jobs);
    expect(d.advice).toBe('clear');
    expect(d.problems.some(x => x.includes('«Отчёт.odt» ×9'))).toBe(true);
  });

  test('у USB-очереди не выдумывается отсутствующий IP и SNMP', () => {
    const usbQ = parseQueues(USB_V, USB_P, [], []).find(q => q.name === 'HP_USB')!;
    const d = analyze(usbQ, null, [], []);
    expect(d.problems.some(x => x.includes('нет ни адреса'))).toBe(false);
    expect(d.problems.some(x => x.includes('SNMP'))).toBe(false);
    expect(d.problems.some(x => x.includes('hplip'))).toBe(true);
  });
});

// ─── USB: аппарат, ipp-usb, план ──────────────────────────────────────────────

describe('USB-принтер', () => {
  const sysfs = (over: Record<string, unknown> = {}) => ([{
    port: '2-4', deviceId: '03f0:0f2a', serial: 'CNB1234567',
    manufacturer: 'HP', product: 'HP LaserJet MFP M426fdn', authorized: true,
    interfaces: ['07:01:02', '07:01:04', 'ff:cc:00'], declared: [], storage: [],
    ...over,
  }] as unknown as Parameters<typeof usbPrintersFrom>[0]);

  test('принтер опознаётся по классу интерфейса, IPP-over-USB — по протоколу 04', () => {
    const [p] = usbPrintersFrom(sysfs());
    expect(p.model).toBe('HP LaserJet MFP M426fdn');
    expect(p.ippOverUsb).toBe(true);
    expect(usbBlocker(p)).toBe('');
  });

  test('без интерфейса 07:*:04 driverless по USB невозможен', () => {
    const [p] = usbPrintersFrom(sysfs({ interfaces: ['07:01:02', 'ff:cc:00'] }));
    expect(p.ippOverUsb).toBe(false);
    expect(usbBlocker(p)).toContain('IPP-over-USB');
  });

  test('заблокированный политикой USB аппарат называет причину', () => {
    const [p] = usbPrintersFrom(sysfs({ authorized: false, interfaces: [], declared: ['07:01:04'] }));
    expect(p.blocked).toBe(true);
    expect(usbBlocker(p)).toContain('/usb-policy');
  });

  test('отсутствие ipp-usb — не препятствие, а шаг плана', () => {
    const p = usbDev();
    expect(usbBlocker(p)).toBe('');
    expect(usbPending({ installed: false, active: false }, 0)).toContain('установлен');
    expect(usbPending({ installed: true, active: false }, 0)).toContain('не запущена');
    expect(usbPending({ installed: true, active: true }, 0)).toContain('usblp');
    expect(usbPending({ installed: true, active: true }, 60000)).toBe('');
  });

  test('аппарат на порту ipp-usb узнаётся по серийнику из printer-device-id', () => {
    const info = { model: 'HP LaserJet MFP M426fdn', deviceId: 'MFG:HP;MDL:M426fdn;SN:CNB1234567;' };
    expect(matchesDevice(info as never, usbDev())).toBe(true);
    expect(matchesDevice(info as never, usbDev({ serial: 'OTHER999' }))).toBe(false);
  });

  test('перевод по USB не блокируется, пока ipp-usb не поднят', () => {
    const p = usbProbe({ ippOpen: false, ipp: null, usbPending: 'ipp-usb не установлен' });
    expect(migrationBlocker(p)).toBe('');
    expect(plannedUri(p)).toContain('<порт ipp-usb>');
  });

  test('в план USB попадает подъём ipp-usb, а очередь и сканер — на локальный порт', () => {
    const s = state({ usb: [usbDev()], ippUsb: { installed: false, active: false }, hplip: [] });
    const o = opts({ conn: USB, queueName: 'HP_USB' });
    const plan = planMigration(s, o, usbProbe());
    expect(plan.map(x => x.id)).toContain('ipp-usb');
    expect(plan.find(x => x.id === 'ipp-usb')!.detail.join(' ')).toContain('dnf install -y ipp-usb');
    expect(plan.find(x => x.id === 'queue')!.title).toContain('ipp://127.0.0.1:60000/ipp/print');
    expect(plan.find(x => x.id === 'airscan')!.detail.join(' ')).toContain('http://127.0.0.1:60000/eSCL/');
  });

  test('при уже работающем ipp-usb лишнего шага нет', () => {
    const s = state({ usb: [usbDev()], ippUsb: { installed: true, active: true } });
    expect(ids(s, opts({ conn: USB, queueName: 'HP_USB' }), usbProbe())).not.toContain('ipp-usb');
  });

  test('адрес сканера: сеть — 80 порт, USB — порт ipp-usb', () => {
    expect(esclUrl(probe())).toBe('http://10.82.230.207/eSCL/');
    expect(esclUrl(usbProbe())).toBe('http://127.0.0.1:60000/eSCL/');
  });
});

// ─── имя очереди ──────────────────────────────────────────────────────────────

describe('имя очереди', () => {
  test('пропускаются имена, которые примет CUPS', () => {
    expect(queueNameError('HP_LaserJet_MFP_M426fdn')).toBe('');
    expect(queueNameError('Бухгалтерия-МФУ')).toBe('');
  });

  test('запрещённое CUPS отсекается до начала перевода', () => {
    expect(queueNameError('')).toContain('пустым');
    expect(queueNameError('HP LaserJet')).toContain('пробел');
    expect(queueNameError('HP/2')).toContain('/');
    expect(queueNameError('HP#2')).toContain('#');
    expect(queueNameError('x'.repeat(128))).toContain('127');
  });
});

// ─── задания в очереди ────────────────────────────────────────────────────────

describe('задания', () => {
  const out = [
    'HP_LaserJet is not ready',
    'Rank    Owner   Job     File(s)                         Total Size',
    'active  psiholog 243    Отчёт за сентябрь.odt           951296 bytes',
    '1st     psiholog 244    Отчёт за сентябрь.odt           951296 bytes',
    '2nd     psiholog 245    Отчёт за сентябрь.odt           951296 bytes',
    '3rd     buh      246    Акт.pdf                         12288 bytes',
  ];

  test('lpq разбирается вместе с именами документов', () => {
    const jobs = parseLpq(out);
    expect(jobs).toHaveLength(4);
    expect(jobs[0]).toEqual({ id: '243', user: 'psiholog', title: 'Отчёт за сентябрь.odt' });
  });

  test('повторы одного документа считаются — это и есть сломанный принтер', () => {
    expect(duplicateJobs(parseLpq(out))).toEqual([{ title: 'Отчёт за сентябрь.odt', count: 3 }]);
  });

  test('шапка без заданий даёт пустой список', () => {
    expect(parseLpq(['HP is ready', 'no entries'])).toEqual([]);
  });
});
