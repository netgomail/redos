/**
 * Печать и сканирование: лечение «принтер отвалился» и режим «только один МФУ».
 *
 * Две задачи, обе из практики РедОС 8 с HP LaserJet MFP M426fdn:
 *
 *  1. Очередь CUPS уходит в «отключён» и сама не возвращается. При разовой
 *     ошибке бэкенда CUPS по умолчанию ставит error-policy=stop-printer,
 *     останавливает очередь и больше её не включает. Особенно часто это даёт
 *     бэкенд hplip (hp:/net/...): «open device failed stat=12», когда МФУ спит
 *     или занят. Лечится переводом очереди на драйверless IPP Everywhere
 *     и error-policy=retry-job.
 *
 *  2. В сети несколько одинаковых аппаратов, и через mDNS они все лезут в
 *     списки печати и сканирования (на каждый — ещё и по два сканера: airscan
 *     и hpaio). Пользователь выбирает не тот и «принтер не печатает».
 *     Лечится жёсткой привязкой: одна очередь на IPP по IP, один бэкенд SANE
 *     (airscan) с устройством по IP, автопоиск выключен, avahi отключён.
 *
 * Перед изменениями системных файлов делается бэкап со скриптом отката.
 */

import { readFile } from '../utils/fs';
import { sudoRun, writeSudo } from '../utils/sudo';
import type { FixResult } from '../utils/sudo';
import { runPty, runPtyLines } from '../utils/terminal';

export const SANE_DLL      = '/etc/sane.d/dll.conf';
export const SANE_AIRSCAN  = '/etc/sane.d/airscan.conf';
export const SANE_HPAIO    = '/etc/sane.d/dll.d/hpaio';
export const CUPS_LPOPTS   = '/etc/cups/lpoptions';
const HEADER_MARK = '# redos-printer: managed';

/** Локаль для разбора вывода: иначе lpstat отвечает по-русски и парсер ломается. */
const C_LOCALE = { LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };

// ─── типы ─────────────────────────────────────────────────────────────────────

export interface PrintQueue {
  name:        string;
  uri:         string;   // ipp://10.82.230.22/ipp/print
  backend:     string;   // ipp | hp | hpfax | usb | socket | dnssd
  ip:          string;   // вытащен из URI, пусто для usb:/dnssd:
  enabled:     boolean;  // очередь включена (cupsenable)
  accepting:   boolean;  // принимает задания (cupsaccept)
  stateText:   string;   // «idle», «disabled since ...»
  reason:      string;   // причина остановки, если есть
  isDefault:   boolean;
  errorPolicy: string;   // stop-printer | retry-job | ''
  jobs:        number;   // заданий в очереди
}

export interface DiscoveredMfp {
  ip:    string;
  name:  string;  // подпись из mDNS или с самого аппарата
  model: string;  // pwg:MakeAndModel из eSCL, если ответил
  escl:  boolean; // отвечает по eSCL — значит и сканер тоже он
}

export interface Diagnosis {
  queue:      PrintQueue;
  ping:       boolean | null;   // null — IP неизвестен, проверять нечего
  port631:    boolean | null;
  port9100:   boolean | null;
  escl:       boolean | null;
  journal:    string[];         // строки из журнала про остановку
  problems:   string[];         // человекочитаемые выводы
}

// ─── чтение состояния CUPS ────────────────────────────────────────────────────

function backendOf(uri: string): string {
  return uri.split(':')[0] ?? '';
}

export function ipFromUri(uri: string): string {
  return uri.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1] ?? '';
}

/** Бэкенды, которые в этой связке ненадёжны и подлежат замене на IPP. */
export function isFragileBackend(backend: string): boolean {
  return backend === 'hp' || backend === 'hpfax' || backend === 'usb';
}

