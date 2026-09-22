import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Spinner } from './Spinner';
import {
  readSystemState, diagnose, restoreQueue, clearQueue, closeQueue,
  findCandidates, probePrinter, planMigration, migrate, migrationBlocker,
  defaultQueueName, discoveryHidden, isHplipBackend, isDriverless, isIpv4,
  connLabel, connKey, connOfQueue, hplipKept, duplicateJobs, queueNameError,
  scannerPossible, suggestRemoveHplip,
} from '../features/printer';
import { usbPrinterName } from '../features/usbPrinter';
import type {
  SystemState, PrintQueue, Diagnosis, Candidate, PrinterProbe, Conn,
  MigrateOptions, MigrateResult,
} from '../features/printer';

interface Props {
  onExit: () => void;
}

type Phase =
  | 'loading'    // читаем состояние системы
  | 'view'       // очереди, состояние, действия
  | 'diagnosis'  // отчёт диагностики
  | 'pick'       // выбор МФУ для перевода
  | 'probing'    // опрос выбранного МФУ
  | 'name'       // имя принтера: подставлено по умолчанию, Enter — оставить
  | 'options'    // что будет сделано + переключатели, D — применить
  | 'running'    // живой лог шагов
  | 'result';

type ActionId = 'diagnose' | 'migrate' | 'restore' | 'clear' | 'close' | 'refresh';

interface Action {
  id:    ActionId;
  title: string;
  hint:  string;
  needsQueue: boolean;
}

const ACTIONS: Action[] = [
  { id: 'diagnose', needsQueue: true,  title: 'Диагностика очереди',
    hint: 'очередь, состояние МФУ по IPP (ошибки, тонер), сеть, сбои hplip в журнале cups' },
  { id: 'migrate',  needsQueue: false, title: 'Перевести на driverless (IPP Everywhere)...',
    hint: 'очередь по IPP без hplip (сеть — по IP, USB — через ipp-usb), retry-job, ' +
          'сканер по eSCL, тестовая печать, удаление hplip' },
  { id: 'restore',  needsQueue: true,  title: 'Включить остановленную очередь',
    hint: 'cupsenable, cupsaccept, retry-job, снять застрявшие задания — бэкенд не меняется' },
  { id: 'clear',    needsQueue: true,  title: 'Очистить очередь',
    hint: 'cancel -a: снять все задания, ничего больше не менять' },
  { id: 'close',    needsQueue: true,  title: 'Закрыть очередь (принтер в ремонте)',
    hint: 'cupsreject и снять задания: пользователь получает отказ сразу и перестаёт ' +
          'досылать копии одного документа' },
  { id: 'refresh',  needsQueue: false, title: 'Обновить',
    hint: 'перечитать состояние' },
];

type OptKey = 'testPage' | 'removeHplip' | 'hideDiscovery' | 'scanner' | 'removeOthers';

const OPT_TITLES: Record<OptKey, string> = {
  testPage:      'тестовая страница перед удалением hplip',
  removeHplip:   'удалить hplip',
  hideDiscovery: 'отключить автообнаружение (cups-browsed, avahi, общий доступ)',
  scanner:       'сканер по eSCL (sane-airscan по адресу, без автопоиска)',
  removeOthers:  'удалить и все остальные очереди',
};
const OPT_KEYS = Object.keys(OPT_TITLES) as OptKey[];

/**
 * Строки экрана параметров: имя очереди и переключатели.
 *
 * Имя стоит первым и редактируется: под ним печатают, его видят в списке
 * принтеров, и менять его после перевода — значит заново объяснять это всем
 * пользователям. Подставляется прежнее, но слово остаётся за администратором.
 */
const OPT_ROWS = ['name', ...OPT_KEYS] as const;
type OptRow = typeof OPT_ROWS[number];

interface ResultView { ok: boolean; title: string; lines: string[] }

/**
 * Буква команды в русской раскладке: администратор часто набирает с ней, и
 * «D применить» молча не срабатывало бы, пока не переключишь язык.
 */
const RU_KEY: Record<string, string> = { d: 'в', q: 'й' };

