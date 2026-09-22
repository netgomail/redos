import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Spinner } from './Spinner';
import {
  readSystemState, diagnose, restoreQueue, findCandidates, probePrinter,
  planMigration, migrate, migrationBlocker, defaultQueueName,
  discoveryHidden, isHplipBackend, isDriverless, isIpv4,
} from '../features/printer';
import type {
  SystemState, PrintQueue, Diagnosis, Candidate, PrinterProbe,
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
  | 'options'    // что будет сделано + переключатели, D — применить
  | 'running'    // живой лог шагов
  | 'result';

type ActionId = 'diagnose' | 'migrate' | 'restore' | 'refresh';

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
    hint: 'очередь ipp://IP/ipp/print без hplip, retry-job, сканер по eSCL, тестовая печать, удаление hplip' },
  { id: 'restore',  needsQueue: true,  title: 'Включить остановленную очередь',
    hint: 'cupsenable, cupsaccept, retry-job, снять застрявшие задания — бэкенд не меняется' },
  { id: 'refresh',  needsQueue: false, title: 'Обновить',
    hint: 'перечитать состояние' },
];

type OptKey = 'testPage' | 'removeHplip' | 'hideDiscovery' | 'scanner' | 'removeOthers';

const OPT_TITLES: Record<OptKey, string> = {
  testPage:      'тестовая страница перед удалением hplip',
  removeHplip:   'удалить hplip',
  hideDiscovery: 'отключить автообнаружение (cups-browsed, avahi, общий доступ)',
  scanner:       'сканер по eSCL (sane-airscan, IP, без автопоиска)',
  removeOthers:  'удалить и все остальные очереди',
};
const OPT_KEYS = Object.keys(OPT_TITLES) as OptKey[];

interface ResultView { ok: boolean; title: string; lines: string[] }

