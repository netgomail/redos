import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Spinner } from './Spinner';
import {
  CATEGORIES,
  readStatus, listDevices, install, applyPolicy, removePolicy, removeLegacyUdev,
} from '../features/usbGuard';
import type {
  CategoryId, GuardStatus, GuardDevice, TrustedDevice,
} from '../features/usbGuard';

interface Props {
  onExit: () => void;
}

type Phase =
  | 'loading'
  | 'absent'    // usbguard не установлен
  | 'view'
  | 'confirm'   // подтверждение опасного применения
  | 'running'
  | 'result';

type Focus = 'categories' | 'devices' | 'actions';

type ActionId = 'apply' | 'legacy' | 'remove' | 'refresh';
interface Action { id: ActionId; title: string; hint: string }

export function USBPolicyScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const [phase,   setPhase]   = useState<Phase>('loading');
  const [status,  setStatus]  = useState<GuardStatus | null>(null);
  const [devices, setDevices] = useState<GuardDevice[]>([]);

  // Разрешённые категории по умолчанию. Хабы и криптотокены разрешены
  // принудительно (locked). Ввод — иначе машина останется без управления.
  // Смарт-карты — там же живут CCID-модели Рутокена, а каналом утечки
  // считыватель смарт-карт не является.
  const [allowed, setAllowed] = useState<Set<CategoryId>>(
    new Set(['hub', 'token', 'input', 'smartcard']));
  const [trusted, setTrusted] = useState<Set<string>>(new Set()); // ключ — hash или id:serial

  const [focus,     setFocus]     = useState<Focus>('categories');
  const [catIdx,    setCatIdx]    = useState(0);
  const [devIdx,    setDevIdx]    = useState(0);
  const [actionIdx, setActionIdx] = useState(0);

  const [log,      setLog]      = useState<string[]>([]);
  const [runTitle, setRunTitle] = useState('');
  const [result,   setResult]   = useState<{ ok: boolean; title: string; lines: string[] } | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = async () => {
    setPhase('loading');
    const st = await readStatus();
    if (!alive.current) return;
    setStatus(st);
    if (!st.installed) { setPhase('absent'); return; }

    const devs = await listDevices();
    if (!alive.current) return;
    setDevices(devs);

    // Восстанавливаем текущий выбор из того, что реально разрешено сейчас:
    // если политика уже наша, показываем её состояние, а не умолчания.
    if (st.managed) {
      const live = new Set<CategoryId>(['hub']);
      for (const d of devs) {
        if (d.target === 'allow') d.categories.forEach(c => live.add(c));
      }
      setAllowed(live);
      setTrusted(new Set(devs.filter(d => d.target === 'allow' && d.uncategorized).map(keyOf)));
    }
    setPhase('view');
  };

  useEffect(() => { refresh(); }, []);

  const actions: Action[] = [
    { id: 'apply',   title: status?.managed ? 'Применить изменения' : 'Включить контроль устройств',
      hint: 'записать правила, запустить usbguard и проверить, что ввод не отвалился' },
    ...(status?.legacyUdev
      ? [{ id: 'legacy' as ActionId, title: 'Убрать правила прошлой версии',
           hint: `${status.legacyUdev.file} — udev-политика старого образца, она больше не действует` }]
      : []),
    ...(status?.managed || status?.serviceActive
      ? [{ id: 'remove' as ActionId, title: 'Снять контроль устройств',
           hint: 'остановить usbguard и вернуть авторизацию всем устройствам' }]
      : []),
    { id: 'refresh', title: 'Обновить', hint: 'перечитать состояние и список устройств' },
  ];

  // ── операции ────────────────────────────────────────────────────────────────

  const startRun = (title: string) => { setRunTitle(title); setLog([]); setPhase('running'); };
  const step = (m: string) => { if (alive.current) setLog(l => [...l.slice(-14), m]); };

  const finish = (ok: boolean, title: string, lines: string[]) => {
    if (!alive.current) return;
    setResult({ ok, title, lines });
    setPhase('result');
  };

  const doInstall = async () => {
    startRun('Установка usbguard');
    const r = await install(step);
    finish(r.ok, 'Установка usbguard', [r.msg]);
  };

  const buildTrusted = (): TrustedDevice[] => {
    const out: TrustedDevice[] = devices
      .filter(d => trusted.has(keyOf(d)))
      .map(d => ({ deviceId: d.deviceId, serial: d.serial, name: d.name, hash: d.hash }));

    // Устройства из старой udev-политики: хеша у них нет, опознаём по id+serial
    for (const a of status?.legacyUdev?.allowed ?? []) {
      const id = `${a.vendor}:${a.product}`;
      if (out.some(t => t.deviceId === id && t.serial === a.serial)) continue;
      out.push({ deviceId: id, serial: a.serial, name: a.label ?? 'из прошлой политики', hash: '' });
    }
    return out;
  };

  const doApply = async () => {
    startRun('Применение политики');
    const r = await applyPolicy({ allowed: [...allowed], trusted: buildTrusted() }, step);
    const lines = [r.msg];
    if (r.rolledBack) lines.push('', 'Система осталась в прежнем состоянии.');
    finish(r.ok, 'Контроль устройств', lines);
  };

  const doRemove = async () => {
    startRun('Снятие политики');
    const r = await removePolicy(step);
    finish(r.ok, 'Контроль устройств', [r.msg]);
  };

  const doLegacy = () => {
    const r = removeLegacyUdev();
    finish(r.ok, 'Правила прошлой версии', [
      r.msg,
      ...(status?.legacyUdev?.allowed.length
        ? ['', `Доверенные устройства из неё (${status.legacyUdev.allowed.length}) перенесены в политику USBGuard.`]
        : []),
    ]);
  };

  const runAction = (a: Action) => {
    switch (a.id) {
      case 'apply':
        // Отключение ввода — единственное, что может оставить машину без
        // управления. Спрашиваем отдельно, остальное применяем сразу.
        if (!allowed.has('input')) setPhase('confirm');
        else doApply();
        break;
      case 'legacy':  doLegacy(); break;
      case 'remove':  doRemove(); break;
      case 'refresh': refresh();  break;
    }
  };

  // ── ввод ────────────────────────────────────────────────────────────────────

  useInput((char, key) => {
    if (phase === 'loading' || phase === 'running') return;
    // Ink отдаёт управляющие символы как обычные буквы с выставленным ctrl.
    const k = (c: string) => !key.ctrl && !key.meta && char.toLowerCase() === c;

    if (phase === 'result') { if (k('q') || key.escape || key.return) refresh(); return; }

    if (phase === 'absent') {
      if (k('q') || key.escape) { onExit(); return; }
      if (key.return) doInstall();
      return;
    }

    if (phase === 'confirm') {
      if (k('q') || key.escape) { setPhase('view'); return; }
      if (k('d')) doApply();
      return;
    }

    // phase === 'view'
    if (k('q') || key.escape) { onExit(); return; }
    if (key.tab) {
      setFocus(f => f === 'categories' ? (devices.length ? 'devices' : 'actions')
                  : f === 'devices'    ? 'actions'
                  :                      'categories');
      return;
    }

    if (focus === 'categories') {
      if (key.upArrow)   setCatIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setCatIdx(i => Math.min(CATEGORIES.length - 1, i + 1));
      if (char === ' ') {
        const c = CATEGORIES[catIdx];
        if (c.locked) return;
        setAllowed(prev => {
          const next = new Set(prev);
          if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
          return next;
        });
      }
      return;
    }

    if (focus === 'devices') {
      if (key.upArrow)   setDevIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setDevIdx(i => Math.min(Math.max(0, devices.length - 1), i + 1));
      if (char === ' ') {
        const d = devices[devIdx];
        if (!d) return;
        setTrusted(prev => {
          const next = new Set(prev);
          const key2 = keyOf(d);
          if (next.has(key2)) next.delete(key2); else next.add(key2);
          return next;
        });
      }
      return;
    }

    if (key.upArrow)   setActionIdx(i => Math.max(0, i - 1));
    if (key.downArrow) setActionIdx(i => Math.min(actions.length - 1, i + 1));
    if (key.return)    runAction(actions[actionIdx]);
  });

  // ── экраны ──────────────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <Frame width={width} subtitle="чтение состояния">
        <Box paddingLeft={3}><Spinner /><Text color="gray"> Опрашиваю usbguard...</Text></Box>
      </Frame>
    );
  }

  if (phase === 'running') {
    return (
      <Frame width={width} subtitle={runTitle}>
        {log.map((l, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={i === log.length - 1 ? 'white' : 'gray'} dimColor={i !== log.length - 1}>
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
        <Box paddingLeft={3} marginBottom={1}><Text bold>{result.title}</Text></Box>
        {result.lines.map((l, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={i === 0 ? (result.ok ? 'green' : 'red') : 'gray'}>
              {i === 0 ? (result.ok ? '✓ ' : '✗ ') : '  '}{l}
            </Text>
          </Box>
        ))}
        <Box paddingLeft={2} marginTop={1}><Text color="gray" dimColor>Q/Esc/Enter — назад</Text></Box>
      </Frame>
    );
  }

  if (phase === 'absent') {
    return (
      <Frame width={width} subtitle="usbguard не установлен">
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text>Контроль устройств работает на USBGuard — он запрещает устройства</Text>
          <Text>на уровне ядра: неавторизованная флешка не создаёт /dev/sdX,</Text>
          <Text>и смонтировать её не сможет даже root.</Text>
          <Text> </Text>
          <Text color="gray">Пакет есть в штатном репозитории РЕД ОС:</Text>
          <Text color="cyan">  dnf install usbguard</Text>
        </Box>
        <Box paddingLeft={2}><Text color="gray" dimColor>Enter — установить · Q/Esc — выход</Text></Box>
      </Frame>
    );
  }

  if (phase === 'confirm') {
    return (
      <Frame width={width} subtitle="подтверждение">
        <Box paddingLeft={3} marginBottom={1}>
          <Text bold color="red">Категория «Клавиатуры и мыши» не разрешена</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text color="gray">USB-клавиатура и мышь после применения будут заблокированы.</Text>
          <Text color="gray">Если других устройств ввода нет, вы потеряете управление машиной.</Text>
          <Text> </Text>
          <Text color="gray">Утилита проверит состояние после применения и откатит политику,</Text>
          <Text color="gray">если ввод пропадёт, — но полагаться на это как на единственную</Text>
          <Text color="gray">защиту не стоит.</Text>
        </Box>
        <Box paddingLeft={2}><Text color="gray" dimColor>D — всё равно применить · Q/Esc — вернуться</Text></Box>
      </Frame>
    );
  }

  // ── основной экран ──────────────────────────────────────────────────────────

  const st = status!;
  const blocked = devices.filter(d => d.target !== 'allow').length;
  const subtitle = [
    st.version || 'usbguard',
    st.serviceActive ? (st.managed ? 'политика redos активна' : 'работает чужая политика') : 'демон остановлен',
    `устройств: ${devices.length}${blocked ? `, заблокировано ${blocked}` : ''}`,
  ].join(' · ');

  return (
    <Frame width={width} subtitle={subtitle}>
      {st.legacyUdev && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color="yellow">! </Text>
          <Text color="yellow">
            Найдены правила прошлой версии ({st.legacyUdev.allowed.length} доверенных) — они больше не действуют
          </Text>
        </Box>
      )}

      <Box paddingLeft={2}><Text color="cyan" bold>── Разрешённые категории ──</Text></Box>
      <Box paddingLeft={3} marginBottom={1}>
        <Text color="gray" dimColor>всё, что не разрешено, блокируется на уровне ядра</Text>
      </Box>
      {CATEGORIES.map((c, i) => {
        const cur = focus === 'categories' && i === catIdx;
        const on  = allowed.has(c.id) || !!c.locked;
        return (
          <Box key={c.id} paddingLeft={2}>
            <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
            <Text color={c.locked ? 'gray' : on ? 'green' : 'red'}>
              {c.locked ? '[✓]' : on ? '[✓]' : '[ ]'}
            </Text>
            <Text color={cur ? 'white' : 'gray'} bold={cur}> {c.title.padEnd(22)}</Text>
            <Text color={c.risky && !on ? 'red' : 'gray'} dimColor={!c.risky}>
              {truncate(c.locked ? 'всегда разрешены — ' + c.hint : c.hint, Math.max(10, width - 34))}
            </Text>
          </Box>
        );
      })}

      <Box paddingLeft={2} marginTop={1}><Text color="cyan" bold>── Подключённые устройства ──</Text></Box>
      <Box paddingLeft={3} marginBottom={1}>
        <Text color="gray" dimColor>
          Space — сделать доверенным. Красным помечены блочные узлы: такое устройство — канал утечки
        </Text>
      </Box>
      {devices.length === 0 ? (
        <Box paddingLeft={3}>
          <Text color="gray" dimColor>
            {st.serviceActive ? 'usbguard не отдал список' : 'демон остановлен — список пуст'}
          </Text>
        </Box>
      ) : devices.slice(0, 8).map((d, i) => {
        const cur = focus === 'devices' && i === devIdx;
        const tr  = trusted.has(keyOf(d));
        // Блочный узел важнее класса: картридер с вендорским классом — такой же
        // канал утечки, как флешка, и админ должен это видеть.
        const nodes = d.storageNodes?.length ? d.storageNodes.map(n => '/dev/' + n).join(' ') : '';
        const cats = d.categories.length
          ? d.categories.map(c => CATEGORIES.find(x => x.id === c)?.title ?? c).join(', ')
          : nodes ? 'накопитель, вендорский класс' : 'вне категорий';
        return (
          <Box key={keyOf(d) + i} paddingLeft={2}>
            <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
            <Text color={tr ? 'green' : 'gray'}>{tr ? '[✓]' : '[ ]'}</Text>
            <Text color={d.target === 'allow' ? 'green' : 'red'}>
              {d.target === 'allow' ? ' разрешено ' : ' заблок.   '}
            </Text>
            <Text color={cur ? 'white' : 'gray'} bold={cur}>
              {(d.deviceId || '—').padEnd(10)} {truncate(d.name || '(без имени)', 22).padEnd(22)}
            </Text>
            <Text color={d.uncategorized ? 'yellow' : 'gray'} dimColor={!d.uncategorized}>
              {d.uncategorized ? '⚠ ' : ''}{truncate(cats, Math.max(8, width - 64))}
            </Text>
            {nodes !== '' && <Text color="red"> {nodes}</Text>}
          </Box>
        );
      })}
      {devices.length > 8 && (
        <Box paddingLeft={5}><Text color="gray" dimColor>…и ещё {devices.length - 8}</Text></Box>
      )}

      <Box paddingLeft={2} marginTop={1}><Text color="cyan" bold>── Действия ──</Text></Box>
      {actions.map((a, i) => {
        const cur = focus === 'actions' && i === actionIdx;
        return (
          <Box key={a.id} paddingLeft={3}>
            <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
            <Text color={cur ? 'white' : 'gray'} bold={cur}>{a.title}</Text>
          </Box>
        );
      })}
      <Box paddingLeft={5} marginTop={1}>
        <Text color="gray" dimColor>{truncate(actions[actionIdx]?.hint ?? '', width - 8)}</Text>
      </Box>

      <Box paddingLeft={2} marginTop={1}>
        <Text color="gray" dimColor>
          {focus === 'categories' ? '↑↓ выбор · Space разрешить/запретить · Tab к устройствам · Q выход'
           : focus === 'devices'  ? '↑↓ выбор · Space доверенное · Tab к действиям · Q выход'
           :                        '↑↓ выбор · Enter выполнить · Tab к категориям · Q выход'}
        </Text>
      </Box>
    </Frame>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Хеш дескриптора — самый надёжный ключ; если его нет, годится id+serial. */
function keyOf(d: GuardDevice): string {
  return d.hash || `${d.deviceId}:${d.serial}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…';
}

function Frame({ width, subtitle, children }: {
  width: number; subtitle: string; children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1} width={width}>
        <Text color="cyan" bold>◆  </Text>
        <Text bold>Контроль устройств  </Text>
        <Text color="gray">{truncate(subtitle, Math.max(10, width - 26))}</Text>
      </Box>
      {children}
    </Box>
  );
}
