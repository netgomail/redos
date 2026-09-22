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
  migrationBlocker, discoveryHidden, rollbackScript,
} from './printer';
import type { SystemState, MigrateOptions, PrintQueue, PrinterProbe } from './printer';

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
    expect(defaultQueueName(qs, '10.82.230.207')).toBe('HP_LaserJet_MFP_M426fdn');
    expect(defaultQueueName(qs, '10.82.230.99')).toBe('HP_MFP_99');
  });

  test('удаляются hplip-очереди и очереди на этот IP, чужие — только по выбору', () => {
    const base = { ip: '10.82.230.207', queueName: 'HP_LaserJet_MFP_M426fdn' };
    expect(queuesToRemove(qs, { ...base, removeOthers: false }).map(q => q.name))
      .toEqual(['Psiholog_HP_LaserJet_MFP_M426fdn']);
    expect(queuesToRemove(qs, { ...base, removeOthers: true }).map(q => q.name))
      .toEqual(['Psiholog_HP_LaserJet_MFP_M426fdn', 'Other']);
  });

  test('hp:-очередь можно перевести под тем же именем — тогда её не удаляют', () => {
    const r = queuesToRemove(qs, { ip: '10.82.230.207', queueName: 'Psiholog_HP_LaserJet_MFP_M426fdn', removeOthers: false });
    expect(r.map(q => q.name)).toEqual(['HP_LaserJet_MFP_M426fdn']);
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
    expect(c).toEqual({ ip: '10.82.230.207', discoveryDisabled: true, managed: false });
  });

  test('сгенерированный конфиг читается обратно', () => {
    const c = parseAirscanConf(airscanConf('HP "M426" (10.0.0.5)', '10.0.0.5'));
    expect(c).toEqual({ ip: '10.0.0.5', discoveryDisabled: true, managed: true });
  });

  test('пустой файл', () => {
    expect(parseAirscanConf('')).toEqual({ ip: '', discoveryDisabled: false, managed: false });
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
  airscan: { ip: '10.82.230.207', discoveryDisabled: true, managed: false },
  ...over,
});
const opts = (over: Partial<MigrateOptions> = {}): MigrateOptions => ({
  ip: '10.82.230.207', queueName: 'HP_LaserJet_MFP_M426fdn',
  testPage: true, removeHplip: true, hideDiscovery: true, scanner: true, removeOthers: false,
  ...over,
});
const ids = (s: SystemState, o: MigrateOptions) => planMigration(s, o).map(p => p.id);

describe('план перевода', () => {
  test('уже скрытое автообнаружение и настроенный сканер не трогаются', () => {
    expect(ids(state(), opts())).toEqual(['backup', 'queue', 'remove-queues', 'test-page', 'hplip']);
  });

  test('бэкап всегда первый, hplip — всегда последний', () => {
    const p = ids(state({ sharing: 'on', saneAirscan: false, airscan: { ip: '', discoveryDisabled: false, managed: false } }), opts());
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
  ip: '10.82.230.207', ping: true, port631: true, escl: true, ippError: '',
  ipp: {
    model: 'HP LaserJet MFP M426fdn', state: 'idle', reasons: [], message: '', accepting: true,
    formats: ['image/urf'], sides: ['one-sided'], media: [], markers: [], firmware: '', everywhere: true,
  },
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
    expect(migrationBlocker(probe({ ping: false }))).toContain('ping');
    expect(migrationBlocker(probe({ port631: false }))).toContain('631');
    expect(migrationBlocker(probe({ ipp: null, ippError: 'HTTP 404' }))).toContain('HTTP 404');
    const p = probe(); p.ipp!.everywhere = false;
    expect(migrationBlocker(p)).toContain('IPP Everywhere');
  });
});