export async function listQueues(): Promise<PrintQueue[]> {
  const env = C_LOCALE;

  const [vLines, pLines, dLines, oLines] = await Promise.all([
    runPtyLines(['lpstat', '-v'], { env, timeoutMs: 15_000 }),
    runPtyLines(['lpstat', '-p'], { env, timeoutMs: 15_000 }),
    runPtyLines(['lpstat', '-d'], { env, timeoutMs: 15_000 }),
    runPtyLines(['lpstat', '-o'], { env, timeoutMs: 15_000 }),
  ]);

  // device for HP_M426fdn: ipp://10.82.230.22/ipp/print
  const queues = new Map<string, PrintQueue>();
  for (const l of vLines) {
    const m = l.match(/^device for ([^:]+):\s*(.+)$/);
    if (!m) continue;
    const uri = m[2].trim();
    queues.set(m[1], {
      name: m[1], uri,
      backend: backendOf(uri),
      ip: ipFromUri(uri),
      enabled: true, accepting: true,
      stateText: '', reason: '', isDefault: false,
      errorPolicy: '', jobs: 0,
    });
  }
  if (queues.size === 0) return [];

  // printer HP_M426fdn is idle.  enabled since ...
  // printer HP_M426fdn disabled since ...  -
  //         Printer stopped due to backend errors
  let current: PrintQueue | undefined;
  for (const l of pLines) {
    const m = l.match(/^printer (\S+) (is |now )?(\S+)/);
    if (m) {
      current = queues.get(m[1]);
      if (current) {
        current.stateText = l.replace(/^printer \S+\s*/, '').trim();
        current.enabled   = !/disabled|stopped/i.test(l);
      }
      continue;
    }
    // продолжение — причина остановки с отступом
    if (current && /^\s+\S/.test(l) && !current.reason) {
      const reason = l.trim();
      if (reason && reason !== '-') current.reason = reason;
    }
  }

  const def = dLines.find(l => l.includes('default destination'))?.match(/:\s*(\S+)/)?.[1];
  if (def && queues.has(def)) queues.get(def)!.isDefault = true;

  // задания: строки вида "HP_M426fdn-12  user  1024  дата"
  for (const l of oLines) {
    const q = l.match(/^(\S+?)-\d+\s/)?.[1];
    if (q && queues.has(q)) queues.get(q)!.jobs++;
  }

  // accepting и error-policy — по каждой очереди отдельно
  await Promise.all([...queues.values()].map(async q => {
    const [acc, policy] = await Promise.all([
      runPtyLines(['lpstat', '-a', q.name], { env, timeoutMs: 10_000 }),
      readErrorPolicy(q.name),
    ]);
    q.accepting   = !acc.some(l => /not accepting/i.test(l));
    q.errorPolicy = policy;
  }));

  return [...queues.values()];
}

/**
 * printer-error-policy не показывает ни lpstat, ни всегда lpoptions,
 * поэтому пробуем оба источника: lpoptions, затем printers.conf (нужен root).
 */
