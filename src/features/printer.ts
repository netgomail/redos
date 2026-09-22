/**
 * Печать и сканирование: перевод сетевых МФУ HP (M426 и подобных) с hplip
 * на driverless — IPP Everywhere для печати и eSCL (sane-airscan) для
 * сканирования.
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
 * Порядок перевода важен: hplip удаляется последним и только после того, как
 * тестовая страница через новую очередь прошла. Перед изменениями — бэкап
 * /etc/cups и /etc/sane.d со скриптом отката.
 */

import { readdirSync } from 'fs';
import { readFile } from '../utils/fs';
import { isRoot } from '../utils/sudo';
import type { FixResult } from '../utils/sudo';
import { runPty, runPtyLines, stripAnsi } from '../utils/terminal';
import { getPrinterAttributes, summarize, blockingReasons } from './ipp';
import type { PrinterInfo } from './ipp';

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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── очереди CUPS ─────────────────────────────────────────────────────────────

export interface PrintQueue {
  name:        string;
  uri:         string;   // ipp://10.82.230.207/ipp/print
  backend:     string;   // ipp | hp | hpfax | usb | socket | dnssd
  ip:          string;   // из URI, пусто для usb:/dnssd:
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

/** Очередь уже переведена: IPP по IP и retry-job. */
export function isDriverless(q: PrintQueue): boolean {
  return (q.backend === 'ipp' || q.backend === 'ipps') && q.ip !== '';
}

/** Разбор lpstat -v/-p/-d/-o (под LC_ALL=C). Без побочных эффектов — для тестов. */
export function parseQueues(v: string[], p: string[], d: string[], o: string[]): PrintQueue[] {
  const queues = new Map<string, PrintQueue>();
  for (const l of v) {
    const m = l.match(/^device for ([^:]+):\s*(.+)$/);
    if (!m) continue;
    const uri = m[2].trim();
    queues.set(m[1], {
      name: m[1], uri,
      backend: uri.split(':')[0] ?? '',
      ip: ipFromUri(uri),
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
  const [v, p, d, o] = await Promise.all([
    lines(['lpstat', '-v']), lines(['lpstat', '-p']),
    lines(['lpstat', '-d']), lines(['lpstat', '-o']),
  ]);
  const queues = parseQueues(v, p, d, o);
  const conf = readFile('/etc/cups/printers.conf') ?? '';
  await Promise.all(queues.map(async q => {
    const acc = await lines(['lpstat', '-a', q.name], 10_000);
    q.accepting   = !acc.some(l => /not accepting/i.test(l));
    q.errorPolicy = errorPolicyFrom(conf, q.name);
  }));
  return queues;
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
  ip:                string;   // IP устройства eSCL
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
}

/** Автообнаружение выключено: все службы замаскированы/отсутствуют и не работают. */
export function discoveryHidden(s: SystemState): boolean {
  return s.units.every(u => (u.enabled === 'masked' || u.enabled === 'not-found' || u.enabled === '') && !u.active);
}

export function parseAirscanConf(text: string): AirscanConf {
  let section = '';
  let ip = '';
  let discoveryDisabled = false;
  for (const raw of text.split('\n')) {
    const l = raw.replace(/[;#].*$/, '').trim();
    if (!l) continue;
    const sec = l.match(/^\[(\w+)\]$/);
    if (sec) { section = sec[1].toLowerCase(); continue; }
    if (section === 'options' && /^discovery\s*=\s*disable$/i.test(l)) discoveryDisabled = true;
    if (section === 'devices' && !ip && /eSCL/i.test(l)) ip = ipFromUri(l);
  }
  return { ip, discoveryDisabled, managed: text.includes(HEADER_MARK) };
}

export function airscanConf(scannerName: string, ip: string): string {
  return [
    HEADER_MARK,
    '# Сканер задан по IP, автопоиск выключен: в сети несколько одинаковых МФУ.',
    '',
    '[devices]',
    `"${scannerName.replace(/"/g, "'")}" = http://${ip}/eSCL/, eSCL`,
    '',
    '[options]',
    'discovery = disable',
    '',
  ].join('\n');
}

export async function readSystemState(): Promise<SystemState> {
  const [queues, rpm, systray, cupsctl, airscanPkg, ...unitInfo] = await Promise.all([
    listQueues(),
    lines(['rpm', '-qa', '--qf', '%{NAME}\\n', 'hplip*', 'libsane-hpaio*']),
    runPty(['pgrep', '-f', 'hp-systray'], { timeoutMs: 5000 }),
    lines(['cupsctl'], 10_000),
    runPty(['rpm', '-q', 'sane-airscan'], { timeoutMs: 10_000 }),
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
  };
}

// ─── проверка аппарата ────────────────────────────────────────────────────────

export interface PrinterProbe {
  ip:      string;
  ping:    boolean;
  port631: boolean;
  escl:    boolean;
  ipp:     PrinterInfo | null;
  ippError: string;
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

/** eSCL по http: https к МФУ перехватывает антивирус. */
export async function probeEscl(ip: string, timeoutMs = 6000): Promise<{ ok: boolean; model: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(`http://${ip}/eSCL/ScannerCapabilities`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, model: '' };
    const xml = await resp.text();
    return { ok: true, model: xml.match(/<pwg:MakeAndModel>([^<]*)</)?.[1]?.trim() ?? '' };
  } catch {
    return { ok: false, model: '' };
  }
}

export async function probePrinter(ip: string): Promise<PrinterProbe> {
  const res: PrinterProbe = { ip, ping: false, port631: false, escl: false, ipp: null, ippError: '' };
  res.ping = await pingHost(ip);
  if (!res.ping) return res;
  const [p631, escl] = await Promise.all([checkPort(ip, 631), probeEscl(ip)]);
  res.port631 = p631;
  res.escl = escl.ok;
  if (p631) {
    try {
      const r = await getPrinterAttributes(ip);
      if (r.status >= 0x0100) res.ippError = `IPP status 0x${r.status.toString(16).padStart(4, '0')}`;
      else res.ipp = summarize(r.attrs);
    } catch (e) {
      res.ippError = (e as Error).message;
    }
  }
  return res;
}

/** Почему перевод на этот IP невозможен; пустая строка — можно. */
export function migrationBlocker(p: PrinterProbe): string {
  if (!p.ping)    return `${p.ip} не отвечает на ping — МФУ выключен или недоступен по сети`;
  if (!p.port631) return `порт 631 (IPP) на ${p.ip} закрыт — включите IPP в веб-интерфейсе МФУ`;
  if (!p.ipp)     return `МФУ не ответил по IPP${p.ippError ? ': ' + p.ippError : ''}`;
  if (!p.ipp.everywhere)
    return 'МФУ не сообщает поддержку PWG-raster/URF — IPP Everywhere невозможен';
  return '';
}

// ─── диагностика ──────────────────────────────────────────────────────────────

export interface Diagnosis {
  queue:    PrintQueue;
  probe:    PrinterProbe | null;  // null — в URI нет IP
  journal:  string[];
  problems: string[];
  /** Рекомендуемое действие. */
  advice:   'migrate' | 'restore' | 'printer' | 'none';
}

/** Строки журнала cups, которые объясняют остановку очереди. */
export function filterCupsJournal(journal: string[]): string[] {
  return journal
    .filter(l => /stopped due to|open device failed|unable to read device-id|returned status [1-9]|Unable to (open|connect)|Backend \S+ returned/i.test(l))
    .slice(-6);
}

export function analyze(queue: PrintQueue, probe: PrinterProbe | null, journal: string[]): Diagnosis {
  const problems: string[] = [];
  const hplipFail = journal.some(l => /open device failed|unable to read device-id/i.test(l));

  if (!queue.enabled)   problems.push(`очередь остановлена${queue.reason ? ': ' + queue.reason : ''}`);
  if (!queue.accepting) problems.push('очередь не принимает задания');
  if (isHplipBackend(queue.backend))
    problems.push(`бэкенд ${queue.backend} (hplip): перед каждым заданием читает device-id по SNMP, ` +
                  'спящий МФУ даёт «open device failed» и остановку очереди');
  if (hplipFail)
    problems.push('в журнале cups есть сбои hplip (open device failed / unable to read device-id)');
  if (queue.errorPolicy && queue.errorPolicy !== 'retry-job')
    problems.push(`error-policy=${queue.errorPolicy} — первая же ошибка снова остановит очередь`);
  if (queue.jobs > 0) problems.push(`в очереди заданий: ${queue.jobs}`);
  if (!queue.ip && queue.backend !== 'usb') problems.push('в URI очереди нет IP — адрес МФУ неизвестен');

  let printerBad = false;
  if (probe) {
    const block = migrationBlocker(probe);
    if (block) { problems.push(block); printerBad = !probe.ping || !probe.port631; }
    const reasons = probe.ipp ? blockingReasons(probe.ipp.reasons) : [];
    if (reasons.length) { problems.push(`МФУ сообщает: ${reasons.join(', ')}`); printerBad = true; }
    if (probe.ipp?.state === 'stopped') { problems.push('МФУ в состоянии stopped'); printerBad = true; }
  }

  const advice: Diagnosis['advice'] =
      printerBad ? 'printer'
    : !isDriverless(queue) || (queue.errorPolicy && queue.errorPolicy !== 'retry-job') ? 'migrate'
    : !queue.enabled || !queue.accepting || queue.jobs > 0 ? 'restore'
    : 'none';

  return { queue, probe, journal, problems, advice };
}

export async function diagnose(queue: PrintQueue): Promise<Diagnosis> {
  const [probe, journal] = await Promise.all([
    queue.ip ? probePrinter(queue.ip) : Promise.resolve(null),
    lines(['journalctl', '-u', 'cups', '--since', '-30 days', '--no-pager'], 20_000),
  ]);
  return analyze(queue, probe, filterCupsJournal(journal));
}

// ─── восстановление остановленной очереди ────────────────────────────────────

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

// ─── перевод на driverless: план ─────────────────────────────────────────────

export interface MigrateOptions {
  ip:           string;
  queueName:    string;
  testPage:     boolean;   // тестовая страница перед удалением hplip
  removeHplip:  boolean;
  hideDiscovery: boolean;  // cups-browsed, avahi, общий доступ CUPS
  scanner:      boolean;   // sane-airscan по IP
  /** Удалить и прочие очереди (не hplip и не на этот IP). */
  removeOthers: boolean;
}

export type StepId =
  | 'backup' | 'queue' | 'remove-queues' | 'discovery'
  | 'airscan-install' | 'airscan' | 'test-page' | 'hplip';

export interface PlanStep {
  id:     StepId;
  title:  string;
  detail: string[];
  danger: boolean;   // необратимо без отката
}

/** Имя очереди по умолчанию: сохраняем то, к которому привыкли пользователи. */
export function defaultQueueName(queues: PrintQueue[], ip: string): string {
  const onIp = queues.filter(q => q.ip === ip);
  const pick = onIp.find(q => q.isDefault && isDriverless(q))
    ?? onIp.find(q => isDriverless(q))
    ?? onIp.find(q => q.isDefault)
    ?? onIp[0];
  return pick?.name ?? `HP_MFP_${ip.split('.').pop()}`;
}

/** Очереди, которые будут удалены: hplip, прочие на этот IP и (по выбору) все остальные. */
export function queuesToRemove(queues: PrintQueue[], opts: Pick<MigrateOptions, 'ip' | 'queueName' | 'removeOthers'>): PrintQueue[] {
  return queues.filter(q => q.name !== opts.queueName
    && (isHplipBackend(q.backend) || q.ip === opts.ip || opts.removeOthers));
}

export function planMigration(s: SystemState, o: MigrateOptions): PlanStep[] {
  const uri = `ipp://${o.ip}/ipp/print`;
  const steps: PlanStep[] = [];

  steps.push({ id: 'backup', danger: false, title: 'Бэкап /etc/cups, /etc/sane.d и lpoptions пользователей',
    detail: ['/root/redos-printer-backup-<дата>/ с rollback.sh'] });

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
    ];
    if (detail.length) steps.push({ id: 'discovery', danger: false,
      title: 'Отключить автообнаружение принтеров', detail });
  }

  if (o.scanner) {
    if (!s.saneAirscan) steps.push({ id: 'airscan-install', danger: false,
      title: 'Установить sane-airscan', detail: ['dnf install -y sane-airscan'] });
    if (s.airscan.ip !== o.ip || !s.airscan.discoveryDisabled) steps.push({ id: 'airscan', danger: false,
      title: `Сканер: ${SANE_AIRSCAN}`, detail: [`http://${o.ip}/eSCL/, автопоиск выключен`] });
  }

  if (o.testPage) steps.push({ id: 'test-page', danger: false,
    title: 'Тестовая страница через новую очередь',
    detail: ['ждать завершения до 2 минут; при неудаче hplip не удаляется'] });

  if (o.removeHplip && s.hplip.length) steps.push({ id: 'hplip', danger: true,
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

export async function migrate(
  s: SystemState, o: MigrateOptions, probe: PrinterProbe, onStep: (m: string) => void = () => {},
): Promise<MigrateResult> {
  const res: MigrateResult = { ok: false, lines: [], backupDir: '', testJob: '', after: [], scanners: [] };
  const done = (m: string) => res.lines.push('✓ ' + m);
  const fail = (m: string) => { res.lines.push('✗ ' + m); return res; };
  const note = (m: string) => res.lines.push('• ' + m);

  const block = migrationBlocker(probe);
  if (block) return fail(block);
  const plan = new Set(planMigration(s, o).map(p => p.id));
  const uri = `ipp://${o.ip}/ipp/print`;

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

  // 2. очередь
  onStep(`Очередь ${o.queueName} → ${uri} (lpadmin опрашивает МФУ)...`);
  const la = await sys(['lpadmin', '-p', o.queueName, '-E', '-v', uri, '-m', 'everywhere',
    '-L', o.ip,
    '-o', 'printer-error-policy=retry-job',
    '-o', 'sides-default=one-sided',
    '-o', 'Duplex=None'], 90_000);
  if (!la.ok) return fail(`lpadmin: ${la.msg}`);
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

  // 5. сканер
  if (plan.has('airscan-install')) {
    onStep('Устанавливаю sane-airscan...');
    const r = await sys(['dnf', 'install', '-y', 'sane-airscan'], 600_000);
    r.ok ? done('установлен sane-airscan') : note(`sane-airscan не установлен: ${r.msg}`);
  }
  if (plan.has('airscan')) {
    onStep(`Сканер по eSCL: ${o.ip}`);
    const name = `${probe.ipp?.model || 'Сетевой МФУ'} (${o.ip})`;
    const w = await writeRoot(SANE_AIRSCAN, airscanConf(name, o.ip));
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
  if (o.scanner) {
    res.scanners = (await lines(['scanimage', '-L'], 70_000))
      .filter(l => /^device /.test(l.trim()));
  }
  res.ok = !res.lines.some(l => l.startsWith('✗'));
  return res;
}

// ─── поиск МФУ ────────────────────────────────────────────────────────────────

export interface Candidate {
  ip:     string;
  source: string;  // откуда известен: очередь, airscan.conf, mDNS, CUPS
}

/**
 * Адреса, на которые можно перевести: из очередей и airscan.conf (самые
 * надёжные), затем mDNS — если avahi ещё работает — и lpinfo.
 */
export async function findCandidates(s: SystemState, onStep: (m: string) => void = () => {}): Promise<Candidate[]> {
  const out = new Map<string, string>();
  for (const q of s.queues) if (q.ip && !out.has(q.ip)) out.set(q.ip, `очередь ${q.name}`);
  if (s.airscan.ip && !out.has(s.airscan.ip)) out.set(s.airscan.ip, 'airscan.conf');

  if (s.units.some(u => u.unit.startsWith('avahi') && u.active)) {
    onStep('Опрашиваю mDNS (avahi-browse)...');
    // =;eth0;IPv4;HP%20LaserJet;_ipp._tcp;local;printer.local;10.82.230.22;631;"txt"
    for (const svc of ['_ipp._tcp', '_uscan._tcp']) {
      for (const l of await lines(['avahi-browse', '-rtp', svc], 15_000)) {
        if (!l.startsWith('=')) continue;
        const ip = l.split(';')[7]?.trim() ?? '';
        if (isIpv4(ip) && !out.has(ip)) out.set(ip, 'mDNS');
      }
    }
  }

  onStep('Смотрю, что видит CUPS (lpinfo -v)...');
  for (const l of await lines(['lpinfo', '-v'], 25_000)) {
    const ip = ipFromUri(l);
    if (ip && !out.has(ip)) out.set(ip, 'CUPS');
  }
  return [...out].map(([ip, source]) => ({ ip, source }));
}
