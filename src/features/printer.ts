/**
 * Печать и сканирование: перевод МФУ HP (M426 и подобных) с hplip на
 * driverless — IPP Everywhere для печати и eSCL (sane-airscan) для
 * сканирования. Аппарат может быть подключён по сети или по USB.
 *
 * Откуда это взялось (РедОС 8, HP LaserJet MFP M426fdn):
 *
 *  - Очередь на бэкенде hplip (hp:/net/...) перед каждым заданием читает
 *    device-id аппарата по SNMP. Если МФУ спит или пакет потерялся —
 *    «unable to read device-id», «open device failed stat=12», бэкенд
 *    завершается с ошибкой, и CUPS по error-policy=stop-printer
 *    останавливает очередь. Обратно её включал только root через HP Device
 *    Manager — пока у пользователей был sudo, это маскировало проблему.
 *
 *  - Драйвер «everywhere» (lpadmin -m everywhere) строит PPD по ответу
 *    самого аппарата и печатает по IPP на порт 631 — без hplip и SNMP.
 *    С error-policy=retry-job разовая ошибка больше не останавливает очередь.
 *
 *  - Через mDNS в списки печати и сканирования лезут все одинаковые МФУ сети.
 *    Поэтому cups-browsed и avahi отключаются, а сканер задаётся по IP.
 *
 *  - У аппарата на USB порта 631 нет, и hplip был единственным способом с ним
 *    говорить. Driverless по USB даёт демон ipp-usb (см. usbPrinter.ts): он
 *    публикует устройство на 127.0.0.1:60000, и дальше всё то же самое —
 *    everywhere, retry-job, eSCL. Перевод по USB возможен, только если
 *    аппарат умеет IPP-over-USB; если нет, утилита говорит это прямо и
 *    hplip не трогает.
 *
 * Порядок перевода важен: hplip удаляется последним и только после того, как
 * тестовая страница через новую очередь прошла. Перед изменениями — бэкап
 * /etc/cups и /etc/sane.d со скриптом отката.
 */

import { readdirSync } from 'fs';
import { readFile } from '../utils/fs';
import { isRoot } from '../utils/sudo';
import type { FixResult } from '../utils/sudo';
import { runPty, runPtyLines, stripAnsi } from '../utils/terminal';
import { getPrinterAttributes, summarize, blockingReasons, startFixingProxy } from './ipp';
import type { PrinterInfo } from './ipp';
import {
  findUsbPrinters, readIppUsbState, findIppUsbPort, usbBlocker, usbPending, usbPrinterName,
} from './usbPrinter';
import type { UsbPrinter, IppUsbState } from './usbPrinter';

export const SANE_AIRSCAN = '/etc/sane.d/airscan.conf';
export const CUPS_LPOPTS  = '/etc/cups/lpoptions';
const HEADER_MARK = '# redos-printer: managed';
const CUPS_TESTPAGE = '/usr/share/cups/data/testprint';

/** Службы автообнаружения, которые показывают чужие МФУ. */
export const DISCOVERY_UNITS = [
  'cups-browsed.service',
  'avahi-daemon.socket',
  'avahi-daemon.service',
] as const;

/** Локаль для разбора вывода: иначе lpstat отвечает по-русски и парсер ломается. */
const C_LOCALE = { LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };

// ─── запуск команд ────────────────────────────────────────────────────────────

/**
 * Асинхронный запуск системной команды: Ink продолжает рисовать лог, пока
 * идут долгие lpadmin (опрашивает аппарат) и dnf. Команда /printer открывается
 * только под root, sudo -n — на случай запуска из-под sudo-пользователя.
 */
async function sys(argv: string[], timeoutMs = 60_000): Promise<FixResult & { code: number }> {
  const full = isRoot() ? argv : ['sudo', '-n', ...argv];
  const r = await runPty(full, { env: C_LOCALE, timeoutMs });
  const out = stripAnsi(r.output).trim();
  if (r.code === 0) return { ok: true, msg: out, code: 0 };
  if (/password is required|a password/.test(out))
    return { ok: false, msg: 'Требуется sudo. Запустите: sudo redos', code: r.code };
  const tail = out.split('\n').filter(Boolean).slice(-3).join(' / ');
  return { ok: false, msg: r.timedOut ? `${argv[0]}: превышено время ожидания` : tail || `exit ${r.code}`, code: r.code };
}

async function lines(argv: string[], timeoutMs = 15_000): Promise<string[]> {
  return runPtyLines(argv, { env: C_LOCALE, timeoutMs });
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function isIpv4(s: string): boolean {
  const p = s.split('.');
  return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}

export function ipFromUri(uri: string): string {
  return uri.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1] ?? '';
}

/**
 * URI смотрит на эту же машину: так выглядит USB-аппарат, опубликованный
 * ipp-usb. Адрес 127.0.0.1 — не «сетевой принтер», и считать его таковым
 * нельзя: IP у него общий с любым другим локальным сервисом.
 */
export function isLocalUri(uri: string): boolean {
  return /^ipps?:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?(?:\/|$)/i.test(uri);
}

/** Порт из URI очереди; 0 — не указан. */
export function portFromUri(uri: string): number {
  return Number(uri.match(/^[a-z]+:\/\/[^/:]+:(\d+)/i)?.[1] ?? 0);
}

/** Как подключён аппарат этой очереди. */
export type ConnKind = 'net' | 'usb' | 'other';

/**
 * Транспорт очереди по её URI.
 *
 * usb:/... и hp:/usb/... — прямое подключение; ipp://127.0.0.1:60000/ — оно же,
 * но уже через ipp-usb. Различать обязательно: половина проверок (ping, порт
 * 631, адрес в airscan.conf) для USB не имеет смысла, а перевод сетевого МФУ
 * не должен трогать очередь чужого транспорта.
 */