async function readErrorPolicy(queue: string): Promise<string> {
  const out = await runPtyLines(['lpoptions', '-p', queue], { env: C_LOCALE, timeoutMs: 10_000 });
  const fromOpts = out.join(' ').match(/printer-error-policy=(\S+)/)?.[1];
  if (fromOpts) return fromOpts.replace(/['"]/g, '');

  const conf = readFile('/etc/cups/printers.conf');
  if (!conf) return '';
  // <Printer HP_M426fdn> ... ErrorPolicy retry-job ... </Printer>
  const block = conf.match(
    new RegExp(`<(?:Default)?Printer ${escapeRe(queue)}>([\\s\\S]*?)</(?:Default)?Printer>`),
  )?.[1];
  return block?.match(/^\s*ErrorPolicy\s+(\S+)/m)?.[1] ?? '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── диагностика ──────────────────────────────────────────────────────────────

/** TCP-проверка порта без внешних утилит. */
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

/** Спрашивает у аппарата его модель по eSCL. Заодно проверяет, что это МФУ. */
export async function probeEscl(ip: string, timeoutMs = 6000): Promise<{ ok: boolean; model: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(`http://${ip}/eSCL/ScannerCapabilities`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, model: '' };
    const xml = await resp.text();
    const model = xml.match(/<pwg:MakeAndModel>([^<]*)</)?.[1]?.trim() ?? '';
    return { ok: true, model };
  } catch {
    return { ok: false, model: '' };
  }
}

/** Почему очередь встала: сеть, порты, записи в журнале cups. */
export async function diagnose(queue: PrintQueue): Promise<Diagnosis> {
  const ip = queue.ip;
  const [ping, journal] = await Promise.all([
    ip ? pingHost(ip) : Promise.resolve(null),
    readCupsJournal(),
  ]);

  let port631: boolean | null = null;
  let port9100: boolean | null = null;
  let escl: boolean | null = null;
  if (ip && ping) {
    [port631, port9100, { ok: escl }] = await Promise.all([
      checkPort(ip, 631),
      checkPort(ip, 9100),
      probeEscl(ip),
    ]);
  }

  const problems: string[] = [];
  if (!queue.enabled)
    problems.push(`очередь отключена${queue.reason ? ': ' + queue.reason : ''}`);
  if (!queue.accepting)
    problems.push('очередь не принимает задания');
  if (queue.errorPolicy && queue.errorPolicy !== 'retry-job')
    problems.push(`error-policy=${queue.errorPolicy} — при первой же ошибке CUPS снова остановит очередь`);
  if (isFragileBackend(queue.backend))
    problems.push(`бэкенд ${queue.backend}: ненадёжен, аппарат «засыпает» и очередь встаёт`);
  if (!ip && queue.backend !== 'usb')
    problems.push('в URI очереди нет IP — адрес аппарата неизвестен');
  if (ping === false)
    problems.push(`${ip} не отвечает на ping — аппарат выключен или проблема в сети`);
  if (ping && port631 === false)
    problems.push('порт 631 (IPP) закрыт — печать по IPP работать не будет');
  if (queue.jobs > 0)
    problems.push(`в очереди застряло заданий: ${queue.jobs}`);

  return { queue, ping, port631, port9100, escl, journal, problems };
}

async function readCupsJournal(): Promise<string[]> {
  const lines = await runPtyLines(
    ['journalctl', '-u', 'cups', '--since', '-30 days', '--no-pager'],
    { env: C_LOCALE, timeoutMs: 20_000 },
  );
  return lines
    .filter(l => /stopped due to|open device failed|returned status 1|Unable to (open|connect)/i.test(l))
    .slice(-5);
}

// ─── лечение очереди ──────────────────────────────────────────────────────────

export interface FixOptions {
  /** Переключить очередь на ipp://IP/ipp/print. Пусто — оставить URI как есть. */
  ip?:       string;
  testPage?: boolean;
  onStep?:   (msg: string) => void;
}

/**
 * Приводит очередь в рабочее состояние: сетевой IPP вместо hplip/usb,
 * error-policy=retry-job, включение, приём заданий, снятие застрявших.
 * Повторяет логику fix-printer.sh.
 */
export async function fixQueue(queue: PrintQueue, opts: FixOptions = {}): Promise<FixResult> {
  const step = opts.onStep ?? (() => {});
  const ip   = opts.ip?.trim() || queue.ip;
  const done: string[] = [];

  if (isFragileBackend(queue.backend)) {
    if (!ip) {
      return {
        ok: false,
        msg: `Очередь на бэкенде ${queue.backend}, но IP аппарата неизвестен — укажите его вручную.`,
      };
    }
    step(`Перевожу очередь с ${queue.backend} на ipp://${ip}/ipp/print`);
    const r = sudoRun(['lpadmin', '-p', queue.name, '-E',
                       '-v', `ipp://${ip}/ipp/print`, '-m', 'everywhere', '-L', ip]);
    if (!r.ok) return { ok: false, msg: `lpadmin: ${r.msg}` };
    done.push('бэкенд переведён на IPP Everywhere');
  } else {
    step('Бэкенд уже сетевой — менять не нужно');
  }

  // Ключевое: не выключать очередь из-за разовой ошибки
  step('Ставлю error-policy=retry-job');
  const rp = sudoRun(['lpadmin', '-p', queue.name, '-o', 'printer-error-policy=retry-job']);
  if (!rp.ok) return { ok: false, msg: `lpadmin -o error-policy: ${rp.msg}` };
  done.push('error-policy=retry-job');

  step('Включаю очередь и приём заданий');
  if (sudoRun(['cupsenable', queue.name]).ok) done.push('очередь включена');
  if (sudoRun(['cupsaccept', queue.name]).ok) done.push('приём заданий разрешён');

  if (queue.jobs > 0) {
    step(`Снимаю застрявшие задания (${queue.jobs})`);
    sudoRun(['cancel', '-a', queue.name]);
    done.push(`снято заданий: ${queue.jobs}`);
  }

  if (opts.testPage) {
    step('Отправляю тестовую страницу');
    const text = `Тест печати redos — ${new Date().toLocaleString('ru-RU')}\n`;
    const r = await runPty(['lp', '-d', queue.name], { input: text, timeoutMs: 20_000, env: C_LOCALE });
    done.push(r.code === 0 ? 'тестовая страница отправлена' : 'тестовую страницу отправить не удалось');
  }

  return { ok: true, msg: done.join('; ') };
}

// ─── обнаружение МФУ в сети ───────────────────────────────────────────────────

/**
 * Ищет сетевые МФУ: сначала mDNS (avahi-browse), затем то, что уже знает CUPS
 * (lpinfo -v). Найденные адреса опрашиваются по eSCL, чтобы получить модель
 * и понять, что это МФУ со сканером.
 */
export async function discoverMfp(onStep?: (m: string) => void): Promise<DiscoveredMfp[]> {
  const step = onStep ?? (() => {});
  const byIp = new Map<string, { name: string }>();

  step('Опрашиваю mDNS (avahi-browse)...');
  // =;wlan0;IPv4;HP%20LaserJet;_ipp._tcp;local;printer.local;10.82.230.22;631;"txt"
  for (const svc of ['_ipp._tcp', '_uscan._tcp']) {
    const lines = await runPtyLines(['avahi-browse', '-rtp', svc], { timeoutMs: 15_000, env: C_LOCALE });
    for (const l of lines) {
      if (!l.startsWith('=')) continue;
      const f = l.split(';');
      const ip = f[7]?.trim();
      if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
      const name = decodeURIComponent((f[3] ?? '').replace(/\\(\d{3})/g, (_, d) =>
        String.fromCharCode(parseInt(d, 10))));
      if (!byIp.has(ip)) byIp.set(ip, { name: name || ip });
    }
  }

  step('Смотрю, что видит CUPS (lpinfo -v)...');
  const lp = await runPtyLines(['lpinfo', '-v'], { timeoutMs: 25_000, env: C_LOCALE });
  for (const l of lp) {
    const ip = ipFromUri(l);
    if (ip && !byIp.has(ip)) byIp.set(ip, { name: ip });
  }

  const ips = [...byIp.keys()];
  if (ips.length === 0) return [];

  step(`Опрашиваю найденные аппараты по eSCL (${ips.length})...`);
  const result = await Promise.all(ips.map(async ip => {
    const { ok, model } = await probeEscl(ip, 5000);
    const base = byIp.get(ip)!;
    return { ip, name: model || base.name, model, escl: ok };
  }));

  // Сначала те, что ответили по eSCL, — это настоящие МФУ.
  return result.sort((a, b) => Number(b.escl) - Number(a.escl) || a.ip.localeCompare(b.ip));
}

// ─── режим «только один МФУ» ──────────────────────────────────────────────────

export interface SetupOptions {
  ip:          string;
  /** Имя очереди CUPS. Пусто — берётся существующая с этим IP, иначе HP_MFP. */
  queueName?:  string;
  /** Подпись сканера. Пусто — спрашивается у аппарата по eSCL. */
  scannerName?: string;
  /** Не отключать avahi. Тогда чужие аппараты останутся видны в mDNS. */
  keepAvahi?:  boolean;
  onStep?:     (msg: string) => void;
}

export interface SetupResult extends FixResult {
  backupDir?: string;
  /** Что осталось в системе после настройки — для показа пользователю. */
  queues?:    string[];
  scanners?:  string[];
}

/**
 * Оставляет в системе ровно один принтер и один сканер — указанный МФУ.
 * Печать по IPP Everywhere, сканирование по eSCL/AirScan, автопоиск выключен.
 * Повторяет setup-mfp-only.sh, но с бэкапом через утилиту и понятными шагами.
 */
export async function setupSingleMfp(opts: SetupOptions): Promise<SetupResult> {
  const step = opts.onStep ?? (() => {});
  const ip   = opts.ip.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return { ok: false, msg: `«${ip}» не похож на IP-адрес` };
  }

  // 1. Проверка доступности — дальше идти бессмысленно
  step(`Проверяю доступность ${ip}...`);
  if (!await pingHost(ip)) {
    return { ok: false, msg: `${ip} не отвечает на ping. Включите МФУ и повторите.` };
  }
  const escl = await probeEscl(ip);
  step(escl.ok
    ? `eSCL отвечает${escl.model ? ': ' + escl.model : ''}`
    : 'eSCL не отвечает — сканирование по AirScan может не заработать');

  const existing = await listQueues();
  const queueName = opts.queueName?.trim()
    || existing.find(q => q.ip === ip)?.name
    || 'HP_MFP';
  const scannerName = opts.scannerName?.trim()
    || `${escl.model || 'Сетевой МФУ'} (${ip})`;

  // 2. Бэкап
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const backupDir = `/root/redos-mfp-backup-${stamp}`;
  step(`Бэкап в ${backupDir}`);
  const mk = sudoRun(['mkdir', '-p', backupDir]);
  if (!mk.ok) return { ok: false, msg: `не удалось создать ${backupDir}: ${mk.msg}` };
  for (const f of [SANE_DLL, SANE_AIRSCAN, CUPS_LPOPTS, SANE_HPAIO]) {
    sudoRun(['cp', '-a', f, backupDir + '/']); // отсутствие файла — не ошибка
  }
  sudoRun(['cp', '-a', '/etc/sane.d/dll.d', backupDir + '/dll.d']);

  // 3. Очередь печати на IPP Everywhere
  step(`Очередь ${queueName} → ipp://${ip}/ipp/print`);
  const la = sudoRun(['lpadmin', '-p', queueName, '-E',
                      '-v', `ipp://${ip}/ipp/print`, '-m', 'everywhere',
                      '-L', ip, '-o', 'printer-error-policy=retry-job']);
  if (!la.ok) return { ok: false, msg: `lpadmin: ${la.msg}`, backupDir };
  sudoRun(['cupsenable', queueName]);
  sudoRun(['cupsaccept', queueName]);

  // очередь по умолчанию
  const lpopts = readFile(CUPS_LPOPTS) ?? '';
  if (!new RegExp(`^Default ${escapeRe(queueName)}\\b`, 'm').test(lpopts)) {
    const next = lpopts.replace(/^Default .*$/gm, '').trimEnd();
    writeSudo(CUPS_LPOPTS, (next ? next + '\n' : '') + `Default ${queueName}\n`);
  }

  // 4. Лишние очереди — под нож, иначе в списках снова пять одинаковых аппаратов
  const removed: string[] = [];
  for (const q of existing) {
    if (q.name === queueName) continue;
    step(`Удаляю лишнюю очередь ${q.name}`);
    if (sudoRun(['lpadmin', '-x', q.name]).ok) removed.push(q.name);
  }

  // 5. SANE: единственный бэкенд airscan
  step('SANE: оставляю только бэкенд airscan');
  const dll = writeSudo(SANE_DLL, [
    HEADER_MARK,
    '# Используется единственный сетевой сканер по eSCL (sane-airscan).',
    '# Остальные бэкенды отключены намеренно, чтобы в списке не появлялись',
    `# посторонние аппараты. Оригинал — в ${backupDir}.`,
    'airscan',
    '',
  ].join('\n'));
  if (!dll.ok) return { ok: false, msg: `${SANE_DLL}: ${dll.msg}`, backupDir };

  // hpaio дублирует тот же МФУ и подтягивает чужие
  if (readFile(SANE_HPAIO) !== null) {
    step('Отключаю бэкенд hpaio (дублирует тот же аппарат)');
    sudoRun(['mv', '-f', SANE_HPAIO, SANE_HPAIO + '.disabled']);
  }

  // 6. airscan: автопоиск выключен, устройство задано по IP
  step('sane-airscan: автопоиск выключен, устройство задано по IP');
  const air = writeSudo(SANE_AIRSCAN, [
    HEADER_MARK,
    '# Автопоиск отключён: в сети несколько одинаковых МФУ, они путали список.',
    '',
    '[options]',
    'discovery = disable',
    '',
    '[devices]',
    `"${scannerName}" = http://${ip}/eSCL/, eSCL`,
    '',
  ].join('\n'));
  if (!air.ok) return { ok: false, msg: `${SANE_AIRSCAN}: ${air.msg}`, backupDir };

  // 7. mDNS
  if (opts.keepAvahi) {
    step('avahi оставлен включённым — чужие аппараты будут видны');
  } else {
    step('Отключаю mDNS-обнаружение (avahi)');
    sudoRun(['systemctl', 'disable', '--now', 'avahi-daemon.socket', 'avahi-daemon.service']);
    sudoRun(['systemctl', 'mask',    'avahi-daemon.socket', 'avahi-daemon.service']);
  }

  // 8. Скрипт отката рядом с бэкапом
  writeSudo(`${backupDir}/rollback.sh`, rollbackScript(backupDir, opts.keepAvahi ?? false));
  sudoRun(['chmod', '+x', `${backupDir}/rollback.sh`]);

  step('Перезапускаю cups');
  sudoRun(['systemctl', 'restart', 'cups']);

  // 9. Проверка результата
  step('Проверяю, что осталось в системе...');
  const queuesAfter = (await runPtyLines(['lpstat', '-e'], { env: C_LOCALE, timeoutMs: 15_000 }))
    .filter(l => l.trim());
  const scannersAfter = (await runPtyLines(
    ['scanimage', '-L'],
    { timeoutMs: 70_000, env: { ...C_LOCALE, SANE_CONFIG_DIR: '' } },
  )).filter(l => l.trim());

  const tail = removed.length ? `, удалено лишних очередей: ${removed.length}` : '';
  return {
    ok: true,
    msg: `Оставлен один МФУ ${ip} (очередь ${queueName})${tail}. Откат: ${backupDir}/rollback.sh`,
    backupDir,
    queues:   queuesAfter,
    scanners: scannersAfter,
  };
}

function rollbackScript(backupDir: string, keptAvahi: boolean): string {
  return [
    '#!/usr/bin/env bash',
    '# Откат режима «только один МФУ», созданного утилитой redos.',
    'set -e',
    `BK="${backupDir}"`,
    `[ -f "$BK/dll.conf" ]     && cp -a "$BK/dll.conf"     ${SANE_DLL}`,
    `[ -f "$BK/airscan.conf" ] && cp -a "$BK/airscan.conf" ${SANE_AIRSCAN}`,
    `[ -f "$BK/lpoptions" ]    && cp -a "$BK/lpoptions"    ${CUPS_LPOPTS} || rm -f ${CUPS_LPOPTS}`,
    '[ -d "$BK/dll.d" ] && { rm -rf /etc/sane.d/dll.d; cp -a "$BK/dll.d" /etc/sane.d/dll.d; }',
    ...(keptAvahi ? [] : [
      'systemctl unmask avahi-daemon.socket avahi-daemon.service || true',
      'systemctl enable --now avahi-daemon.socket avahi-daemon.service || true',
    ]),
    'systemctl restart cups',
    'echo "Откат выполнен. Удалённые очереди печати восстановите вручную."',
    '',
  ].join('\n');
}

// ─── состояние режима «только один МФУ» ──────────────────────────────────────

export interface SingleMfpState {
  active:      boolean;  // конфиги SANE управляются нами (есть наш маркер)
  /**
   * IP сканера из airscan.conf — независимо от того, кто его туда записал.
   * Нужен, чтобы подставить адрес по умолчанию в форму, когда режим ещё
   * не включён, но сканер в системе уже настроен вручную.
   */
  scannerIp:   string;
  avahiMasked: boolean;
}

export async function readSingleMfpState(): Promise<SingleMfpState> {
  const air = readFile(SANE_AIRSCAN) ?? '';
  const dll = readFile(SANE_DLL) ?? '';
  const active = air.includes(HEADER_MARK) && dll.includes(HEADER_MARK);

  const avahi = await runPtyLines(['systemctl', 'is-enabled', 'avahi-daemon.service'],
                                  { env: C_LOCALE, timeoutMs: 8000 });
  return {
    active,
    scannerIp:   ipFromUri(air),
    avahiMasked: avahi.some(l => l.trim() === 'masked'),
  };
}