export function PrinterScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  // Экран выше окна терминала Ink перерисовывает с мусором и дублями строк,
  // поэтому длинные списки режутся по высоте, а результат прокручивается.
  const rows = stdout?.rows ?? 40;
  // рамка (3), заголовок результата (2), подсказка (2) и запас на перенос
  const resultRows = Math.max(5, rows - 9);

  const [phase, setPhase] = useState<Phase>('loading');
  const [sys, setSys] = useState<SystemState | null>(null);
  const queues = sys?.queues ?? [];

  const [queueIdx,  setQueueIdx]  = useState(0);
  const [actionIdx, setActionIdx] = useState(0);
  const [focus, setFocus] = useState<'queues' | 'actions'>('actions');

  const [diag, setDiag] = useState<Diagnosis | null>(null);

  // выбор МФУ
  const [cands, setCands] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [candIdx, setCandIdx] = useState(0);
  const [manualIp, setManualIp] = useState('');
  const [ipError, setIpError] = useState('');
  const [pickFocus, setPickFocus] = useState<'list' | 'input'>('list');
  const [pickError, setPickError] = useState('');

  // параметры перевода
  const [probe, setProbe] = useState<PrinterProbe | null>(null);
  const [opts, setOpts] = useState<MigrateOptions | null>(null);
  const [optIdx, setOptIdx] = useState(0);
  const [optionsBack, setOptionsBack] = useState<Phase>('pick');
  const [editingName, setEditingName] = useState(false);
  // Где правим имя: стрелками ←→ по строке, чтобы менять не только с конца.
  const [namePos, setNamePos] = useState(0);

  const [log, setLog] = useState<string[]>([]);
  const [runTitle, setRunTitle] = useState('');
  const [result, setResult] = useState<ResultView | null>(null);
  const [resultTop, setResultTop] = useState(0);

  // Ink рисует во время await, но обновлять state после ухода с экрана нельзя.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = async () => {
    setPhase('loading');
    const st = await readSystemState();
    if (!alive.current) return;
    setSys(st);
    setQueueIdx(i => (i < st.queues.length ? i : 0));
    setPhase('view');
  };

  useEffect(() => { refresh(); }, []);

  const selectedQueue = queues[queueIdx];

  // ── действия ────────────────────────────────────────────────────────────────

  const startRun = (title: string) => { setRunTitle(title); setLog([]); setPhase('running'); };
  const showResult = (r: ResultView) => { setResult(r); setResultTop(0); setPhase('result'); };
  const step = (msg: string) => { if (alive.current) setLog(l => [...l, msg]); };

  const doDiagnose = async (q: PrintQueue) => {
    startRun(`Диагностика: ${q.name}`);
    step(q.conn === 'other'
      ? 'Опрашиваю очередь и журнал cups...'
      : `Опрашиваю очередь, аппарат (${q.conn === 'usb' ? 'USB' : q.ip}) по IPP и журнал cups...`);
    const d = await diagnose(q, sys?.usb ?? []);
    if (!alive.current) return;
    setDiag(d);
    setPhase('diagnosis');
  };

  const doRestore = async (q: PrintQueue) => {
    startRun(`Восстановление очереди: ${q.name}`);
    const r = await restoreQueue(q, step);
    if (!alive.current) return;
    showResult({ ok: r.ok, title: `Очередь ${q.name}`, lines: r.msg.split('; ') });
  };

  const doClear = async (q: PrintQueue) => {
    startRun(`Очистка очереди: ${q.name}`);
    const r = await clearQueue(q, step);
    if (!alive.current) return;
    showResult({ ok: r.ok, title: `Очередь ${q.name}`, lines: r.msg.split('; ') });
  };

  const doClose = async (q: PrintQueue) => {
    startRun(`Закрытие очереди: ${q.name}`);
    const r = await closeQueue(q, step);
    if (!alive.current) return;
    showResult({ ok: r.ok, title: `Очередь ${q.name}`, lines: r.msg.split('; ') });
  };

  const openPick = () => {
    if (!sys) return;
    setCands([]);
    setCandIdx(0);
    setManualIp(selectedQueue?.ip || sys.airscan.ip || '');
    setIpError('');
    setPickError('');
    setPickFocus('list');
    setPhase('pick');
    (async () => {
      setSearching(true);
      const list = await findCandidates(sys);
      if (!alive.current) return;
      setCands(list);
      // сначала аппарат выбранной очереди — сетевой или USB
      const own = selectedQueue ? connOfQueue(selectedQueue, sys.usb) : null;
      const i = own ? list.findIndex(c => connKey(c.conn) === connKey(own)) : -1;
      setCandIdx(i >= 0 ? i : 0);
      setSearching(false);
    })();
  };

  const openOptions = async (conn: Conn, back: Phase = 'pick') => {
    if (!sys) return;
    setOptionsBack(back);
    setPhase('probing');
    setProbe(null);
    const p = await probePrinter(conn);
    if (!alive.current) return;
    setProbe(p);
    const model = p.ipp?.model ?? '';
    setOpts({
      conn,
      queueName:     defaultQueueName(sys.queues, conn, model),
      testPage:      true,
      removeHplip:   suggestRemoveHplip(sys, conn, model),
      hideDiscovery: true,
      // У USB сканер проверяется только после запуска ipp-usb: до него eSCL
      // спрашивать негде. Предлагаем настроить — аппарат почти всегда МФУ.
      scanner:       scannerPossible(p),
      removeOthers:  false,
    });
    setOptIdx(0);
    setEditingName(false);
    setNamePos(Number.MAX_SAFE_INTEGER);
    // Имя спрашивается отдельным шагом: строку в списке параметров не
    // замечали и переводили под именем по умолчанию. Если перевод невозможен,
    // спрашивать имя незачем — сразу экран с причиной.
    setPhase(migrationBlocker(p) ? 'options' : 'name');
  };

  const doMigrate = async () => {
    if (!sys || !opts || !probe) return;
    startRun(`Перевод на driverless: ${connLabel(opts.conn)}`);
    const r: MigrateResult = await migrate(sys, opts, probe, step);
    if (!alive.current) return;
    const lines = [...r.lines];
    if (r.after.length)    lines.push('', 'Очереди после перевода:', ...r.after.map(l => '  ' + l));
    if (r.scanners.length) lines.push('', 'Сканеры:', ...r.scanners.map(l => '  ' + l));
    if (r.backupDir)       lines.push('', `Откат: ${r.backupDir}/rollback.sh`);
    if (r.ok)              lines.push('Дальше: перезагрузка → печать из LibreOffice и браузера под обычным пользователем.');
    showResult({ ok: r.ok, title: `Перевод на driverless: ${connLabel(opts.conn)}`, lines });
  };

  const runAction = (a: Action) => {
    if (a.needsQueue && !selectedQueue) return;
    switch (a.id) {
      case 'diagnose': doDiagnose(selectedQueue!); break;
      case 'migrate':  openPick(); break;
      case 'restore':  doRestore(selectedQueue!); break;
      case 'clear':    doClear(selectedQueue!); break;
      case 'close':    doClose(selectedQueue!); break;
      case 'refresh':  refresh(); break;
    }
  };

  const optDisabled = (k: OptKey): string => {
    if (!sys || !probe) return '';
    if (k === 'removeHplip' && sys.hplip.length === 0) return 'не установлен';
    if (k === 'hideDiscovery' && discoveryHidden(sys) && sys.sharing === 'off') return 'уже отключено';
    if (k === 'scanner' && !scannerPossible(probe)) return 'МФУ не отвечает по eSCL';
    return '';
  };

  /** Оговорка к включаемому параметру — в отличие от optDisabled, не запрещает. */
  const optNote = (k: OptKey): string =>
    k === 'scanner' && probe && !probe.escl && scannerPossible(probe) ? 'eSCL проверим после запуска ipp-usb' : '';

  // ── ввод ────────────────────────────────────────────────────────────────────

  useInput((char, key) => {
    if (phase === 'loading' || phase === 'running' || phase === 'probing') return;

    // Ink отдаёт Ctrl+D как char='d' с ctrl — без проверки Ctrl+D применил бы перевод.
    const k = (c: string) => !key.ctrl && !key.meta
      && (char.toLowerCase() === c || char.toLowerCase() === RU_KEY[c]);

    if (phase === 'result') {
      if (k('q') || key.escape || key.return) { refresh(); return; }
      const max = Math.max(0, resultLines(result?.lines ?? [], width - 6).length - resultRows);
      if (key.upArrow)   setResultTop(t => Math.max(0, t - 1));
      if (key.downArrow) setResultTop(t => Math.min(max, t + 1));
      if (key.pageUp)    setResultTop(t => Math.max(0, t - resultRows));
      if (key.pageDown)  setResultTop(t => Math.min(max, t + resultRows));
      return;
    }

    if (phase === 'diagnosis') {
      if (k('q') || key.escape) { setPhase('view'); return; }
      if (key.return && diag) {
        if (diag.advice === 'restore') doRestore(diag.queue);
        else if (diag.advice === 'clear') doClose(diag.queue);
        // У USB-очереди своего IP нет — аппарат для неё уже опознан пробой.
        else if (diag.advice === 'migrate' && diag.probe) openOptions(diag.probe.conn, 'diagnosis');
        // Аппарат по URI не опознан (dnssd://, имя хоста) — пусть выберут сами.
        else if (diag.advice === 'migrate') openPick();
      }
      return;
    }

    /** Правка имени: курсор ←→, вставка в любом месте, Backspace, Ctrl+U. */
    const editName = () => {
      if (!opts) return;
      const name = opts.queueName;
      const pos = Math.min(namePos, name.length);
      const setName = (next: string, at: number) => {
        setOpts({ ...opts, queueName: next });
        setNamePos(Math.max(0, Math.min(at, next.length)));
      };
      if (key.leftArrow)  { setNamePos(Math.max(0, pos - 1)); return; }
      if (key.rightArrow) { setNamePos(Math.min(name.length, pos + 1)); return; }
      if (key.home || (key.ctrl && char === 'a')) { setNamePos(0); return; }
      if (key.end  || (key.ctrl && char === 'e')) { setNamePos(name.length); return; }
      if (key.ctrl && char === 'u') { setName('', 0); return; }
      // Backspace приходит и как backspace, и как delete — зависит от
      // терминала. Оба стирают символ слева: так же ведёт себя поле IP рядом.
      if (key.backspace || key.delete) {
        if (pos > 0) setName(name.slice(0, pos - 1) + name.slice(pos), pos - 1);
        return;
      }
      if (char && !key.ctrl && !key.meta && char.charCodeAt(0) >= 0x20) {
        setName(name.slice(0, pos) + char + name.slice(pos), pos + char.length);
      }
    };

    if (phase === 'name') {
      if (key.escape) { setPhase(optionsBack); return; }
      if (key.return) {
        if (opts && !queueNameError(opts.queueName)) { setOptIdx(1); setPhase('options'); }
        return;
      }
      editName();
      return;
    }

    if (phase === 'options') {
      // Правка имени перехватывает весь ввод: иначе «d» из имени запустило бы
      // перевод, а пробел переключил бы параметр.
      if (editingName && opts) {
        if (key.return || key.escape) { setEditingName(false); return; }
        editName();
        return;
      }

      if (k('q') || key.escape) { setPhase(optionsBack); return; }
      if (key.upArrow)   setOptIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setOptIdx(i => Math.min(OPT_ROWS.length - 1, i + 1));
      if ((char === ' ' || key.return) && opts) {
        const row: OptRow = OPT_ROWS[optIdx];
        if (row === 'name') { setEditingName(true); setNamePos(opts.queueName.length); return; }
        if (!optDisabled(row)) setOpts({ ...opts, [row]: !opts[row] });
        return;
      }
      if (k('d') && opts && probe && !migrationBlocker(probe) && !queueNameError(opts.queueName)) doMigrate();
      return;
    }

    if (phase === 'pick') {
      if (key.escape) { setPhase('view'); return; }
      if (key.tab) { setPickFocus(f => f === 'list' ? 'input' : 'list'); setPickError(''); return; }

      if (pickFocus === 'input') {
        if (key.return) {
          const ip = manualIp.trim();
          if (!isIpv4(ip)) { setIpError(ip ? `«${ip}» не похож на IP-адрес` : 'введите IP-адрес МФУ'); return; }
          setIpError('');
          openOptions({ kind: 'net', ip });
          return;
        }
        if (key.ctrl && char === 'u') { setManualIp(''); setIpError(''); return; }
        if (key.backspace || key.delete) { setManualIp(s => s.slice(0, -1)); setIpError(''); return; }
        // Точка в русской раскладке — «ю» или «,» на цифровом блоке.
        const c = /^[,юЮ]$/.test(char) ? '.' : char;
        if (c && !key.ctrl && !key.meta && /^[0-9.]$/.test(c)) { setManualIp(s => s + c); setIpError(''); }
        return;
      }

      if (key.upArrow)   { setCandIdx(i => Math.max(0, i - 1)); setPickError(''); }
      if (key.downArrow) { setCandIdx(i => Math.min(Math.max(0, cands.length - 1), i + 1)); setPickError(''); }
      if (key.return && cands[candIdx]) {
        const c = cands[candIdx];
        // Раньше Enter на таком аппарате молча ничего не делал.
        if (c.note) setPickError(`нельзя выбрать: ${c.note}`);
        else openOptions(c.conn);
      }
      return;
    }

    // phase === 'view'
    if (k('q') || key.escape) { onExit(); return; }
    if (key.tab) {
      setFocus(f => (f === 'queues' || !queues.length ? 'actions' : 'queues'));
      return;
    }

    if (focus === 'queues') {
      if (key.upArrow)   { if (queueIdx === 0) setFocus('actions'); else setQueueIdx(i => i - 1); }
      if (key.downArrow) { if (queueIdx >= queues.length - 1) setFocus('actions'); else setQueueIdx(i => i + 1); }
      // Самое частое, что делают с выбранной очередью, — выясняют, что с ней.
      if (key.return && selectedQueue) doDiagnose(selectedQueue);
      return;
    }

    if (key.upArrow) {
      if (actionIdx === 0 && queues.length > 0) { setFocus('queues'); setQueueIdx(queues.length - 1); }
      else setActionIdx(i => Math.max(0, i - 1));
    }
    if (key.downArrow) setActionIdx(i => Math.min(ACTIONS.length - 1, i + 1));
    if (key.return) runAction(ACTIONS[actionIdx]);
  });

  // ── экраны ──────────────────────────────────────────────────────────────────

  if (phase === 'loading' || !sys) {
    return (
      <Frame width={width} subtitle="чтение состояния">
        <Box paddingLeft={3}><Spinner /><Text color="gray"> Опрашиваю CUPS, пакеты и службы...</Text></Box>
      </Frame>
    );
  }

  if (phase === 'running' || phase === 'probing') {
    return (
      <Frame width={width} subtitle={phase === 'probing' ? 'проверка МФУ' : runTitle}>
        {phase === 'probing' && (
          <Box paddingLeft={3}><Text color="gray">ping, порт 631, IPP Get-Printer-Attributes, eSCL...</Text></Box>
        )}
        {log.slice(-Math.max(3, rows - 9)).map((l, i, shown) => (
          <Box key={i} paddingLeft={3}>
            <Text color={i === shown.length - 1 ? 'white' : 'gray'}>
              {i === shown.length - 1 ? '❯ ' : '  '}{truncate(l, width - 8)}
            </Text>
          </Box>
        ))}
        <Box paddingLeft={3} marginTop={1}><Spinner /><Text color="gray"> выполняю...</Text></Box>
      </Frame>
    );
  }

  if (phase === 'result' && result) {
    const shown = resultLines(result.lines, width - 6);
    const top = Math.min(resultTop, Math.max(0, shown.length - resultRows));
    const scroll = shown.length > resultRows;
    return (
      <Frame width={width} subtitle="результат">
        <Box paddingLeft={3} marginBottom={1}>
          <Text bold color={result.ok ? 'green' : 'red'}>{result.ok ? '✓ ' : '✗ '}{result.title}</Text>
        </Box>
        {shown.slice(top, top + resultRows).map((l, i) => (
          <Box key={top + i} paddingLeft={3}><Text color={l.color}>{l.text || ' '}</Text></Box>
        ))}
        <Box paddingLeft={2} marginTop={1}>
          <Text color="gray" dimColor>
            {scroll ? `строки ${top + 1}–${Math.min(top + resultRows, shown.length)} из ${shown.length} · ↑↓ PgUp PgDn прокрутка · ` : ''}
            Q/Esc/Enter — назад
          </Text>
        </Box>
      </Frame>
    );
  }

  if (phase === 'diagnosis' && diag) {
    return <DiagnosisView width={width} rows={rows} diag={diag} />;
  }

  if (phase === 'pick') {
    return (
      <Frame width={width} subtitle="выбор МФУ">
        <Box paddingLeft={2}><Text color="cyan" bold>── Найденные аппараты ──</Text></Box>
        {cands.map((c, i) => {
          const cur = pickFocus === 'list' && i === candIdx;
          const usb = c.conn.kind === 'usb';
          return (
            <Box key={connKey(c.conn)} flexDirection="column">
              <Box paddingLeft={2}>
                <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
                <Text color={c.note ? 'gray' : usb ? 'cyan' : 'green'}>{usb ? 'USB  ' : 'сеть '}</Text>
                <Text color={cur && !c.note ? 'white' : 'gray'} bold={cur} dimColor={!!c.note}>
                  {truncate(c.label, 34).padEnd(34)}
                </Text>
                <Text color="gray" dimColor>{c.source}</Text>
              </Box>
              {c.note !== '' && (
                <Box paddingLeft={7}><Text color="yellow">{truncate(c.note, width - 10)}</Text></Box>
              )}
            </Box>
          );
        })}
        {searching && (
          <Box paddingLeft={3}><Spinner /><Text color="gray"> ищу через CUPS{sys.units.some(u => u.active) ? ' и mDNS' : ''}...</Text></Box>
        )}
        {!searching && cands.length === 0 && (
          <Box paddingLeft={3}><Text color="gray" dimColor>ничего не найдено — введите IP вручную (Tab)</Text></Box>
        )}

        <Box paddingLeft={2} marginTop={1}><Text color="cyan" bold>── Или введите IP вручную ──</Text></Box>
        <Box paddingLeft={3}>
          <Text color={pickFocus === 'input' ? 'white' : 'gray'}>{pickFocus === 'input' ? '❯ ' : '  '}IP: </Text>
          <Text bold>{manualIp}</Text>
          {pickFocus === 'input' && <Text inverse> </Text>}
        </Box>
        {ipError !== '' && <Box paddingLeft={3}><Text color="red">  {ipError}</Text></Box>}
        {pickError !== '' && pickFocus === 'list' && (
          <Box paddingLeft={3}><Text color="red">  {truncate(pickError, width - 8)}</Text></Box>
        )}

        <Box paddingLeft={2} marginTop={1}>
          <Text color="gray" dimColor>
            {pickFocus === 'list'
              ? '↑↓ выбор · Enter проверить аппарат · Tab ввести IP вручную · Esc назад'
              : 'цифры и точка · Ctrl+U очистить · Enter проверить МФУ · Tab к списку · Esc назад'}
          </Text>
        </Box>
      </Frame>
    );
  }

  if (phase === 'name' && opts && probe) {
    const nameError = queueNameError(opts.queueName);
    const existingName = defaultQueueName(sys.queues, opts.conn, probe.ipp?.model ?? '');
    const existing = sys.queues.find(q => q.name === existingName);
    const clash = sys.queues.find(q => q.name === opts.queueName);
    return (
      <Frame width={width} subtitle={`имя принтера · ${connLabel(opts.conn)}`}>
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text><Text color="gray">Аппарат: </Text>{probe.ipp?.model || connLabel(opts.conn)}</Text>
          <Text><Text color="gray">Связь:   </Text>{opts.conn.kind === 'usb' ? 'USB' : `сеть · ${opts.conn.ip}`}</Text>
        </Box>
        <Box paddingLeft={3}>
          <Text color="gray">Под этим именем принтер увидят пользователи в окне печати.</Text>
        </Box>
        <Box paddingLeft={3} marginBottom={1}>
          <Text color="gray">Оставьте предложенное или введите своё.</Text>
        </Box>
        <Box paddingLeft={3}>
          <Text bold>Имя принтера: </Text>
          <NameField name={opts.queueName} pos={namePos} />
        </Box>
        <Box paddingLeft={3} flexDirection="column" marginTop={1}>
          {nameError !== ''
            ? <Text color="red">✗ {nameError}</Text>
            : <Text color="gray" dimColor>без пробелов и символов {'/ \\ ? # \' " @'} · надёжнее всего латиница, цифры, «_» и «-»</Text>}
          {nameError === '' && existing && existing.name !== opts.queueName && (
            <Text color="yellow">очередь {existing.name} будет заменена очередью {opts.queueName}</Text>
          )}
          {nameError === '' && clash && !existing && (
            <Text color="yellow">очередь {clash.name} уже есть — она будет перенастроена на этот аппарат</Text>
          )}
          {nameError === '' && existing && existing.name === opts.queueName && (
            <Text color="green">прежнее имя сохраняется — пользователям ничего перенастраивать не нужно</Text>
          )}
        </Box>
        <Box paddingLeft={2} marginTop={1}>
          <Text color="gray" dimColor>
            Enter — {nameError ? 'исправьте имя' : 'дальше'} · ←→ Home End по имени · Backspace стереть · Ctrl+U очистить · Esc назад
          </Text>
        </Box>
      </Frame>
    );
  }

  if (phase === 'options' && opts && probe) {
    const blocker = migrationBlocker(probe);
    const nameError = queueNameError(opts.queueName);
    const plan = nameError ? [] : planMigration(sys, opts, probe);
    const ipp = probe.ipp;
    // Имя изменили, а очередь с прежним именем осталась на этом же аппарате:
    // она попадёт в удаляемые, и это стоит назвать переименованием вслух.
    const existingName = defaultQueueName(sys.queues, opts.conn, ipp?.model ?? '');
    const renaming = existingName !== opts.queueName
      && sys.queues.some(q => q.name === existingName);
    // Детали плана — первое, чем жертвуем в низком окне: заголовки шагов и
    // так говорят, что будет сделано, а экран выше терминала Ink ломает.
    const fixedRows = 3 + 6 + 1 + OPT_ROWS.length + 3 + 2 + plan.length + (blocker ? 2 : 0) + 2;
    const detailRows = plan.reduce((n, p) => n + p.detail.length, 0);
    const showDetail = fixedRows + detailRows <= rows - 1;
    return (
      <Frame width={width} subtitle={`перевод на driverless · ${connLabel(opts.conn)}`}>
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text>
            <Text color="gray">Связь:   </Text>
            {opts.conn.kind === 'usb'
              ? <Text color="cyan">USB · {usbPrinterName(opts.conn.usb)}</Text>
              : <Text color="green">сеть · {opts.conn.ip}</Text>}
          </Text>
          <Text><Text color="gray">МФУ:     </Text>{ipp?.model || '—'}</Text>
          {ipp && (
            <Text>
              <Text color="gray">Сейчас:  </Text>
              <Text color={ipp.state === 'stopped' ? 'red' : 'green'}>{ipp.state}</Text>
              {ipp.reasons.length ? <Text color="yellow">  {ipp.reasons.join(', ')}</Text> : null}
              {ipp.markers.map(m => <Text key={m.name} color="gray">  тонер {m.level >= 0 ? m.level + '%' : '?'}</Text>)}
            </Text>
          )}
          <Text>
            <Text color="gray">IPP:     </Text>
            {ipp?.everywhere
              ? <Text color="green">IPP Everywhere поддерживается</Text>
              : blocker
                ? <Text color="red">{blocker}</Text>
                : <Text color="yellow">проверим после запуска ipp-usb</Text>}
            <Text color="gray">   eSCL: </Text>
            <Text color={probe.escl ? 'green' : 'yellow'}>{probe.escl ? 'отвечает' : 'нет'}</Text>
          </Text>
          {probe.usbPending !== '' && (
            <Text><Text color="gray">ipp-usb: </Text><Text color="yellow">{probe.usbPending}</Text></Text>
          )}
        </Box>

        <Box paddingLeft={2}><Text color="cyan" bold>── Параметры ──</Text></Box>
        {OPT_ROWS.map((row, i) => {
          const cur = i === optIdx;
          if (row === 'name') {
            return (
              <Box key="name" paddingLeft={2}>
                <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
                <Text color={cur ? 'white' : 'gray'}>Имя принтера: </Text>
                {editingName
                  ? <NameField name={opts.queueName} pos={namePos} />
                  : <>
                      <Text bold color={cur ? 'cyan' : 'white'}>{opts.queueName}</Text>
                      {cur && <Text color="gray" dimColor>  ← Enter — изменить</Text>}
                    </>}
              </Box>
            );
          }
          const off = optDisabled(row);
          const on = opts[row] && !off;
          const remark = on ? optNote(row) : '';
          return (
            <Box key={row} paddingLeft={2}>
              <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
              <Text color={off ? 'gray' : on ? 'green' : 'gray'}>{on ? '[✓] ' : '[ ] '}</Text>
              <Text color={off ? 'gray' : cur ? 'white' : 'gray'} dimColor={!!off}>{OPT_TITLES[row]}</Text>
              {off && <Text color="gray" dimColor>  ({off})</Text>}
              {remark && <Text color="gray" dimColor>  ({remark})</Text>}
            </Box>
          );
        })}
        {nameError !== '' && (
          <Box paddingLeft={4}><Text color="red">{nameError}</Text></Box>
        )}
        {renaming && (
          <Box paddingLeft={4}>
            <Text color="yellow">очередь {existingName} будет переименована в {opts.queueName}</Text>
          </Box>
        )}
        {opts.removeHplip && !opts.testPage && sys.hplip.length > 0 && (
          <Box paddingLeft={3}><Text color="yellow">  hplip будет удалён без проверки печати</Text></Box>
        )}

        {hplipKept(sys, opts) !== '' && (
          <Box paddingLeft={3}><Text color="yellow">  {truncate(hplipKept(sys, opts), width - 8)}</Text></Box>
        )}

        <Box paddingLeft={2} marginTop={1}><Text color="cyan" bold>── Будет сделано ──</Text></Box>
        {plan.map((p, i) => (
          <Box key={p.id} flexDirection="column" paddingLeft={3}>
            <Text color={p.danger ? 'red' : 'white'}>{i + 1}. {truncate(p.title, width - 10)}</Text>
            {(showDetail || p.danger) && p.detail.map((d, j) => (
              <Text key={j} color="gray" dimColor>     {truncate(d, width - 10)}</Text>
            ))}
          </Box>
        ))}

        {blocker !== '' && (
          <Box paddingLeft={3} marginTop={1}><Text color="red">✗ Перевод невозможен: {blocker}</Text></Box>
        )}
        <Box paddingLeft={2} marginTop={1}>
          <Text color="gray" dimColor>
            {editingName
              ? '←→ по имени · Backspace стереть · Ctrl+U очистить · Enter готово'
              : `↑↓ параметр · Enter/Пробел ${OPT_ROWS[optIdx] === 'name' ? 'править имя' : 'переключить'} · ` +
                `${blocker || nameError ? '' : 'D применить · '}Esc назад`}
          </Text>
        </Box>
      </Frame>
    );
  }

  // ── основной экран ──────────────────────────────────────────────────────────

  const hidden = discoveryHidden(sys);
  return (
    <Frame width={width} subtitle={`очередей: ${queues.length}`}>
      <Box paddingLeft={2}><Text color="cyan" bold>── Очереди печати ──</Text></Box>
      {queues.length === 0 ? (
        <Box paddingLeft={3} marginBottom={1}>
          <Text color="gray" dimColor>очередей нет — заведите МФУ через «Перевести на driverless...»</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {queues.map((q, i) => {
            const cur = focus === 'queues' && i === queueIdx;
            const bad = !q.enabled || !q.accepting;
            const warn = !isDriverless(q) || (q.errorPolicy !== '' && q.errorPolicy !== 'retry-job');
            // Очередь на штатном бэкенде usb: драйверная, но рабочая и от
            // hplip не зависящая. Красить её как поломку незачем.
            const plainUsb = q.backend === 'usb' && q.enabled && q.accepting;
            return (
              <Box key={q.name} paddingLeft={2}>
                <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
                <Text color={bad ? 'red' : plainUsb ? 'gray' : warn ? 'yellow' : 'green'}>
                  {bad ? '✗ остановлена'
                    : isHplipBackend(q.backend) ? '! hplip      '
                    : plainUsb ? '· usb-драйвер'
                    : warn ? '! проверить  '
                    : '✓ driverless '}
                </Text>
                <Text color={cur ? 'white' : 'gray'} bold={cur}> {truncate(q.name, 28).padEnd(28)} </Text>
                <Text color="gray" dimColor>
                  {q.backend.padEnd(6)} {connColumn(q).padEnd(17)}
                  {q.isDefault ? ' по умолчанию' : ''}
                  {q.jobs > 0 ? ` заданий:${q.jobs}` : ''}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box paddingLeft={2}><Text color="cyan" bold>── Система ──</Text></Box>
      <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
        <Text>
          <Text color="gray">hplip:            </Text>
          {sys.hplip.length
            ? <Text color="yellow">установлен ({sys.hplip.length} пак.){sys.hpSystray ? ', hp-systray запущен' : ''}</Text>
            : <Text color="green">нет</Text>}
        </Text>
        <Text>
          <Text color="gray">автообнаружение:  </Text>
          {hidden && sys.sharing === 'off'
            ? <Text color="green">отключено</Text>
            : <Text color="yellow">
                {[...sys.units.filter(u => u.active).map(u => u.unit.replace('.service', '')),
                  ...(sys.sharing === 'on' ? ['общий доступ CUPS'] : [])].join(', ') || 'не замаскировано'}
              </Text>}
        </Text>
        {sys.usb.length > 0 && (
          <Text>
            <Text color="gray">принтеры на USB: </Text>
            <Text color={sys.usb.some(u => u.blocked) ? 'yellow' : 'gray'}>
              {sys.usb.map(u => `${usbPrinterName(u)}${u.blocked ? ' (заблокирован политикой USB)'
                : u.ippOverUsb ? '' : ' (без IPP-over-USB)'}`).join(', ')}
            </Text>
          </Text>
        )}
        {(sys.usb.length > 0 || sys.ippUsb.installed) && (
          <Text>
            <Text color="gray">ipp-usb:          </Text>
            {!sys.ippUsb.installed
              ? <Text color="yellow">не установлен — driverless по USB пока невозможен</Text>
              : sys.ippUsb.active
                ? <Text color="green">работает</Text>
                : <Text color="yellow">установлен, но не запущен</Text>}
          </Text>
        )}
        <Text>
          <Text color="gray">сканер (airscan): </Text>
          {!sys.saneAirscan
            ? <Text color="yellow">sane-airscan не установлен</Text>
            : sys.airscan.url
              ? <Text color={sys.airscan.discoveryDisabled ? 'green' : 'yellow'}>
                  {sys.airscan.url}{sys.airscan.discoveryDisabled ? ', автопоиск выключен' : ', автопоиск включён'}
                </Text>
              : <Text color="yellow">устройство не задано</Text>}
        </Text>
      </Box>

      <Box paddingLeft={2}><Text color="cyan" bold>── Действия ──</Text></Box>
      {ACTIONS.map((a, i) => {
        const cur = focus === 'actions' && i === actionIdx;
        const off = a.needsQueue && !selectedQueue;
        return (
          <Box key={a.id} paddingLeft={3}>
            <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
            <Text color={cur && !off ? 'white' : 'gray'} bold={cur} dimColor={off}>
              {a.title}{a.needsQueue && selectedQueue ? `  [${selectedQueue.name}]` : ''}
            </Text>
          </Box>
        );
      })}
      <Box paddingLeft={5} marginTop={1}><Text color="gray" dimColor>{ACTIONS[actionIdx].hint}</Text></Box>

      <Box paddingLeft={2} marginTop={1}>
        <Text color="gray" dimColor>
          {focus === 'queues'
            ? '↑↓ выбор очереди · Enter диагностика · Tab к действиям · Q/Esc выход'
            : '↑↓ выбор · Enter выполнить · Tab к очередям · Q/Esc выход'}
        </Text>
      </Box>
    </Frame>
  );
}

// ─── отчёт диагностики ───────────────────────────────────────────────────────

const ADVICE: Record<Diagnosis['advice'], string> = {
  migrate: 'Enter — перевести на driverless',
  restore: 'Enter — включить очередь',
  clear:   'Enter — закрыть очередь и снять задания: аппарат неисправен, копии копятся зря',
  printer: 'проблема на стороне МФУ — проверьте аппарат',
  none:    'проблем не найдено',
};

function DiagnosisView({ width, rows, diag }: { width: number; rows: number; diag: Diagnosis }) {
  const q = diag.queue;
  const p = diag.probe;
  // Журнал — самое длинное и самое необязательное: он получает то, что
  // осталось от высоты окна после всего остального.
  const dups = duplicateJobs(diag.jobs);
  const wrapped = (s: string) => Math.max(1, Math.ceil((s.length + 6) / Math.max(20, width - 4)));
  const used = 3 + 4
    + (p ? 1 + 3 + (p.ipp ? 3 + p.ipp.markers.length : 1) + (p.usbPending ? 1 : 0) + 1 : 0)
    + (diag.jobs.length ? 2 + dups.length : 0)
    + 2 + (diag.problems.length ? diag.problems.reduce((n, x) => n + wrapped(x), 0) : 1)
    + 1;
  const journalMax = Math.max(0, rows - 1 - used - 2);
  const journal = diag.journal.slice(-journalMax);
  const mark = (v: boolean | undefined, yes: string, no: string) =>
    v === undefined ? <Text color="gray" dimColor>не проверялось</Text>
      : v ? <Text color="green">{yes}</Text> : <Text color="red">{no}</Text>;

  return (
    <Frame width={width} subtitle={`диагностика · ${q.name}`}>
      <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
        <Text><Text color="gray">URI:          </Text>{q.uri}</Text>
        <Text><Text color="gray">Состояние:    </Text>{q.stateText || '—'}</Text>
        <Text><Text color="gray">Error-policy: </Text>
          <Text color={q.errorPolicy === 'retry-job' ? 'green' : 'yellow'}>{q.errorPolicy || 'неизвестна'}</Text>
        </Text>
      </Box>

      {p && (
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text color="cyan">МФУ {connLabel(p.conn)}</Text>
          {p.conn.kind === 'net' ? (
            <>
              <Text>  ping:        {p.ping ? <Text color="green">отвечает</Text>
                : <Text color={p.ippOpen ? 'gray' : 'red'}>не отвечает{p.ippOpen ? ' (ICMP закрыт — не страшно)' : ''}</Text>}</Text>
              <Text>  порт 631:    {mark(p.ippOpen, 'открыт', 'закрыт')}</Text>
            </>
          ) : (
            <>
              <Text>  IPP-over-USB: {mark(p.conn.usb.ippOverUsb, 'аппарат умеет', 'аппарат не умеет')}</Text>
              <Text>  ipp-usb:      {mark(p.ippUsb.installed && p.ippUsb.active, 'работает', 'не работает')}
                {p.ippOpen ? <Text color="gray">  порт {p.port}</Text> : null}
              </Text>
              {p.usbPending !== '' && <Text color="yellow">  {p.usbPending}</Text>}
            </>
          )}
          <Text>  eSCL (скан): {mark(p.ippOpen || p.reachable ? p.escl : undefined, 'отвечает', 'не отвечает')}</Text>
          {p.ipp ? (
            <>
              <Text>  модель:      {p.ipp.model || '—'}</Text>
              <Text>  состояние:   <Text color={p.ipp.state === 'stopped' ? 'red' : 'green'}>{p.ipp.state}</Text>
                {p.ipp.reasons.length ? <Text color="yellow">  {p.ipp.reasons.join(', ')}</Text> : null}
              </Text>
              {p.ipp.markers.map(m => (
                <Text key={m.name}>  тонер:       <Text color={m.level >= 0 && m.level < 10 ? 'red' : 'green'}>
                  {m.level >= 0 ? `${m.level}%` : '?'}</Text><Text color="gray">  {m.name}</Text></Text>
              ))}
              <Text>  IPP Everywhere: {mark(p.ipp.everywhere, 'да', 'нет')}</Text>
            </>
          ) : p.ippOpen ? (
            <Text color="red">  IPP: {p.ippError || 'нет ответа'}</Text>
          ) : null}
        </Box>
      )}

      {journal.length > 0 && (
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text color="cyan">
            Журнал cups/ipp-usb за 7 дней
            {journal.length < diag.journal.length ? <Text color="gray"> (последние {journal.length} из {diag.journal.length})</Text> : null}
          </Text>
          {journal.map((l, i) => <Text key={i} color="gray" dimColor>  {truncate(l, width - 8)}</Text>)}
        </Box>
      )}

      {diag.jobs.length > 0 && (
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text color="cyan">В очереди {diag.jobs.length}</Text>
          {dups.map(d => (
            <Text key={d.title} color="yellow">
              {'  '}«{truncate(d.title, Math.max(10, width - 24))}» — {d.count} раз
            </Text>
          ))}
        </Box>
      )}

      <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
        <Text color="cyan">Выводы</Text>
        {diag.problems.length === 0
          ? <Text color="green">  ✓ проблем не найдено</Text>
          : diag.problems.map((x, i) => <Text key={i} color="yellow">  • {x}</Text>)}
      </Box>

      <Box paddingLeft={2}>
        <Text color="gray" dimColor>{ADVICE[diag.advice]} · Q/Esc — назад</Text>
      </Box>
    </Frame>
  );
}

// ─── поле имени ──────────────────────────────────────────────────────────────

/** Имя с курсором: символ под курсором инвертирован, в конце — пустая клетка. */
function NameField({ name, pos }: { name: string; pos: number }) {
  const at = Math.min(pos, name.length);
  return (
    <>
      <Text bold color="cyan">{name.slice(0, at)}</Text>
      <Text inverse bold color="cyan">{name.slice(at, at + 1) || ' '}</Text>
      <Text bold color="cyan">{name.slice(at + 1)}</Text>
    </>
  );
}

// ─── общая рамка ─────────────────────────────────────────────────────────────

function Frame({ width, subtitle, children }: {
  width: number; subtitle: string; children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1} width={width}>
        <Text color="cyan" bold>◆  </Text>
        <Text bold>Печать и сканирование  </Text>
        <Text color="gray">{subtitle}</Text>
      </Box>
      {children}
    </Box>
  );
}

/**
 * Строки результата, заранее разбитые по ширине: прокрутка считает строки
 * экрана, а перенос, сделанный самим Ink, сбил бы счёт. Цвет — по значку
 * исходной строки, и продолжение переноса красится так же.
 */
function resultLines(lines: string[], width: number): { text: string; color: string }[] {
  const w = Math.max(20, width);
  const out: { text: string; color: string }[] = [];
  for (const l of lines) {
    const color = l.startsWith('✓') ? 'green' : l.startsWith('✗') ? 'red' : l.startsWith('•') ? 'yellow' : 'gray';
    if (l.length <= w) { out.push({ text: l, color }); continue; }
    let rest = l;
    let first = true;
    while (rest.length) {
      const room = first ? w : w - 2;
      let cut = rest.length <= room ? rest.length : rest.lastIndexOf(' ', room);
      if (cut <= 0) cut = Math.min(room, rest.length);
      out.push({ text: (first ? '' : '  ') + rest.slice(0, cut).trimEnd(), color });
      rest = rest.slice(cut).trimStart();
      first = false;
    }
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…';
}

/** Чем очередь подключена — вместо колонки с пустым IP у USB. */
function connColumn(q: PrintQueue): string {
  if (q.conn === 'usb') return q.ippPort ? `USB · ipp-usb:${q.ippPort}` : 'USB';
  return q.ip || '—';
}