export function connOfUri(uri: string): ConnKind {
  if (/^usb:/i.test(uri) || /^hp(fax)?:\/+usb\//i.test(uri)) return 'usb';
  if (isLocalUri(uri)) return 'usb';
  return ipFromUri(uri) ? 'net' : 'other';
}

/** Серийный номер из URI очереди: ?serial=CNB1234567 у usb: и hp:/usb/. */
export function serialFromUri(uri: string): string {
  const raw = uri.match(/[?&]serial=([^&]+)/i)?.[1] ?? '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── очереди CUPS ─────────────────────────────────────────────────────────────

export interface PrintQueue {
  name:        string;
  uri:         string;   // ipp://10.82.230.207/ipp/print
  backend:     string;   // ipp | hp | hpfax | usb | socket | dnssd
  ip:          string;   // из URI; пусто для usb: и для локального ipp-usb
  conn:        ConnKind;
  serial:      string;   // из URI usb:/hp:/usb/ — чем очередь привязана к аппарату
  ippPort:     number;   // порт локального ipp-usb, 0 для остальных
  enabled:     boolean;
  accepting:   boolean;
  stateText:   string;
  reason:      string;   // причина остановки
  isDefault:   boolean;
  errorPolicy: string;   // stop-printer | retry-job | ''
  jobs:        number;   // незавершённых заданий
}

/** Бэкенды hplip: без hplip не работают, при переводе удаляются. */
export function isHplipBackend(backend: string): boolean {
  return backend === 'hp' || backend === 'hpfax';
}

/**
 * Очередь уже driverless: говорит по IPP на конкретный адрес.
 *
 * Локальный ipp://127.0.0.1:60000/ считается наравне с сетевым — это тот же
 * IPP Everywhere, просто аппарат подключён по USB и опубликован ipp-usb.
 * Адрес обязан быть конкретным: ipp:// на имя из mDNS ведёт через
 * cups-browsed к любому аппарату сети, ради ухода от которого всё и делалось.
 */
export function isDriverless(q: PrintQueue): boolean {
  return (q.backend === 'ipp' || q.backend === 'ipps') && (q.ip !== '' || isLocalUri(q.uri));
}

/** Разбор lpstat -v/-p/-d/-o (под LC_ALL=C). Без побочных эффектов — для тестов. */
export function parseQueues(v: string[], p: string[], d: string[], o: string[]): PrintQueue[] {
  const queues = new Map<string, PrintQueue>();
  for (const l of v) {
    const m = l.match(/^device for ([^:]+):\s*(.+)$/);
    if (!m) continue;
    const uri = m[2].trim();
    const local = isLocalUri(uri);
    queues.set(m[1], {
      name: m[1], uri,
      backend: uri.split(':')[0] ?? '',
      // У локальной очереди ipp-usb адрес 127.0.0.1 — он ничего не говорит об
      // аппарате, поэтому в ip не попадает: иначе очередь выглядела бы сетевой.
      ip: local ? '' : ipFromUri(uri),
      conn: connOfUri(uri),
      serial: serialFromUri(uri),
      ippPort: local ? portFromUri(uri) : 0,
      enabled: true, accepting: true,
      stateText: '', reason: '', isDefault: false,
      errorPolicy: '', jobs: 0,
    });
  }

  // printer HP is idle.  enabled since ...
  // printer HP disabled since ...  -
  //         Printer stopped due to backend errors
  let cur: PrintQueue | undefined;
  for (const l of p) {
    const m = l.match(/^printer (\S+) /);
    if (m) {
      cur = queues.get(m[1]);
      if (cur) {
        cur.stateText = l.replace(/^printer \S+\s*/, '').trim();
        cur.enabled   = !/disabled|stopped/i.test(l);
      }
      continue;
    }
    if (cur && /^\s+\S/.test(l) && !cur.reason) {
      const reason = l.trim();
      if (reason !== '-') cur.reason = reason;
    }
  }

  const def = d.find(l => l.includes('default destination'))?.match(/:\s*(\S+)/)?.[1];
  if (def && queues.has(def)) queues.get(def)!.isDefault = true;

  for (const l of o) {
    const q = l.match(/^(\S+)-\d+\s/)?.[1];
    if (q && queues.has(q)) queues.get(q)!.jobs++;
  }
  return [...queues.values()];
}

export async function listQueues(): Promise<PrintQueue[]> {
  const [v, p, d, o, a] = await Promise.all([
    lines(['lpstat', '-v']), lines(['lpstat', '-p']),
    lines(['lpstat', '-d']), lines(['lpstat', '-o']),
    lines(['lpstat', '-a']),
  ]);
  const queues = parseQueues(v, p, d, o);
  const conf = readFile('/etc/cups/printers.conf') ?? '';
  const rejecting = notAccepting(a);
  for (const q of queues) {
    q.accepting   = !rejecting.has(q.name);
    q.errorPolicy = errorPolicyFrom(conf, q.name);
  }
  return queues;
}

/** Очереди из lpstat -a, которые не принимают задания: «HP not accepting requests since ...». */
export function notAccepting(a: string[]): Set<string> {
  return new Set(a.map(l => l.match(/^(\S+) not accepting/)?.[1]).filter((n): n is string => !!n));
}

/** ErrorPolicy очереди из printers.conf (читается под root). */
export function errorPolicyFrom(printersConf: string, queue: string): string {
  const block = printersConf.match(
    new RegExp(`<(?:Default)?Printer ${escapeRe(queue)}>([\\s\\S]*?)</(?:Default)?Printer>`),
  )?.[1];
  return block?.match(/^\s*ErrorPolicy\s+(\S+)/m)?.[1] ?? '';
}

// ─── состояние системы ────────────────────────────────────────────────────────

export interface AirscanConf {
  url:               string;   // http://10.82.230.207/eSCL/ или http://127.0.0.1:60000/eSCL/
  ip:                string;   // из url; пусто, когда сканер локальный (ipp-usb)
  discoveryDisabled: boolean;
  managed:           boolean;  // записан этой утилитой
}

export interface SystemState {
  queues:      PrintQueue[];
  hplip:       string[];                          // установленные пакеты hplip
  hpSystray:   boolean;
  units:       { unit: string; enabled: string; active: boolean }[];
  sharing:     'off' | 'on' | 'unknown';          // общий доступ CUPS
  saneAirscan: boolean;
  airscan:     AirscanConf;
  usb:         UsbPrinter[];                      // принтеры на USB из sysfs
  ippUsb:      IppUsbState;
}

/** Автообнаружение выключено: все службы замаскированы/отсутствуют и не работают. */
export function discoveryHidden(s: SystemState): boolean {
  return s.units.every(u => (u.enabled === 'masked' || u.enabled === 'not-found' || u.enabled === '') && !u.active);
}

export function parseAirscanConf(text: string): AirscanConf {
  let section = '';
  let url = '';
  let discoveryDisabled = false;
  for (const raw of text.split('\n')) {
    const l = raw.replace(/[;#].*$/, '').trim();
    if (!l) continue;
    const sec = l.match(/^\[(\w+)\]$/);
    if (sec) { section = sec[1].toLowerCase(); continue; }
    if (section === 'options' && /^discovery\s*=\s*disable$/i.test(l)) discoveryDisabled = true;
    if (section === 'devices' && !url && /eSCL/i.test(l)) {
      url = l.match(/=\s*(https?:\/\/\S+?)\s*,/i)?.[1] ?? '';
    }
  }
  return {
    url,
    ip: isLocalUri(url.replace(/^http/, 'ipp')) ? '' : ipFromUri(url),
    discoveryDisabled,
    managed: text.includes(HEADER_MARK),
  };
}

/** Сканер задаётся адресом, а не автопоиском: у сетевого — IP, у USB — ipp-usb. */
export function airscanConf(scannerName: string, url: string): string {
  return [
    HEADER_MARK,
    '# Сканер задан адресом, автопоиск выключен: в сети несколько одинаковых МФУ.',
    '',
    '[devices]',
    `"${scannerName.replace(/"/g, "'")}" = ${url}, eSCL`,
    '',
    '[options]',
    'discovery = disable',
    '',
  ].join('\n');
}

export async function readSystemState(): Promise<SystemState> {
  const [queues, rpm, systray, cupsctl, airscanPkg, ippUsb, ...unitInfo] = await Promise.all([
    listQueues(),
    lines(['rpm', '-qa', '--qf', '%{NAME}\\n', 'hplip*', 'libsane-hpaio*']),
    runPty(['pgrep', '-f', 'hp-systray'], { timeoutMs: 5000 }),
    lines(['cupsctl'], 10_000),
    runPty(['rpm', '-q', 'sane-airscan'], { timeoutMs: 10_000 }),
    readIppUsbState(),
    ...DISCOVERY_UNITS.map(async unit => {
      const [en, act] = await Promise.all([
        lines(['systemctl', 'is-enabled', unit], 8000),
        runPty(['systemctl', 'is-active', '-q', unit], { timeoutMs: 8000 }),
      ]);
      const enabled = en.map(s => s.trim()).find(Boolean) ?? '';
      return { unit, enabled: /No such file|not-found/i.test(enabled) ? 'not-found' : enabled, active: act.code === 0 };
    }),
  ]);

  const opts = Object.fromEntries(cupsctl.map(l => l.trim().split('=')).filter(kv => kv.length === 2));
  const sharing = opts._share_printers === undefined ? 'unknown'
    : opts._share_printers === '0' && opts._remote_any !== '1' ? 'off' : 'on';

  return {
    queues,
    hplip:       rpm.map(s => s.trim()).filter(s => /^(hplip[\w-]*|libsane-hpaio)$/.test(s)),
    hpSystray:   systray.code === 0,
    units:       unitInfo,
    sharing,
    saneAirscan: airscanPkg.code === 0,
    airscan:     parseAirscanConf(readFile(SANE_AIRSCAN) ?? ''),
    usb:         findUsbPrinters(),
    ippUsb,
  };
}

// ─── проверка аппарата ────────────────────────────────────────────────────────

/**
 * Куда переводить: сетевой аппарат по IP или USB-аппарат из sysfs.
 *
 * Разделение здесь, а не «IP или пусто», потому что от транспорта зависит
 * буквально всё: чем аппарат опознан, как до него достучаться, какие
 * проверки имеют смысл и какие шаги попадут в план.
 */
export type Conn =
  | { kind: 'net'; ip: string }
  | { kind: 'usb'; usb: UsbPrinter };

export function connLabel(c: Conn): string {
  return c.kind === 'net' ? c.ip : `USB · ${usbPrinterName(c.usb)}`;
}

/** Ключ подключения: по нему сверяются очереди и кандидаты. */
export function connKey(c: Conn): string {
  return c.kind === 'net' ? `net:${c.ip}` : `usb:${c.usb.deviceId}:${c.usb.serial}`;
}

export interface PrinterProbe {
  conn:      Conn;
  /** Куда реально ходим по IPP: IP аппарата или 127.0.0.1 для ipp-usb. */
  host:      string;
  port:      number;
  /** Аппарат на связи: сеть — ping или порт 631, USB — ipp-usb его поднял. */
  reachable: boolean;
  /** Ответ на ping. Только для сведения: ICMP часто закрыт, а IPP при этом работает. */
  ping:      boolean;
  ippOpen:   boolean;
  escl:      boolean;
  ipp:       PrinterInfo | null;
  ippError:  string;
  /** Состояние ipp-usb; только для USB. */
  ippUsb:    IppUsbState;
  /** Почему driverless по USB невозможен вовсе. */
  usbBlock:  string;
  /** Что мешает опросить аппарат прямо сейчас, но будет сделано при переводе. */
  usbPending: string;
}

export async function checkPort(ip: string, port: number, timeoutMs = 2000): Promise<boolean> {
  const { createConnection } = await import('net');
  return new Promise(resolve => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    const sock = createConnection({ host: ip, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error',   () => finish(false));
  });
}

export async function pingHost(ip: string): Promise<boolean> {
  const r = await runPty(['ping', '-c', '2', '-W', '2', ip], { timeoutMs: 8000, env: C_LOCALE });
  return r.code === 0;
}

/**
 * eSCL по http: https к МФУ перехватывает антивирус.
 *
 * У сетевого аппарата сканер живёт на 80 порту, у опубликованного ipp-usb —
 * на том же порту, что и печать: демон отдаёт оба протокола сразу.
 */
export async function probeEscl(
  host: string, port = 80, timeoutMs = 6000,
): Promise<{ ok: boolean; model: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(`http://${host}:${port}/eSCL/ScannerCapabilities`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, model: '' };
    const xml = await resp.text();
    return { ok: true, model: xml.match(/<pwg:MakeAndModel>([^<]*)</)?.[1]?.trim() ?? '' };
  } catch {
    return { ok: false, model: '' };
  }
}

/** Адрес eSCL для airscan.conf — тот же, по которому мы аппарат и проверяли. */
export function esclUrl(p: PrinterProbe): string {
  const port = p.conn.kind === 'net' ? 80 : p.port;
  return port === 80 ? `http://${p.host}/eSCL/` : `http://${p.host}:${port}/eSCL/`;
}

/** URI очереди CUPS для этого аппарата. */
export function queueUri(p: PrinterProbe): string {
  return p.port === 631 ? `ipp://${p.host}/ipp/print` : `ipp://${p.host}:${p.port}/ipp/print`;
}

async function probeIpp(res: PrinterProbe): Promise<void> {
  try {
    const r = await getPrinterAttributes(res.host, res.port);
    if (r.status >= 0x0100) res.ippError = `IPP status 0x${r.status.toString(16).padStart(4, '0')}`;
    else res.ipp = summarize(r.attrs);
  } catch (e) {
    res.ippError = (e as Error).message;
  }
}

export async function probePrinter(conn: Conn): Promise<PrinterProbe> {
  const res: PrinterProbe = {
    conn, host: '', port: 631, reachable: false, ping: false, ippOpen: false, escl: false,
    ipp: null, ippError: '', ippUsb: { installed: false, active: false },
    usbBlock: '', usbPending: '',
  };

  if (conn.kind === 'net') {
    // ping и порт — параллельно и на равных: во многих сетях ICMP до принтеров
    // закрыт, и аппарат, отвечающий по IPP, нельзя объявлять недоступным.
    res.host = conn.ip;
    const [ping, open, escl] = await Promise.all([
      pingHost(conn.ip), checkPort(conn.ip, 631), probeEscl(conn.ip),
    ]);
    res.ping = ping;
    res.ippOpen = open;
    res.reachable = ping || open;
    res.escl = escl.ok;
    if (open) await probeIpp(res);
    return res;
  }

  // USB: аппарат уже опознан в sysfs, спрашивать его самого можно только
  // через ipp-usb — значит, сначала демон, и лишь потом протокол.
  res.host = '127.0.0.1';
  res.usbBlock = usbBlocker(conn.usb);
  if (res.usbBlock) return res;
  res.ippUsb = await readIppUsbState();
  const port = res.ippUsb.active ? await findIppUsbPort(conn.usb) : 0;
  res.usbPending = usbPending(res.ippUsb, port);
  if (port === 0) return res;

  res.port = port;
  res.reachable = true;
  res.ping = true;
  res.ippOpen = true;
  await probeIpp(res);
  const escl = await probeEscl(res.host, port);
  res.escl = escl.ok;
  return res;
}

/**
 * Можно ли настраивать сканер. У USB, пока ipp-usb не поднят, спросить eSCL
 * негде — это выяснится в ходе перевода, поэтому «можно».
 */
export function scannerPossible(p: PrinterProbe): boolean {
  return p.escl || (p.conn.kind === 'usb' && !p.ippOpen);
}

/** Почему перевод на этот аппарат невозможен; пустая строка — можно. */
export function migrationBlocker(p: PrinterProbe): string {
  if (p.conn.kind === 'usb') {
    if (p.usbBlock) return p.usbBlock;
    // ipp-usb ещё не поднят: это не препятствие, а работа — демон ставится в
    // ходе перевода, и аппарат опрашивается уже после. Остальные проверки
    // спрашивать сейчас не о чем.
    if (!p.ippOpen) return '';
  } else {
    if (!p.reachable) return `${p.conn.ip} не отвечает ни на ping, ни на порт 631 — МФУ выключен или недоступен по сети`;
    if (!p.ippOpen)   return `порт 631 (IPP) на ${p.conn.ip} закрыт — включите IPP в веб-интерфейсе МФУ`;
  }
  if (!p.ipp) return `МФУ не ответил по IPP${p.ippError ? ': ' + p.ippError : ''}`;
  if (!p.ipp.everywhere)
    return 'МФУ не сообщает поддержку PWG-raster/URF — IPP Everywhere невозможен';
  return '';
}

// ─── задания в очереди ───────────────────────────────────────────────────────

export interface QueueJob {
  id:    string;
  user:  string;
  title: string;   // имя документа
}

/**
 * Разбор lpq -P: он, в отличие от lpstat -o, показывает имя документа.
 *
 * Имя нужно ровно для одного: увидеть, что в очереди лежит один и тот же файл
 * десять раз. Так выглядит сломанный принтер со стороны пользователя — он
 * жмёт «печать» снова и снова, и очередь набивается копиями.
 */
export function parseLpq(out: string[]): QueueJob[] {
  const jobs: QueueJob[] = [];
  let started = false;
  for (const l of out) {
    if (/^Rank\s+Owner\s+Job\s/i.test(l)) { started = true; continue; }
    if (!started) continue;
    const m = l.match(/^(?:active|\d+\S*)\s+(\S+)\s+(\d+)\s+(.*?)\s+\d+\s+bytes\s*$/i);
    if (m) jobs.push({ id: m[2], user: m[1], title: m[3].trim() });
  }
  return jobs;
}

/** Документы, отправленные больше одного раза, — от самых частых. */
export function duplicateJobs(jobs: QueueJob[]): { title: string; count: number }[] {
  const byTitle = new Map<string, number>();
  for (const j of jobs) byTitle.set(j.title, (byTitle.get(j.title) ?? 0) + 1);
  return [...byTitle]
    .filter(([, n]) => n > 1)
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count);
}

export async function listJobs(queue: string): Promise<QueueJob[]> {
  return parseLpq(await lines(['lpq', '-P', queue], 15_000));
}

// ─── диагностика ──────────────────────────────────────────────────────────────

export interface Diagnosis {
  queue:    PrintQueue;
  probe:    PrinterProbe | null;  // null — аппарат очереди не опознан
  journal:  string[];
  jobs:     QueueJob[];
  problems: string[];
  /** Рекомендуемое действие. */
  advice:   'migrate' | 'restore' | 'clear' | 'printer' | 'none';
}

/** Сбои hplip в журнале: к очереди на IPP они отношения не имеют. */
const HPLIP_LINE = /open device failed|unable to read device-id|Backend hp(?:fax)? returned|\bhp(?:fax)?\[\d+\]|hpmud/i;

/**
 * Строки журнала cups и ipp-usb, которые объясняют сбои печати.
 *
 * Сбои hplip показываются только для очереди на hplip: после перевода они
 * остаются в журнале, и driverless-очередь иначе «унаследовала» бы чужие
 * ошибки. Без очереди (в тестах) фильтр по бэкенду не применяется.
 */
export function filterCupsJournal(journal: string[], queue?: PrintQueue): string[] {
  const hplip = !queue || isHplipBackend(queue.backend);
  return journal
    .filter(l => /stopped due to|open device failed|unable to read device-id|returned status [1-9]|Unable to (open|connect|locate|send)|Backend \S+ returned|not responding|not connected|will retry|connection (refused|reset)|timed out/i.test(l)
      || (/ipp-usb\[/.test(l) && /error|fail|reset|timeout|closed/i.test(l)))
    .filter(l => hplip || !HPLIP_LINE.test(l))
    .slice(-8);
}

/**
 * Аппарат, к которому ведёт очередь.
 *
 * У сетевой очереди он в URI, у USB — в sysfs, и связывает их серийник.
 * Когда серийника в URI нет (так выглядит очередь через ipp-usb), а
 * USB-принтер на машине один, берём его: выбора всё равно нет.
 */
export function connOfQueue(q: PrintQueue, usb: UsbPrinter[]): Conn | null {
  if (q.conn === 'net' && q.ip) return { kind: 'net', ip: q.ip };
  if (q.conn === 'usb') {
    const bySerial = q.serial ? usb.find(u => u.serial && u.serial === q.serial) : undefined;
    const pick = bySerial ?? (usb.length === 1 ? usb[0] : undefined);
    return pick ? { kind: 'usb', usb: pick } : null;
  }
  return null;
}

/** Штатные сообщения бэкенда: остаются в очереди после успешной печати. */
const BENIGN_STATE = /^(ready|idle|rendering completed|sending data|spooling|preparing|printing|connected|waiting for job to complete|job completed)/i;

export function analyze(
  queue: PrintQueue, probe: PrinterProbe | null, journal: string[], jobs: QueueJob[] = [],
): Diagnosis {
  const problems: string[] = [];
  const hplipFail = isHplipBackend(queue.backend)
    && journal.some(l => /open device failed|unable to read device-id/i.test(l));

  if (!queue.enabled)   problems.push(`очередь остановлена${queue.reason ? ': ' + queue.reason : ''}`);
  // Очередь с retry-job не останавливается, а молча повторяет задание раз в
  // 30 секунд. Единственный след — сообщение бэкенда в lpstat -p: его и
  // видит пользователь как «принтер недоступен».
  else if (queue.reason && !BENIGN_STATE.test(queue.reason))
    problems.push(`CUPS сообщает: ${queue.reason}`);
  if (!queue.accepting) problems.push('очередь не принимает задания');
  if (isHplipBackend(queue.backend))
    problems.push(queue.conn === 'usb'
      ? `бэкенд ${queue.backend} (hplip) по USB: держится на драйвере, который мы и убираем`
      : `бэкенд ${queue.backend} (hplip): перед каждым заданием читает device-id по SNMP, ` +
        'спящий МФУ даёт «open device failed» и остановку очереди');
  if (hplipFail)
    problems.push('в журнале cups есть сбои hplip (open device failed / unable to read device-id)');
  if (queue.errorPolicy && queue.errorPolicy !== 'retry-job')
    problems.push(`error-policy=${queue.errorPolicy} — первая же ошибка снова остановит очередь`);

  const dups = duplicateJobs(jobs);
  if (queue.jobs > 0) {
    problems.push(dups.length
      ? `в очереди заданий: ${queue.jobs}, из них повторы одного документа: ` +
        dups.map(d => `«${d.title}» ×${d.count}`).join(', ')
      : `в очереди заданий: ${queue.jobs}`);
  }
  if (queue.conn === 'other')
    problems.push('в URI очереди нет ни адреса, ни USB-устройства — аппарат неизвестен');

  let printerBad = false;
  if (probe) {
    const block = migrationBlocker(probe);
    if (block) {
      problems.push(block);
      printerBad = probe.conn.kind === 'net' ? !probe.reachable || !probe.ippOpen : probe.usbBlock !== '';
    }
    if (probe.usbPending) problems.push(probe.usbPending);
    const reasons = probe.ipp ? blockingReasons(probe.ipp.reasons) : [];
    if (reasons.length) { problems.push(`МФУ сообщает: ${reasons.join(', ')}`); printerBad = true; }
    if (probe.ipp?.state === 'stopped') { problems.push('МФУ в состоянии stopped'); printerBad = true; }
  }

  // Сломанный аппарат с копиями в очереди: чинить очередь бесполезно, пока
  // пользователь досылает те же документы. Сначала очистить и закрыть приём.
  const advice: Diagnosis['advice'] =
      printerBad && (queue.jobs > 0 || dups.length) ? 'clear'
    : printerBad ? 'printer'
    : !isDriverless(queue) || (queue.errorPolicy && queue.errorPolicy !== 'retry-job') ? 'migrate'
    : !queue.enabled || !queue.accepting || queue.jobs > 0 ? 'restore'
    : 'none';

  return { queue, probe, journal, jobs, problems, advice };
}

export async function diagnose(queue: PrintQueue, usb: UsbPrinter[] = []): Promise<Diagnosis> {
  const conn = connOfQueue(queue, usb);
  const [probe, journal, jobs] = await Promise.all([
    conn ? probePrinter(conn) : Promise.resolve(null),
    lines(['journalctl', '-u', 'cups', '-u', 'ipp-usb', '--since', '-7 days', '--no-pager'], 20_000),
    listJobs(queue.name),
  ]);
  return analyze(queue, probe, filterCupsJournal(journal, queue), jobs);
}

// ─── действия над очередью ───────────────────────────────────────────────────

/**
 * Быстрое действие для очереди, которая уже на IPP: включить, принять,
 * поставить retry-job, снять застрявшие задания. Бэкенд не трогает.
 */
export async function restoreQueue(queue: PrintQueue, onStep: (m: string) => void = () => {}): Promise<FixResult> {
  const done: string[] = [];
  onStep('error-policy=retry-job');
  const rp = await sys(['lpadmin', '-p', queue.name, '-o', 'printer-error-policy=retry-job']);
  if (!rp.ok) return { ok: false, msg: `lpadmin: ${rp.msg}` };
  done.push('error-policy=retry-job');
  onStep('Включаю очередь и приём заданий');
  if ((await sys(['cupsenable', queue.name])).ok) done.push('очередь включена');
  if ((await sys(['cupsaccept', queue.name])).ok) done.push('приём заданий разрешён');
  if (queue.jobs > 0) {
    onStep(`Снимаю застрявшие задания (${queue.jobs})`);
    if ((await sys(['cancel', '-a', queue.name])).ok) done.push(`снято заданий: ${queue.jobs}`);
  }
  return { ok: true, msg: done.join('; ') };
}

/** Снять из очереди всё. Отдельно от восстановления: чистят и рабочую очередь. */
export async function clearQueue(queue: PrintQueue, onStep: (m: string) => void = () => {}): Promise<FixResult> {
  onStep(`Снимаю задания (${queue.jobs})`);
  const r = await sys(['cancel', '-a', queue.name], 30_000);
  if (!r.ok) return { ok: false, msg: `cancel: ${r.msg}` };
  return { ok: true, msg: `снято заданий: ${queue.jobs}` };
}

/**
 * Закрыть очередь на время ремонта: снять всё и перестать принимать задания.
 *
 * Пока аппарат сломан, пользователь жмёт «печать» снова и снова и копит копии
 * одного документа. Закрытая очередь отвечает отказом сразу — человек видит,
 * что печать не работает, а не надеется, что вот-вот пойдёт. Обратно
 * открывает «Включить остановленную очередь».
 */
export async function closeQueue(queue: PrintQueue, onStep: (m: string) => void = () => {}): Promise<FixResult> {
  const done: string[] = [];
  onStep('Перестаю принимать задания');
  const rj = await sys(['cupsreject', '-r', 'принтер в ремонте (redos)', queue.name]);
  if (!rj.ok) return { ok: false, msg: `cupsreject: ${rj.msg}` };
  done.push('приём заданий закрыт');
  if (queue.jobs > 0) {
    onStep(`Снимаю задания (${queue.jobs})`);
    if ((await sys(['cancel', '-a', queue.name], 30_000)).ok) done.push(`снято заданий: ${queue.jobs}`);
  }
  done.push('открыть обратно: «Включить остановленную очередь»');
  return { ok: true, msg: done.join('; ') };
}

// ─── перевод на driverless: план ─────────────────────────────────────────────

export interface MigrateOptions {
  conn:         Conn;
  queueName:    string;
  testPage:     boolean;   // тестовая страница перед удалением hplip
  removeHplip:  boolean;
  hideDiscovery: boolean;  // cups-browsed, avahi, общий доступ CUPS
  scanner:      boolean;   // sane-airscan по адресу аппарата
  /** Удалить и очереди других аппаратов. */
  removeOthers: boolean;
}

export type StepId =
  | 'backup' | 'ipp-usb' | 'queue' | 'remove-queues' | 'discovery'
  | 'airscan-install' | 'airscan' | 'test-page' | 'hplip';

export interface PlanStep {
  id:     StepId;
  title:  string;
  detail: string[];
  danger: boolean;   // необратимо без отката
}

/**
 * Очередь ведёт к тому же аппарату, что и выбранное подключение.
 *
 * У сети сверяются адреса, у USB — серийники. Когда серийника нет ни в URI
 * (очередь через ipp-usb его не несёт), ни у устройства, остаётся транспорт:
 * на машине с одним USB-принтером этого достаточно, а с двумя серийник есть
 * у обоих — именно он и различает.
 */
export function isSameDevice(q: PrintQueue, c: Conn): boolean {
  if (c.kind === 'net') return q.conn === 'net' && q.ip !== '' && q.ip === c.ip;
  if (q.conn !== 'usb') return false;
  if (q.serial && c.usb.serial) return q.serial === c.usb.serial;
  return true;
}

/**
 * Проверка имени очереди; пустая строка — имя годится.
 *
 * CUPS запрещает в имени пробелы, «/», «#» и управляющие символы, причём
 * молча: lpadmin просто откажет уже после того, как мастер начал работу.
 * Поэтому имя проверяется до применения, на экране параметров.
 */
export function queueNameError(name: string): string {
  if (!name) return 'имя очереди не может быть пустым';
  if (name.length > 127) return 'имя длиннее 127 символов';
  // Тот же набор, что отвергает validate_name в lpadmin; «@» отделяет хост.
  const bad = [...name].find(c => '/\\?\'"#@ '.includes(c) || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
  if (bad !== undefined) return `в имени нельзя ${bad === ' ' ? 'пробел' : bad.charCodeAt(0) < 0x20 || bad.charCodeAt(0) === 0x7f ? 'управляющие символы' : `«${bad}»`}`;
  return '';
}

/** Модель в имя очереди: только латиница, цифры и «_». */
function nameFromModel(model: string): string {
  return model.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

/**
 * Имя очереди по умолчанию: сохраняем то, к которому привыкли пользователи.
 *
 * Новой очереди — имя по модели, которую назвал сам аппарат по IPP: так
 * в списке печати видно, что это за принтер, у какого угодно производителя.
 * У сетевого к модели добавляется последний октет адреса — одинаковых МФУ в
 * сети бывает несколько.
 */
export function defaultQueueName(queues: PrintQueue[], c: Conn, model = ''): string {
  const mine = queues.filter(q => isSameDevice(q, c));
  const pick = mine.find(q => q.isDefault && isDriverless(q))
    ?? mine.find(q => isDriverless(q))
    ?? mine.find(q => q.isDefault)
    ?? mine[0];
  if (pick) return pick.name;
  if (c.kind === 'net') {
    const octet = c.ip.split('.').pop();
    const base = nameFromModel(model);
    return base ? `${base}_${octet}` : `Printer_${octet}`;
  }
  return nameFromModel(usbPrinterName(c.usb)) || nameFromModel(model) || 'USB_Printer';
}

/**
 * Удалять ли hplip по умолчанию.
 *
 * Только когда переводится аппарат HP или очередь этого аппарата сидит на
 * hplip. Перевод Kyocera или Canon не повод сносить пакет, про который
 * администратор, может быть, и не вспоминал: снять галочку он всегда успеет.
 */
export function suggestRemoveHplip(s: SystemState, c: Conn, model = ''): boolean {
  if (s.hplip.length === 0) return false;
  if (s.queues.some(q => isHplipBackend(q.backend) && isSameDevice(q, c))) return true;
  const vendor = c.kind === 'usb' ? `${c.usb.vendor} ${c.usb.model}` : '';
  return /\bHP\b|hewlett/i.test(`${model} ${vendor}`);
}

/**
 * Очереди, которые будут удалены.
 *
 * Только очереди того же аппарата — и по выбору все остальные. Раньше сюда
 * безусловно попадала любая очередь на hplip, из-за чего перевод сетевого МФУ
 * молча сносил рабочую очередь USB-принтера, а следом и сам hplip. Чужой
 * аппарат переводится своим запуском мастера, а не удаляется заодно.
 */
export function queuesToRemove(
  queues: PrintQueue[], opts: Pick<MigrateOptions, 'conn' | 'queueName' | 'removeOthers'>,
): PrintQueue[] {
  return queues.filter(q => q.name !== opts.queueName
    && (isSameDevice(q, opts.conn) || opts.removeOthers));
}

/** Очереди на hplip, которые останутся работать после перевода. */
export function hplipQueuesLeft(s: SystemState, o: MigrateOptions): PrintQueue[] {
  const removed = new Set(queuesToRemove(s.queues, o).map(q => q.name));
  return s.queues.filter(q => isHplipBackend(q.backend)
    && !removed.has(q.name) && q.name !== o.queueName);
}

/**
 * Почему hplip не удаляется, хотя его просили удалить.
 *
 * Не запрет, а следствие: пакет держат оставшиеся очереди. Переведите их —
 * и удаление попадёт в план само.
 */
export function hplipKept(s: SystemState, o: MigrateOptions): string {
  if (!o.removeHplip || s.hplip.length === 0) return '';
  const left = hplipQueuesLeft(s, o);
  if (left.length === 0) return '';
  return `hplip не удаляется: на нём работают очереди ${left.map(q => q.name).join(', ')} ` +
         `(${left.map(q => q.conn === 'usb' ? 'USB' : q.ip || '?').join(', ')}). ` +
         'Переведите их тем же мастером — тогда hplip уйдёт.';
}

/**
 * URI будущей очереди.
 *
 * У USB, пока ipp-usb не поднят, порт неизвестен — показываем это прямо, а не
 * выдумываем число: демон выдаст его при запуске.
 */
export function plannedUri(p: PrinterProbe): string {
  if (p.conn.kind === 'usb' && !p.ippOpen) return 'ipp://127.0.0.1:<порт ipp-usb>/ipp/print';
  return queueUri(p);
}

export function planMigration(s: SystemState, o: MigrateOptions, probe: PrinterProbe): PlanStep[] {
  const uri = plannedUri(probe);
  const steps: PlanStep[] = [];

  steps.push({ id: 'backup', danger: false, title: 'Бэкап /etc/cups, /etc/sane.d и lpoptions пользователей',
    detail: ['/root/redos-printer-backup-<дата>/ с rollback.sh'] });

  if (o.conn.kind === 'usb' && (!s.ippUsb.installed || !s.ippUsb.active)) {
    steps.push({ id: 'ipp-usb', danger: false,
      title: 'Поднять ipp-usb — driverless для USB-аппарата',
      detail: [
        ...(s.ippUsb.installed ? [] : ['dnf install -y ipp-usb']),
        'systemctl enable --now ipp-usb',
        'демон опубликует МФУ на 127.0.0.1 — дальше как у сетевого',
      ] });
  }

  const existing = s.queues.find(q => q.name === o.queueName);
  steps.push({ id: 'queue', danger: false,
    title: existing ? `Очередь ${o.queueName} → ${uri} (IPP Everywhere)` : `Новая очередь ${o.queueName} → ${uri}`,
    detail: [
      'lpadmin -m everywhere, error-policy=retry-job, односторонняя печать по умолчанию',
      'включить, принимать задания, сделать очередью по умолчанию',
      ...(existing && existing.uri !== uri ? [`было: ${existing.uri}`] : []),
    ] });

  const remove = queuesToRemove(s.queues, o);
  if (remove.length) steps.push({ id: 'remove-queues', danger: true,
    title: `Удалить очереди: ${remove.length}`,
    detail: [...remove.map(q => `${q.name} — ${q.uri}`), 'и убрать их из lpoptions пользователей'] });

  if (o.hideDiscovery) {
    const units = s.units.filter(u => u.enabled !== 'not-found' && u.enabled !== ''
      && (u.enabled !== 'masked' || u.active)).map(u => u.unit);
    const detail = [
      ...(units.length ? [`остановить и замаскировать: ${units.join(', ')}`] : []),
      ...(s.sharing !== 'off' ? ['cupsctl --no-share-printers --no-remote-any'] : []),
      // ipp-usb анонсирует себя через avahi, но очередь смотрит на 127.0.0.1
      // напрямую — маскировка avahi на печать по USB не влияет.
      ...(o.conn.kind === 'usb' ? ['очередь ipp-usb задана по адресу и от mDNS не зависит'] : []),
    ];
    if (detail.length) steps.push({ id: 'discovery', danger: false,
      title: 'Отключить автообнаружение принтеров', detail });
  }

  if (o.scanner && scannerPossible(probe)) {
    if (!s.saneAirscan) steps.push({ id: 'airscan-install', danger: false,
      title: 'Установить sane-airscan', detail: ['dnf install -y sane-airscan'] });
    const url = probe.ippOpen ? esclUrl(probe) : 'http://127.0.0.1:<порт ipp-usb>/eSCL/';
    if (s.airscan.url !== url || !s.airscan.discoveryDisabled) steps.push({ id: 'airscan', danger: false,
      title: `Сканер: ${SANE_AIRSCAN}`, detail: [`${url}, автопоиск выключен`] });
  }

  if (o.testPage) steps.push({ id: 'test-page', danger: false,
    title: 'Тестовая страница через новую очередь',
    detail: ['ждать завершения до 2 минут; при неудаче hplip не удаляется'] });

  if (o.removeHplip && s.hplip.length && hplipQueuesLeft(s, o).length === 0)
    steps.push({ id: 'hplip', danger: true,
      title: 'Удалить hplip',
      detail: [`dnf remove ${s.hplip.join(' ')}`, 'остановить hp-systray, убрать его автозапуск'] });

  return steps;
}

// ─── перевод на driverless: выполнение ───────────────────────────────────────

export interface MigrateResult {
  ok:        boolean;
  lines:     string[];     // что сделано / что пошло не так
  backupDir: string;
  testJob:   string;       // id тестового задания
  after:     string[];     // lpstat -v после перевода
  scanners:  string[];     // scanimage -L
}

/** lpoptions всех пользователей и системный — там запомнен выбранный принтер. */
export function lpoptionsFiles(): string[] {
  const files = [CUPS_LPOPTS, '/root/.cups/lpoptions'];
  try {
    for (const h of readdirSync('/home')) files.push(`/home/${h}/.cups/lpoptions`);
  } catch { /* нет /home */ }
  return files.filter(f => readFile(f) !== null);
}

/** Убирает из lpoptions строки Default/Dest удалённых очередей. */
export function stripLpoptions(text: string, removed: string[]): string {
  const set = new Set(removed);
  return text.split('\n')
    .filter(l => { const m = l.match(/^(?:Default|Dest)\s+([^\s/]+)/); return !(m && set.has(m[1])); })
    .join('\n');
}

export function rollbackScript(backupDir: string, maskedUnits: string[], removedPkgs: string[]): string {
  return [
    '#!/usr/bin/env bash',
    '# Откат перевода на driverless (IPP Everywhere), выполненного утилитой redos.',
    'set -e',
    `BK="${backupDir}"`,
    'tar -C / -xzf "$BK/etc.tgz"',
    ...(maskedUnits.length ? [
      `systemctl unmask ${maskedUnits.join(' ')} || true`,
      `systemctl enable --now ${maskedUnits.join(' ')} || true`,
    ] : []),
    'systemctl restart cups',
    ...(removedPkgs.length ? [`echo "hplip был удалён. Вернуть: dnf install ${removedPkgs.join(' ')}"`] : []),
    'echo "Откат выполнен."',
    '',
  ].join('\n');
}

/** cupsd после cupsctl/restart какое-то время не принимает запросы. */
async function waitCups(timeoutMs = 30_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await runPty(['lpstat', '-r'], { env: C_LOCALE, timeoutMs: 5000 });
    if (r.code === 0 && /is running/.test(r.output)) return true;
    await sleep(1000);
  }
  return false;
}

async function writeRoot(file: string, content: string): Promise<FixResult> {
  if (isRoot()) {
    try { await Bun.write(file, content); return { ok: true, msg: '' }; }
    catch (e) { return { ok: false, msg: (e as Error).message }; }
  }
  const { writeSudo } = await import('../utils/sudo');
  return writeSudo(file, content);
}

/** Печатает тестовую страницу и ждёт, пока задание уйдёт на МФУ. */
async function printTestPage(queue: string, step: (m: string) => void): Promise<{ ok: boolean; job: string; msg: string }> {
  if (!await waitCups()) return { ok: false, job: '', msg: 'cupsd не отвечает' };

  let file = CUPS_TESTPAGE;
  if (readFile(file) === null) {
    file = `/tmp/redos-testpage-${process.pid}.txt`;
    await Bun.write(file, `Тестовая страница redos — ${new Date().toLocaleString('ru-RU')}\n` +
                          `Очередь: ${queue} (IPP Everywhere)\n`);
  }
  const r = await sys(['lp', '-d', queue, '-t', 'redos driverless test', file], 30_000);
  const job = r.msg.match(new RegExp(`${escapeRe(queue)}-\\d+`))?.[0] ?? '';
  if (!r.ok || !job) return { ok: false, job: '', msg: `lp: ${r.msg || 'задание не создано'}` };

  step(`Задание ${job} отправлено, жду завершения...`);
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const pending = await lines(['lpstat', '-W', 'not-completed', '-o', queue], 10_000);
    if (!pending.some(l => l.startsWith(job + ' '))) break;
    await sleep(2000);
  }
  const [pending, printer] = await Promise.all([
    lines(['lpstat', '-W', 'not-completed', '-o', queue], 10_000),
    lines(['lpstat', '-p', queue], 10_000),
  ]);
  if (pending.some(l => l.startsWith(job + ' ')))
    return { ok: false, job, msg: `задание ${job} не завершилось за 2 минуты` };
  if (printer.some(l => /disabled|stopped/i.test(l)))
    return { ok: false, job, msg: 'очередь остановилась после тестового задания' };
  return { ok: true, job, msg: `задание ${job} выполнено` };
}

/**
 * lpadmin -m everywhere с обходом битых ответов прошивки.
 *
 * Если lpadmin отверг ответ аппарата («Printer returned invalid data»), PPD
 * строится повторно через локальный прокси, который этот ответ чинит, а
 * затем очередь переводится на настоящий адрес — PPD при этом остаётся.
 */
async function addEverywhereQueue(
  o: MigrateOptions, uri: string, probe: PrinterProbe, onStep: (m: string) => void,
): Promise<{ ok: boolean; msg: string; fixed: string[] }> {
  const opts = [
    '-L', connLabel(o.conn),
    '-o', 'printer-error-policy=retry-job',
    '-o', 'sides-default=one-sided',
    '-o', 'Duplex=None',
  ];
  // Бумага по умолчанию — A4: иначе берётся media-default аппарата, а у
  // части прошивок это Letter, и задание ждёт не ту бумагу.
  const a4 = () => sys(['lpadmin', '-p', o.queueName, '-o', 'PageSize=A4']);

  const la = await sys(['lpadmin', '-p', o.queueName, '-E', '-v', uri, '-m', 'everywhere', ...opts], 90_000);
  if (la.ok) { await a4(); return { ...la, fixed: [] }; }
  if (!/returned invalid data/i.test(la.msg)) return { ...la, fixed: [] };

  onStep('МФУ отдал неверные данные — строю PPD через исправляющий прокси...');
  const proxy = startFixingProxy(probe.host, probe.port);
  try {
    const viaProxy = `ipp://127.0.0.1:${proxy.port}/ipp/print`;
    const lp = await sys(['lpadmin', '-p', o.queueName, '-E', '-v', viaProxy, '-m', 'everywhere', ...opts], 90_000);
    if (!lp.ok) return { ...lp, msg: `${la.msg} / через прокси: ${lp.msg}`, fixed: [] };
  } finally {
    proxy.stop();
  }
  const sv = await sys(['lpadmin', '-p', o.queueName, '-v', uri]);
  if (!sv.ok) {
    // очередь на адрес прокси без прокси мертва — не оставлять её
    await sys(['lpadmin', '-x', o.queueName]);
    return { ...sv, fixed: [] };
  }
  await a4();
  return { ok: true, msg: '', fixed: [...proxy.fixed] };
}

export async function migrate(
  s: SystemState, o: MigrateOptions, probe0: PrinterProbe, onStep: (m: string) => void = () => {},
): Promise<MigrateResult> {
  let probe = probe0;
  const res: MigrateResult = { ok: false, lines: [], backupDir: '', testJob: '', after: [], scanners: [] };
  const done = (m: string) => res.lines.push('✓ ' + m);
  const fail = (m: string) => { res.lines.push('✗ ' + m); return res; };
  const note = (m: string) => res.lines.push('• ' + m);

  const block = migrationBlocker(probe);
  if (block) return fail(block);
  const plan = new Set(planMigration(s, o, probe).map(p => p.id));

  // 1. бэкап
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  res.backupDir = `/root/redos-printer-backup-${stamp}`;
  onStep(`Бэкап в ${res.backupDir}`);
  const mk = await sys(['mkdir', '-p', res.backupDir]);
  if (!mk.ok) return fail(`не удалось создать ${res.backupDir}: ${mk.msg}`);
  const userOpts = lpoptionsFiles().filter(f => f !== CUPS_LPOPTS).map(f => f.slice(1));
  const tar = await sys(['tar', '-C', '/', '-czf', `${res.backupDir}/etc.tgz`, 'etc/cups', 'etc/sane.d', ...userOpts]);
  if (!tar.ok) return fail(`бэкап не создан: ${tar.msg}`);
  const maskUnits = s.units.filter(u => u.enabled !== 'not-found' && u.enabled !== '' && u.enabled !== 'masked').map(u => u.unit);
  await writeRoot(`${res.backupDir}/rollback.sh`, rollbackScript(
    res.backupDir, o.hideDiscovery ? maskUnits : [], o.removeHplip ? s.hplip : []));
  await sys(['chmod', '+x', `${res.backupDir}/rollback.sh`]);
  done(`бэкап: ${res.backupDir}`);

  // 1a. ipp-usb: без него у USB-аппарата нет адреса, по которому его заводить.
  //     Делается до очереди и до любых удалений — если демон не поднимется,
  //     ничего ещё не тронуто и откатывать нечего.
  if (plan.has('ipp-usb')) {
    if (!s.ippUsb.installed) {
      onStep('Устанавливаю ipp-usb...');
      const r = await sys(['dnf', 'install', '-y', 'ipp-usb'], 600_000);
      if (!r.ok) return fail(`ipp-usb не установлен: ${r.msg}`);
      done('установлен ipp-usb');
    }
    onStep('Запускаю ipp-usb...');
    const en = await sys(['systemctl', 'enable', '--now', 'ipp-usb'], 60_000);
    if (!en.ok) return fail(`ipp-usb не запустился: ${en.msg}`);
    done('ipp-usb запущен и включён в автозапуск');
  }

  // 1b. Аппарат по USB опрашиваем только теперь: до запуска демона порта не
  //     было. Проверки те же, что у сетевого, — до необратимых шагов.
  if (probe.conn.kind === 'usb' && !probe.ippOpen) {
    onStep('Жду, пока ipp-usb опубликует аппарат...');
    let fresh: PrinterProbe | null = null;
    for (let i = 0; i < 10; i++) {
      fresh = await probePrinter(probe.conn);
      if (fresh.ippOpen) break;
      await sleep(2000);
    }
    if (!fresh?.ippOpen) return fail(fresh?.usbPending || 'ipp-usb не опубликовал аппарат');
    const late = migrationBlocker(fresh);
    if (late) return fail(late);
    probe = fresh;
    done(`аппарат опубликован: ${queueUri(probe)}`);
  }

  const uri = queueUri(probe);

  // 2. очередь
  onStep(`Очередь ${o.queueName} → ${uri} (lpadmin опрашивает МФУ)...`);
  const la = await addEverywhereQueue(o, uri, probe, onStep);
  if (!la.ok) return fail(`lpadmin: ${la.msg}`);
  if (la.fixed.length) note(`прошивка МФУ отдаёт неверные данные (${la.fixed.join(', ')}) — PPD построен в обход`);
  await sys(['cupsenable', o.queueName]);
  await sys(['cupsaccept', o.queueName]);
  await sys(['lpadmin', '-d', o.queueName]);
  done(`очередь ${o.queueName}: IPP Everywhere, retry-job, односторонняя, по умолчанию`);

  // 3. лишние очереди
  if (plan.has('remove-queues')) {
    const removed: string[] = [];
    for (const q of queuesToRemove(s.queues, o)) {
      onStep(`Удаляю очередь ${q.name}`);
      if ((await sys(['lpadmin', '-x', q.name])).ok) removed.push(q.name);
      else note(`очередь ${q.name} удалить не удалось`);
    }
    for (const f of lpoptionsFiles()) {
      const text = readFile(f) ?? '';
      const next = stripLpoptions(text, removed);
      if (next !== text) await writeRoot(f, next);
    }
    if (removed.length) done(`удалены очереди: ${removed.join(', ')}`);
  }

  // 4. автообнаружение
  if (plan.has('discovery')) {
    for (const u of s.units) {
      if (u.enabled === 'not-found' || u.enabled === '') continue;
      if (u.enabled === 'masked' && !u.active) continue;
      onStep(`Отключаю ${u.unit}`);
      await sys(['systemctl', 'stop', u.unit]);
      if (u.enabled !== 'masked') {
        await sys(['systemctl', 'disable', '-q', u.unit]);
        await sys(['systemctl', 'mask', '-q', u.unit]);
      }
    }
    if (s.sharing !== 'off') {
      onStep('Выключаю общий доступ к принтерам (cupsd перезапустится)');
      await sys(['cupsctl', '--no-share-printers', '--no-remote-any']);
      await waitCups();
    }
    done('автообнаружение принтеров отключено');
  }

  // 5. сканер. У USB eSCL впервые проверен только что, после подъёма ipp-usb:
  //    не ответил — конфиг не пишем, иначе scanimage искал бы пустоту.
  if ((plan.has('airscan') || plan.has('airscan-install')) && !probe.escl) {
    plan.delete('airscan-install');
    plan.delete('airscan');
    note('сканер не настроен: аппарат не ответил по eSCL');
  }
  if (plan.has('airscan-install')) {
    onStep('Устанавливаю sane-airscan...');
    const r = await sys(['dnf', 'install', '-y', 'sane-airscan'], 600_000);
    r.ok ? done('установлен sane-airscan') : note(`sane-airscan не установлен: ${r.msg}`);
  }
  if (plan.has('airscan')) {
    const url = esclUrl(probe);
    onStep(`Сканер по eSCL: ${url}`);
    const name = `${probe.ipp?.model || 'МФУ'} (${connLabel(o.conn)})`;
    const w = await writeRoot(SANE_AIRSCAN, airscanConf(name, url));
    w.ok ? done(`сканер: ${name}`) : note(`${SANE_AIRSCAN}: ${w.msg}`);
  }

  // 6. тестовая страница — от неё зависит удаление hplip
  let printed = !o.testPage;
  if (plan.has('test-page')) {
    onStep('Тестовая страница...');
    const t = await printTestPage(o.queueName, onStep);
    res.testJob = t.job;
    printed = t.ok;
    t.ok ? done(`тестовая страница: ${t.msg} — проверьте лист в лотке`) : note(`тестовая страница: ${t.msg}`);
  }

  // 7. hplip
  const kept = hplipKept(s, o);
  if (kept) note(kept);
  if (plan.has('hplip')) {
    if (!printed) {
      note('hplip НЕ удалён: тестовая печать не прошла. Разберитесь с печатью и повторите перевод.');
    } else {
      onStep('Останавливаю hp-systray');
      await sys(['pkill', '-f', 'hp-systray']);
      onStep(`Удаляю ${s.hplip.join(' ')} (dnf)...`);
      const r = await sys(['dnf', 'remove', '-y', ...s.hplip], 600_000);
      if (r.ok) {
        done(`hplip удалён: ${s.hplip.join(', ')}`);
        try {
          for (const h of readdirSync('/home')) {
            const f = `/home/${h}/.config/autostart/hplip-systray.desktop`;
            if (readFile(f) !== null) await sys(['rm', '-f', f]);
          }
        } catch { /* нет /home */ }
      } else {
        note(`dnf remove: ${r.msg}`);
      }
    }
  }

  // 8. итог
  onStep('Проверяю результат...');
  res.after = (await lines(['lpstat', '-v'])).filter(l => l.trim());
  if (o.scanner && probe.escl) {
    res.scanners = (await lines(['scanimage', '-L'], 70_000))
      .filter(l => /^device /.test(l.trim()));
  }
  res.ok = !res.lines.some(l => l.startsWith('✗'));
  return res;
}

// ─── поиск МФУ ────────────────────────────────────────────────────────────────

export interface Candidate {
  conn:   Conn;
  label:  string;  // что показать в списке
  source: string;  // откуда известен: очередь, sysfs, airscan.conf, mDNS, CUPS
  note:   string;  // оговорка: не умеет IPP-over-USB, заблокирован политикой
}

/**
 * Куда можно перевести.
 *
 * USB-аппараты идут первыми и берутся из sysfs — они подключены прямо сейчас,
 * и это самый достоверный источник, какой вообще есть. Дальше сетевые адреса:
 * из очередей и airscan.conf (тоже надёжные), затем mDNS — если avahi ещё
 * работает — и lpinfo.
 */
export async function findCandidates(s: SystemState, onStep: (m: string) => void = () => {}): Promise<Candidate[]> {
  const out: Candidate[] = [];

  for (const u of s.usb) {
    out.push({
      conn:   { kind: 'usb', usb: u },
      label:  usbPrinterName(u),
      source: `USB ${u.port}${u.serial ? ' · ' + u.serial : ''}`,
      note:   usbBlocker(u),
    });
  }

  const seen = new Set<string>();
  const addNet = (ip: string, source: string) => {
    if (!isIpv4(ip) || seen.has(ip)) return;
    seen.add(ip);
    out.push({ conn: { kind: 'net', ip }, label: ip, source, note: '' });
  };

  for (const q of s.queues) if (q.ip) addNet(q.ip, `очередь ${q.name}`);
  if (s.airscan.ip) addNet(s.airscan.ip, 'airscan.conf');

  if (s.units.some(u => u.unit.startsWith('avahi') && u.active)) {
    onStep('Опрашиваю mDNS (avahi-browse)...');
    // =;eth0;IPv4;HP%20LaserJet;_ipp._tcp;local;printer.local;10.82.230.22;631;"txt"
    for (const svc of ['_ipp._tcp', '_uscan._tcp']) {
      for (const l of await lines(['avahi-browse', '-rtp', svc], 15_000)) {
        if (!l.startsWith('=')) continue;
        addNet(l.split(';')[7]?.trim() ?? '', 'mDNS');
      }
    }
  }

  onStep('Смотрю, что видит CUPS (lpinfo -v)...');
  for (const l of await lines(['lpinfo', '-v'], 25_000)) {
    // usb:// из lpinfo пропускаем: те же аппараты уже взяты из sysfs, где про
    // них известно больше — серийник, поддержка IPP-over-USB, блокировка.
    if (connOfUri(l.replace(/^\S+\s+/, '')) === 'usb') continue;
    addNet(ipFromUri(l), 'CUPS');
  }
  return out;
}
