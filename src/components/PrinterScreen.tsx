import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Spinner } from './Spinner';
import {
  listQueues, diagnose, fixQueue,
  discoverMfp, setupSingleMfp, readSingleMfpState,
  isFragileBackend,
} from '../features/printer';
import type {
  PrintQueue, Diagnosis, DiscoveredMfp, SingleMfpState, SetupResult,
} from '../features/printer';

interface Props {
  onExit: () => void;
}

type Phase =
  | 'loading'    // читаем состояние CUPS
  | 'view'       // список очередей + действия
  | 'diagnosis'  // отчёт диагностики
  | 'discover'   // поиск МФУ в сети + ручной ввод IP
  | 'confirm'    // подтверждение необратимого действия
  | 'running'    // живой лог шагов
  | 'result';

type ActionId = 'diagnose' | 'fix' | 'fix-test' | 'single' | 'refresh';

interface Action {
  id:    ActionId;
  title: string;
  hint:  string;
  /** Нужна выбранная очередь. */
  needsQueue: boolean;
}

const ACTIONS: Action[] = [
  { id: 'diagnose',  needsQueue: true,  title: 'Диагностика очереди',
    hint: 'состояние, error-policy, ping, порты 631/9100, записи журнала cups' },
  { id: 'fix',       needsQueue: true,  title: 'Починить очередь',
    hint: 'перевод на IPP Everywhere, error-policy=retry-job, включение, снятие застрявших заданий' },
  { id: 'fix-test',  needsQueue: true,  title: 'Починить и напечатать тестовую страницу',
    hint: 'то же самое плюс проверка печати' },
  { id: 'single',    needsQueue: false, title: 'Оставить только один МФУ...',
    hint: 'убрать из системы все прочие принтеры и сканеры, привязаться к одному аппарату' },
  { id: 'refresh',   needsQueue: false, title: 'Обновить',
    hint: 'перечитать состояние CUPS' },
];