export function PrinterScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

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

  // параметры перевода
  const [probe, setProbe] = useState<PrinterProbe | null>(null);
  const [opts, setOpts] = useState<MigrateOptions | null>(null);
  const [optIdx, setOptIdx] = useState(0);
  const [optionsBack, setOptionsBack] = useState<Phase>('pick');

  const [log, setLog] = useState<string[]>([]);
  const [runTitle, setRunTitle] = useState('');
  const [result, setResult] = useState<ResultView | null>(null);

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
  const step = (msg: string) => { if (alive.current) setLog(l => [...l, msg]); };

  const doDiagnose = async (q: PrintQueue) => {
    startRun(`Диагностика: ${q.name}`);
    step(q.ip ? `Опрашиваю очередь, МФУ ${q.ip} по IPP и журнал cups...` : 'Опрашиваю очередь и журнал cups...');
    const d = await diagnose(q);
    if (!alive.current) return;
    setDiag(d);
    setPhase('diagnosis');
  };

  const doRestore = async (q: PrintQueue) => {
    startRun(`Восстановление очереди: ${q.name}`);
    const r = await restoreQueue(q, step);
    if (!alive.current) return;
    setResult({ ok: r.ok, title: `Очередь ${q.name}`, lines: r.msg.split('; ') });
    setPhase('result');
  };

  const openPick = () => {
    if (!sys) return;
    setCands([]);
    setCandIdx(0);
    setManualIp(selectedQueue?.ip || sys.airscan.ip || '');
    setIpError('');
    setPickFocus('list');
    setPhase('pick');
    (async () => {
      setSearching(true);
      const list = await findCandidates(sys);
      if (!alive.current) return;
      setCands(list);
      // сначала IP выбранной очереди
      const i = list.findIndex(c => c.ip === selectedQueue?.ip);
      setCandIdx(i >= 0 ? i : 0);
      setSearching(false);
    })();
  };

  const openOptions = async (ip: string, back: Phase = 'pick') => {
    if (!sys) return;
    setOptionsBack(back);
    setPhase('probing');
    setProbe(null);
    const p = await probePrinter(ip);
    if (!alive.current) return;
    setProbe(p);
    setOpts({
      ip,
      queueName:     defaultQueueName(sys.queues, ip),
      testPage:      true,
      removeHplip:   sys.hplip.length > 0,
      hideDiscovery: true,
      scanner:       p.escl,
      removeOthers:  false,
    });
    setOptIdx(0);
    setPhase('options');
  };

  const doMigrate = async () => {
    if (!sys || !opts || !probe) return;
    startRun(`Перевод на driverless: ${opts.ip}`);
    const r: MigrateResult = await migrate(sys, opts, probe, step);
    if (!alive.current) return;
    const lines = [...r.lines];
    if (r.after.length)    lines.push('', 'Очереди после перевода:', ...r.after.map(l => '  ' + l));
    if (r.scanners.length) lines.push('', 'Сканеры:', ...r.scanners.map(l => '  ' + l));
    if (r.backupDir)       lines.push('', `Откат: ${r.backupDir}/rollback.sh`);
    if (r.ok)              lines.push('Дальше: перезагрузка → печать из LibreOffice и браузера под обычным пользователем.');
    setResult({ ok: r.ok, title: `Перевод на driverless: ${opts.ip}`, lines });
    setPhase('result');
  };

  const runAction = (a: Action) => {
    if (a.needsQueue && !selectedQueue) return;
    switch (a.id) {
      case 'diagnose': doDiagnose(selectedQueue!); break;
      case 'migrate':  openPick(); break;
      case 'restore':  doRestore(selectedQueue!); break;
      case 'refresh':  refresh(); break;
    }
  };

  const optDisabled = (k: OptKey): string => {
    if (!sys || !probe) return '';
    if (k === 'removeHplip' && sys.hplip.length === 0) return 'не установлен';
    if (k === 'hideDiscovery' && discoveryHidden(sys) && sys.sharing === 'off') return 'уже отключено';
    if (k === 'scanner' && !probe.escl) return 'МФУ не отвечает по eSCL';
    return '';
  };

  // ── ввод ────────────────────────────────────────────────────────────────────

  useInput((char, key) => {
    if (phase === 'loading' || phase === 'running' || phase === 'probing') return;

    // Ink отдаёт Ctrl+D как char='d' с ctrl — без проверки Ctrl+D применил бы перевод.
    const k = (c: string) => !key.ctrl && !key.meta && char.toLowerCase() === c;

    if (phase === 'result') {
      if (k('q') || key.escape || key.return) refresh();
      return;
    }

    if (phase === 'diagnosis') {
      if (k('q') || key.escape) { setPhase('view'); return; }
      if (key.return && diag) {
        if (diag.advice === 'restore') doRestore(diag.queue);
        else if (diag.advice === 'migrate' && diag.queue.ip) openOptions(diag.queue.ip, 'diagnosis');
      }
      return;
    }

    if (phase === 'options') {
      if (k('q') || key.escape) { setPhase(optionsBack); return; }
      if (key.upArrow)   setOptIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setOptIdx(i => Math.min(OPT_KEYS.length - 1, i + 1));
      if ((char === ' ' || key.return) && opts) {
        const kk = OPT_KEYS[optIdx];
        if (!optDisabled(kk)) setOpts({ ...opts, [kk]: !opts[kk] });
        return;
      }
      if (k('d') && probe && !migrationBlocker(probe)) doMigrate();
      return;
    }

    if (phase === 'pick') {
      if (key.escape) { setPhase('view'); return; }
      if (key.tab) { setPickFocus(f => f === 'list' ? 'input' : 'list'); return; }

      if (pickFocus === 'input') {
        if (key.return) {
          const ip = manualIp.trim();
          if (!isIpv4(ip)) { setIpError(ip ? `«${ip}» не похож на IP-адрес` : 'введите IP-адрес МФУ'); return; }
          setIpError('');
          openOptions(ip);
          return;
        }
        if (key.ctrl && char === 'u') { setManualIp(''); setIpError(''); return; }
        if (key.backspace || key.delete) { setManualIp(s => s.slice(0, -1)); setIpError(''); return; }
        if (char && !key.ctrl && !key.meta && /^[0-9.]$/.test(char)) { setManualIp(s => s + char); setIpError(''); }
        return;
      }

      if (key.upArrow)   setCandIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setCandIdx(i => Math.min(Math.max(0, cands.length - 1), i + 1));
      if (key.return && cands[candIdx]) openOptions(cands[candIdx].ip);
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
        {log.map((l, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={i === log.length - 1 ? 'white' : 'gray'}>
              {i === log.length - 1 ? '❯ ' : '  '}{truncate(l, width - 8)}
            </Text>
          </Box>
        ))}
        <Box paddingLeft={3} marginTop={1}><Spinner /><Text color="gray"> выполняю...</Text></Box>
      </Frame>
    );
  }

  if (phase === 'result' && result) {
    return (
      <Frame width={width} subtitle="результат">
        <Box paddingLeft={3} marginBottom={1}>
          <Text bold color={result.ok ? 'green' : 'red'}>{result.ok ? '✓ ' : '✗ '}{result.title}</Text>
        </Box>
        {result.lines.map((l, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={l.startsWith('✓') ? 'green' : l.startsWith('✗') ? 'red' : l.startsWith('•') ? 'yellow' : 'gray'}>
              {l || ' '}
            </Text>
          </Box>
        ))}
        <Box paddingLeft={2} marginTop={1}><Text color="gray" dimColor>Q/Esc/Enter — назад</Text></Box>
      </Frame>
    );
  }

  if (phase === 'diagnosis' && diag) {
    return <DiagnosisView width={width} diag={diag} />;
  }

  if (phase === 'pick') {
    return (
      <Frame width={width} subtitle="выбор МФУ">
        <Box paddingLeft={2}><Text color="cyan" bold>── Известные адреса ──</Text></Box>
        {cands.map((c, i) => {
          const cur = pickFocus === 'list' && i === candIdx;
          return (
            <Box key={c.ip} paddingLeft={2}>
              <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
              <Text color={cur ? 'white' : 'gray'} bold={cur}>{c.ip.padEnd(16)}</Text>
              <Text color="gray" dimColor>{c.source}</Text>
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

        <Box paddingLeft={2} marginTop={1}>
          <Text color="gray" dimColor>
            {pickFocus === 'list'
              ? '↑↓ выбор · Enter проверить МФУ · Tab ввод IP · Esc назад'
              : 'цифры и точка · Ctrl+U очистить · Enter проверить МФУ · Tab к списку · Esc назад'}
          </Text>
        </Box>
      </Frame>
    );
  }

  if (phase === 'options' && opts && probe) {
    const blocker = migrationBlocker(probe);
    const plan = planMigration(sys, opts);
    const ipp = probe.ipp;
    return (
      <Frame width={width} subtitle={`перевод на driverless · ${opts.ip}`}>
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
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
              : <Text color="red">{blocker || 'нет'}</Text>}
            <Text color="gray">   eSCL: </Text>
            <Text color={probe.escl ? 'green' : 'yellow'}>{probe.escl ? 'отвечает' : 'нет'}</Text>
          </Text>
          <Text><Text color="gray">Очередь: </Text><Text bold>{opts.queueName}</Text></Text>
        </Box>

        <Box paddingLeft={2}><Text color="cyan" bold>── Параметры ──</Text></Box>
        {OPT_KEYS.map((kk, i) => {
          const cur = i === optIdx;
          const off = optDisabled(kk);
          const on = opts[kk] && !off;
          return (
            <Box key={kk} paddingLeft={2}>
              <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
              <Text color={off ? 'gray' : on ? 'green' : 'gray'}>{on ? '[✓] ' : '[ ] '}</Text>
              <Text color={off ? 'gray' : cur ? 'white' : 'gray'} dimColor={!!off}>{OPT_TITLES[kk]}</Text>
              {off && <Text color="gray" dimColor>  ({off})</Text>}
            </Box>
          );
        })}
        {opts.removeHplip && !opts.testPage && sys.hplip.length > 0 && (
          <Box paddingLeft={3}><Text color="yellow">  hplip будет удалён без проверки печати</Text></Box>
        )}

        <Box paddingLeft={2} marginTop={1}><Text color="cyan" bold>── Будет сделано ──</Text></Box>
        {plan.map((p, i) => (
          <Box key={p.id} flexDirection="column" paddingLeft={3}>
            <Text color={p.danger ? 'red' : 'white'}>{i + 1}. {p.title}</Text>
            {p.detail.map((d, j) => <Text key={j} color="gray" dimColor>     {truncate(d, width - 10)}</Text>)}
          </Box>
        ))}

        {blocker !== '' && (
          <Box paddingLeft={3} marginTop={1}><Text color="red">✗ Перевод невозможен: {blocker}</Text></Box>
        )}
        <Box paddingLeft={2} marginTop={1}>
          <Text color="gray" dimColor>
            ↑↓ параметр · Пробел переключить · {blocker ? '' : 'D применить · '}Esc назад
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
            return (
              <Box key={q.name} paddingLeft={2}>
                <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
                <Text color={bad ? 'red' : warn ? 'yellow' : 'green'}>
                  {bad ? '✗ остановлена' : isHplipBackend(q.backend) ? '! hplip      ' : warn ? '! проверить  ' : '✓ driverless '}
                </Text>
                <Text color={cur ? 'white' : 'gray'} bold={cur}> {truncate(q.name, 32).padEnd(32)} </Text>
                <Text color="gray" dimColor>
                  {q.backend.padEnd(6)} {(q.ip || '—').padEnd(15)}
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
        <Text>
          <Text color="gray">сканер (airscan): </Text>
          {!sys.saneAirscan
            ? <Text color="yellow">sane-airscan не установлен</Text>
            : sys.airscan.ip
              ? <Text color={sys.airscan.discoveryDisabled ? 'green' : 'yellow'}>
                  {sys.airscan.ip}{sys.airscan.discoveryDisabled ? ', автопоиск выключен' : ', автопоиск включён'}
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
            ? '↑↓ выбор очереди · Tab к действиям · Q/Esc выход'
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
  printer: 'проблема на стороне МФУ — проверьте аппарат',
  none:    'проблем не найдено',
};

function DiagnosisView({ width, diag }: { width: number; diag: Diagnosis }) {
  const q = diag.queue;
  const p = diag.probe;
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
          <Text color="cyan">МФУ {p.ip}</Text>
          <Text>  ping:        {mark(p.ping, 'отвечает', 'не отвечает')}</Text>
          <Text>  порт 631:    {mark(p.ping ? p.port631 : undefined, 'открыт', 'закрыт')}</Text>
          <Text>  eSCL (скан): {mark(p.ping ? p.escl : undefined, 'отвечает', 'не отвечает')}</Text>
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
          ) : p.ping && p.port631 ? (
            <Text color="red">  IPP: {p.ippError || 'нет ответа'}</Text>
          ) : null}
        </Box>
      )}

      {diag.journal.length > 0 && (
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text color="cyan">Журнал cups (ошибки бэкенда)</Text>
          {diag.journal.map((l, i) => <Text key={i} color="gray" dimColor>  {truncate(l, width - 8)}</Text>)}
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…';
}