export function PrinterScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const [phase, setPhase] = useState<Phase>('loading');

  const [queues, setQueues] = useState<PrintQueue[]>([]);
  const [state,  setState]  = useState<SingleMfpState | null>(null);
  const [queueIdx,  setQueueIdx]  = useState(0);
  const [actionIdx, setActionIdx] = useState(0);
  const [focus, setFocus] = useState<'queues' | 'actions'>('actions');

  const [diag, setDiag] = useState<Diagnosis | null>(null);

  // discover
  const [found, setFound] = useState<DiscoveredMfp[]>([]);
  const [scanning, setScanning] = useState(false);
  const [foundIdx, setFoundIdx] = useState(0);
  const [manualIp, setManualIp] = useState('');
  // Поле подставляет IP из уже настроенного airscan.conf. Первый же введённый
  // символ должен заменить подсказку целиком, а не дописаться к ней.
  const [ipTouched, setIpTouched] = useState(false);
  const [ipError, setIpError] = useState('');
  const [discoverFocus, setDiscoverFocus] = useState<'list' | 'input'>('list');
  const [keepAvahi, setKeepAvahi] = useState(false);

  // подтверждение / выполнение
  const [pendingIp, setPendingIp] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [runTitle, setRunTitle] = useState('');

  const [result, setResult] = useState<{ ok: boolean; title: string; lines: string[] } | null>(null);

  // Ink продолжает рисовать во время await, но обновлять state после ухода с
  // экрана нельзя — держим флаг живости.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = async () => {
    setPhase('loading');
    const [qs, st] = await Promise.all([listQueues(), readSingleMfpState()]);
    if (!alive.current) return;
    setQueues(qs);
    setState(st);
    setQueueIdx(i => (i < qs.length ? i : 0));
    setPhase('view');
  };

  useEffect(() => { refresh(); }, []);

  const selectedQueue = queues[queueIdx];

  // ── действия ────────────────────────────────────────────────────────────────

  const startRun = (title: string) => {
    setRunTitle(title);
    setLog([]);
    setPhase('running');
  };
  const step = (msg: string) => { if (alive.current) setLog(l => [...l, msg]); };

  const doDiagnose = async (q: PrintQueue) => {
    startRun(`Диагностика: ${q.name}`);
    step('Опрашиваю очередь, сеть и журнал cups...');
    const d = await diagnose(q);
    if (!alive.current) return;
    setDiag(d);
    setPhase('diagnosis');
  };

  const doFix = async (q: PrintQueue, testPage: boolean) => {
    startRun(`Лечение очереди: ${q.name}`);
    const r = await fixQueue(q, { testPage, onStep: step });
    if (!alive.current) return;
    setResult({
      ok: r.ok,
      title: `Очередь ${q.name}`,
      lines: r.ok ? r.msg.split('; ') : [r.msg],
    });
    setPhase('result');
  };

  const openDiscover = () => {
    setFound([]);
    setFoundIdx(0);
    setManualIp(state?.scannerIp ?? '');
    setIpTouched(false);
    setIpError('');
    setDiscoverFocus('list');
    setPhase('discover');
    runDiscovery();
  };

  const runDiscovery = async () => {
    setScanning(true);
    const list = await discoverMfp();
    if (!alive.current) return;
    setFound(list);
    setFoundIdx(0);
    setScanning(false);
  };

  const doSetup = async (ip: string) => {
    startRun(`Привязка системы к МФУ ${ip}`);
    const r: SetupResult = await setupSingleMfp({ ip, keepAvahi, onStep: step });
    if (!alive.current) return;
    const lines = [r.msg];
    if (r.queues?.length)   lines.push('', 'Принтеры после настройки:',  ...r.queues.map(l => '  ' + l));
    if (r.scanners?.length) lines.push('', 'Сканеры после настройки:',   ...r.scanners.map(l => '  ' + l));
    setResult({ ok: r.ok, title: `Только один МФУ: ${ip}`, lines });
    setPhase('result');
  };

  const runAction = (a: Action) => {
    if (a.needsQueue && !selectedQueue) return;
    switch (a.id) {
      case 'diagnose': doDiagnose(selectedQueue!); break;
      case 'fix':      doFix(selectedQueue!, false); break;
      case 'fix-test': doFix(selectedQueue!, true);  break;
      case 'single':   openDiscover(); break;
      case 'refresh':  refresh(); break;
    }
  };

  // ── ввод ────────────────────────────────────────────────────────────────────

  useInput((char, key) => {
    if (phase === 'loading' || phase === 'running') return;

    // Ink отдаёт управляющие символы как обычные буквы с выставленным ctrl:
    // Ctrl+D приходит как char='d'. Без этой проверки Ctrl+D на экране
    // подтверждения запускал бы необратимую перенастройку системы.
    const k = (c: string) => !key.ctrl && !key.meta && char.toLowerCase() === c;

    if (phase === 'result') {
      if (k('q') || key.escape || key.return) refresh();
      return;
    }

    if (phase === 'diagnosis') {
      if (k('q') || key.escape) { setPhase('view'); return; }
      if (key.return && diag) doFix(diag.queue, false);
      return;
    }

    if (phase === 'confirm') {
      if (k('q') || key.escape) { setPhase('discover'); return; }
      if (k('d')) doSetup(pendingIp);
      return;
    }

    if (phase === 'discover') {
      if (key.escape) { setPhase('view'); return; }
      if (key.tab) {
        setDiscoverFocus(f => f === 'list' ? 'input' : 'list');
        return;
      }
      if (k('r') && discoverFocus === 'list' && !scanning) { runDiscovery(); return; }
      if (k('a') && discoverFocus === 'list') { setKeepAvahi(v => !v); return; }

      if (discoverFocus === 'input') {
        if (key.return) {
          const ip = manualIp.trim();
          if (!isIpv4(ip)) {
            setIpError(ip ? `«${ip}» не похож на IP-адрес` : 'введите IP-адрес МФУ');
            return;
          }
          setIpError('');
          setPendingIp(ip);
          setPhase('confirm');
          return;
        }
        if (key.ctrl && char === 'u') { setManualIp(''); setIpTouched(true); setIpError(''); return; }
        if (key.backspace || key.delete) {
          setManualIp(s => (ipTouched ? s.slice(0, -1) : ''));
          setIpTouched(true);
          setIpError('');
          return;
        }
        if (char && !key.ctrl && !key.meta && /[0-9.]/.test(char)) {
          setManualIp(s => (ipTouched ? s + char : char));
          setIpTouched(true);
          setIpError('');
        }
        return;
      }

      // discoverFocus === 'list'
      if (key.upArrow)   setFoundIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setFoundIdx(i => Math.min(Math.max(0, found.length - 1), i + 1));
      if (key.return && found[foundIdx]) {
        setPendingIp(found[foundIdx].ip);
        setPhase('confirm');
      }
      return;
    }

    // phase === 'view'
    if (k('q') || key.escape) { onExit(); return; }
    if (key.tab) {
      setFocus(f => (f === 'queues' && queues.length ? 'actions' : queues.length ? 'queues' : 'actions'));
      return;
    }

    if (focus === 'queues') {
      if (key.upArrow) {
        if (queueIdx === 0) setFocus('actions');
        else setQueueIdx(i => i - 1);
      }
      if (key.downArrow) {
        if (queueIdx >= queues.length - 1) setFocus('actions');
        else setQueueIdx(i => i + 1);
      }
      return;
    }

    if (key.upArrow) {
      if (actionIdx === 0 && queues.length > 0) {
        setFocus('queues');
        setQueueIdx(queues.length - 1);
      } else {
        setActionIdx(i => Math.max(0, i - 1));
      }
    }
    if (key.downArrow) setActionIdx(i => Math.min(ACTIONS.length - 1, i + 1));
    if (key.return) runAction(ACTIONS[actionIdx]);
  });

  // ── экраны ──────────────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <Frame width={width} subtitle="чтение состояния">
        <Box paddingLeft={3}><Spinner /><Text color="gray"> Опрашиваю CUPS...</Text></Box>
      </Frame>
    );
  }

  if (phase === 'running') {
    return (
      <Frame width={width} subtitle={runTitle}>
        {log.map((l, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={i === log.length - 1 ? 'white' : 'gray'}>
              {i === log.length - 1 ? '❯ ' : '  '}{l}
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
        <Box paddingLeft={3} marginBottom={1}><Text bold>{result.title}</Text></Box>
        {result.lines.map((l, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={i === 0 ? (result.ok ? 'green' : 'red') : 'gray'}>
              {i === 0 ? (result.ok ? '✓ ' : '✗ ') : '  '}{l}
            </Text>
          </Box>
        ))}
        <Box paddingLeft={2} marginTop={1}>
          <Text color="gray" dimColor>Q/Esc/Enter — назад</Text>
        </Box>
      </Frame>
    );
  }

  if (phase === 'diagnosis' && diag) {
    return <DiagnosisView width={width} diag={diag} />;
  }

  if (phase === 'confirm') {
    return (
      <Frame width={width} subtitle="подтверждение">
        <Box paddingLeft={3} marginBottom={1}>
          <Text bold color="yellow">Оставить в системе только МФУ {pendingIp}</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text color="gray">Будет сделано:</Text>
          <Text color="gray">  • очередь печати переведена на ipp://{pendingIp}/ipp/print</Text>
          <Text color="red">  • все остальные очереди печати удалены ({Math.max(0, queues.length - 1)} шт.)</Text>
          <Text color="gray">  • SANE оставит один бэкенд airscan, устройство задано по IP</Text>
          <Text color="gray">  • бэкенд hpaio отключён</Text>
          <Text color={keepAvahi ? 'gray' : 'red'}>
            {keepAvahi
              ? '  • avahi (mDNS) оставлен включённым'
              : '  • avahi (mDNS) отключён и замаскирован — сетевое обнаружение пропадёт'}
          </Text>
        </Box>
        <Box paddingLeft={3} marginBottom={1}>
          <Text color="gray" dimColor>
            Бэкап и скрипт отката появятся в /root/redos-mfp-backup-&lt;дата&gt;/rollback.sh
          </Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>D — применить · Q/Esc — отмена</Text>
        </Box>
      </Frame>
    );
  }

  if (phase === 'discover') {
    return (
      <Frame width={width} subtitle="выбор МФУ">
        <Box paddingLeft={2}><Text color="cyan" bold>── Найденные аппараты ──</Text></Box>
        {scanning ? (
          <Box paddingLeft={3}><Spinner /><Text color="gray"> ищу по mDNS и через CUPS...</Text></Box>
        ) : found.length === 0 ? (
          <Box paddingLeft={3}>
            <Text color="gray" dimColor>
              ничего не найдено — введите IP вручную (Tab) или повторите поиск (R)
            </Text>
          </Box>
        ) : (
          found.map((f, i) => {
            const cur = discoverFocus === 'list' && i === foundIdx;
            return (
              <Box key={f.ip} paddingLeft={2}>
                <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
                <Text color={cur ? 'white' : 'gray'} bold={cur}>{f.ip.padEnd(16)}</Text>
                <Text color={f.escl ? 'green' : 'gray'}>{f.escl ? 'МФУ (eSCL) ' : 'принтер    '}</Text>
                <Text color="gray">{f.name}</Text>
              </Box>
            );
          })
        )}

        <Box paddingLeft={2} marginTop={1}><Text color="cyan" bold>── Или введите IP вручную ──</Text></Box>
        <Box paddingLeft={3}>
          <Text color={discoverFocus === 'input' ? 'white' : 'gray'}>
            {discoverFocus === 'input' ? '❯ ' : '  '}IP: </Text>
          <Text color={ipTouched ? 'white' : 'gray'} bold={ipTouched} dimColor={!ipTouched}>
            {manualIp}
          </Text>
          {discoverFocus === 'input' && <Text inverse> </Text>}
          {!ipTouched && manualIp !== '' && (
            <Text color="gray" dimColor>  ← из airscan.conf, начните вводить чтобы заменить</Text>
          )}
        </Box>
        {ipError !== '' && (
          <Box paddingLeft={3}><Text color="red">  {ipError}</Text></Box>
        )}

        <Box paddingLeft={3} marginTop={1}>
          <Text color={keepAvahi ? 'green' : 'red'}>{keepAvahi ? '[✓]' : '[ ]'}</Text>
          <Text color="gray"> оставить avahi/mDNS включённым (A)</Text>
        </Box>

        <Box paddingLeft={2} marginTop={1}>
          <Text color="gray" dimColor>
            {discoverFocus === 'list'
              ? '↑↓ выбор · Enter далее · R повторить поиск · A avahi · Tab ввод IP · Esc назад'
              : 'цифры и точка · Ctrl+U очистить · Enter далее · Tab к списку · Esc назад'}
          </Text>
        </Box>
      </Frame>
    );
  }

  // ── основной экран ──────────────────────────────────────────────────────────

  const subtitle = state?.active
    ? `режим «только один МФУ» включён${state.scannerIp ? ' · ' + state.scannerIp : ''}` +
      (state.avahiMasked ? ' · avahi замаскирован' : '')
    : `очередей: ${queues.length}`;

  return (
    <Frame width={width} subtitle={subtitle}>
      <Box paddingLeft={2}><Text color="cyan" bold>── Очереди печати ──</Text></Box>
      {queues.length === 0 ? (
        <Box paddingLeft={3} marginBottom={1}>
          <Text color="gray" dimColor>
            очередей нет — заведите МФУ через «Оставить только один МФУ...»
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {queues.map((q, i) => {
            const cur = focus === 'queues' && i === queueIdx;
            const bad = !q.enabled || !q.accepting;
            const warn = isFragileBackend(q.backend)
                      || (q.errorPolicy !== '' && q.errorPolicy !== 'retry-job');
            return (
              <Box key={q.name} paddingLeft={2}>
                <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
                <Text color={bad ? 'red' : warn ? 'yellow' : 'green'}>
                  {bad ? '✗ отключена' : warn ? '! требует внимания' : '✓ работает   '}
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

      <Box paddingLeft={2}><Text color="cyan" bold>── Действия ──</Text></Box>
      {ACTIONS.map((a, i) => {
        const cur = focus === 'actions' && i === actionIdx;
        const off = a.needsQueue && !selectedQueue;
        return (
          <Box key={a.id} paddingLeft={3}>
            <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
            <Text color={off ? 'gray' : cur ? 'white' : 'gray'} bold={cur} dimColor={off}>
              {a.title}
            </Text>
          </Box>
        );
      })}
      <Box paddingLeft={5} marginTop={1}>
        <Text color="gray" dimColor>{ACTIONS[actionIdx].hint}</Text>
      </Box>

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

function DiagnosisView({ width, diag }: { width: number; diag: Diagnosis }) {
  const q = diag.queue;
  const mark = (v: boolean | null, yes: string, no: string) =>
    v === null ? <Text color="gray" dimColor>не проверялось</Text>
      : v ? <Text color="green">{yes}</Text> : <Text color="red">{no}</Text>;

  return (
    <Frame width={width} subtitle={`диагностика · ${q.name}`}>
      <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
        <Text><Text color="gray">URI:          </Text>{q.uri}</Text>
        <Text><Text color="gray">Состояние:    </Text>{q.stateText || '—'}</Text>
        <Text><Text color="gray">Error-policy: </Text>
          <Text color={q.errorPolicy === 'retry-job' ? 'green' : 'yellow'}>
            {q.errorPolicy || 'неизвестна'}
          </Text>
        </Text>
      </Box>

      {q.ip && (
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text color="cyan">Сеть {q.ip}</Text>
          <Text>  ping:        {mark(diag.ping, 'отвечает', 'не отвечает')}</Text>
          <Text>  порт 631:    {mark(diag.port631, 'открыт', 'закрыт')}</Text>
          <Text>  порт 9100:   {mark(diag.port9100, 'открыт', 'закрыт')}</Text>
          <Text>  eSCL (скан): {mark(diag.escl, 'отвечает', 'не отвечает')}</Text>
        </Box>
      )}

      {diag.journal.length > 0 && (
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text color="cyan">Журнал cups (последние записи об ошибках)</Text>
          {diag.journal.map((l, i) => (
            <Text key={i} color="gray" dimColor>  {truncate(l, width - 8)}</Text>
          ))}
        </Box>
      )}

      <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
        <Text color="cyan">Выводы</Text>
        {diag.problems.length === 0
          ? <Text color="green">  ✓ проблем не найдено</Text>
          : diag.problems.map((p, i) => <Text key={i} color="yellow">  • {p}</Text>)}
      </Box>

      <Box paddingLeft={2}>
        <Text color="gray" dimColor>Enter — починить очередь · Q/Esc — назад</Text>
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

function isIpv4(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…';
}
