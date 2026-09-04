import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Spinner } from './Spinner';
import {
  CATEGORIES, SELECTABLE_CATEGORIES, LOCKED_CATEGORIES,
  readStatus, listDevices, install, applyPolicy, removePolicy, removeLegacyUdev,
  readAppliedPolicy, describeDevice, describeInterfaces, describeKind, describeSize,
  allowedByCategories,
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
  | 'running'
  | 'result';

type Focus = 'categories' | 'devices' | 'actions';

/** Сколько строк устройств показывать разом. */
const DEV_ROWS = 8;

type ActionId = 'apply' | 'legacy' | 'remove' | 'refresh';
interface Action { id: ActionId; title: string; hint: string }

export function USBPolicyScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const [phase,   setPhase]   = useState<Phase>('loading');
  const [status,  setStatus]  = useState<GuardStatus | null>(null);
  const [devices, setDevices] = useState<GuardDevice[]>([]);

  // Выбираемые категории. Всегда разрешённые (LOCKED_CATEGORIES) сюда не
  // попадают — их добавляет генератор правил.
  const [allowed, setAllowed] = useState<Set<CategoryId>>(new Set());
  const [trusted, setTrusted] = useState<Set<string>>(new Set()); // ключ — hash или id:serial
  /**
   * Поимённые разрешения из уже применённой политики. Нужны, чтобы показать
   * их устройства в списке, даже если они сейчас не подключены: иначе
   * исключение исчезло бы молча, а невидимого состояния у экрана быть не должно.
   */
  const [appliedTrusted, setAppliedTrusted] = useState<TrustedDevice[]>([]);

  const [focus,     setFocus]     = useState<Focus>('categories');
  const [catIdx,    setCatIdx]    = useState(0);
  const [devIdx,    setDevIdx]    = useState(0);
  const [actionIdx, setActionIdx] = useState(0);

  const [log,      setLog]      = useState<string[]>([]);
  const [runTitle, setRunTitle] = useState('');
  const [result,   setResult]   = useState<{ ok: boolean; title: string; lines: string[] } | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /**
   * В списке только устройства, которые выбранные категории НЕ пропускают, —
   * то есть те, по которым решение ещё не принято. Разрешённое категорией
   * устройство показывать незачем: отметка «доверенное» для него ничего не
   * меняет, а строка сбивает с толку.
   */
  const connectedBlocked = devices.filter(d => !allowedByCategories(d, allowed));

  /**
   * Устройства из поимённых разрешений прошлой политики, которых сейчас нет в
   * портах. Показываем их наравне с подключёнными, иначе исключение пропало бы
   * незаметно для администратора.
   */
  const offlineTrusted: GuardDevice[] = appliedTrusted
    .filter(t => !devices.some(d => keyOf(d) === (t.hash || `${t.deviceId}:${t.serial}`)))
    .map(t => ({
      id: -1, target: 'block' as const,
      deviceId: t.deviceId, name: t.name, serial: t.serial, hash: t.hash,
      viaPort: '', interfaces: [], categories: [], uncategorized: true,
      offline: true,
    } as GuardDevice & { offline: true }));

  const managedDevices = [...connectedBlocked, ...offlineTrusted];

  const refresh = async () => {
    setPhase('loading');
    const st = await readStatus();
    if (!alive.current) return;
    setStatus(st);
    if (!st.installed) { setPhase('absent'); return; }

    const devs = await listDevices();
    if (!alive.current) return;
    setDevices(devs);
    setDevIdx(0);

    // Восстанавливаем текущий выбор из того, что реально разрешено сейчас:
    // если политика уже наша, показываем её состояние, а не умолчания.
    const applied = st.managed ? readAppliedPolicy() : null;
    if (applied) {
      // Читаем сами правила, а не список подключённых устройств: если веб-камера
      // сейчас не воткнута, категория всё равно разрешена, и галочка должна стоять.
      setAllowed(new Set(applied.allowed.filter(c => !LOCKED_CATEGORIES.includes(c))));
      setAppliedTrusted(applied.trusted);
      // Отметки показывают действующую политику: устройство, разрешённое
      // исключением, обязано выглядеть отмеченным. Иначе выходит, что
      // сохранение не сработало, хотя правило в файле есть.
      setTrusted(new Set(applied.trusted.map(t => t.hash || `${t.deviceId}:${t.serial}`)));
    } else {
      // Первое включение: разрешено всё. Администратор снимает отметки с того,
      // что нужно заблокировать, и только после этого применяет. Так включение
      // контроля само по себе ничего не ломает — блокировка всегда осознанная.
      setAllowed(new Set(SELECTABLE_CATEGORIES.map(c => c.id)));
      setAppliedTrusted([]);
      setTrusted(new Set());
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
    // Ровно то, что отмечено на экране, — ни больше, ни меньше
    const out: TrustedDevice[] = managedDevices
      .filter(d => trusted.has(keyOf(d)))
      .map(d => ({ deviceId: d.deviceId, serial: d.serial, name: describeDevice(d), hash: d.hash }));

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
    finish(r.ok, 'Контроль устройств', r.msg.split('\n'));
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
      case 'apply': doApply(); break;
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

    // phase === 'view'
    if (k('q') || key.escape) { onExit(); return; }
    if (key.tab) {
      setFocus(f => f === 'categories' ? (managedDevices.length ? 'devices' : 'actions')
                  : f === 'devices'    ? 'actions'
                  :                      'categories');
      return;
    }

    if (focus === 'categories') {
      if (key.upArrow)   setCatIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setCatIdx(i => Math.min(SELECTABLE_CATEGORIES.length - 1, i + 1));
      if (char === ' ') {
        const c = SELECTABLE_CATEGORIES[catIdx];
        if (!c) return;
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
      if (key.downArrow) setDevIdx(i => Math.min(Math.max(0, managedDevices.length - 1), i + 1));
      if (char === ' ') {
        const d = managedDevices[devIdx];
        if (!d) return;
        const key2 = keyOf(d);
        setTrusted(prev => {
          const next = new Set(prev);
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

  // ── основной экран ──────────────────────────────────────────────────────────

  const st = status!;
  const blocked = devices.filter(d => d.target !== 'allow').length;
  // Окно прокрутки: держим выбранную строку внутри видимой части
  const devStart = Math.max(0, Math.min(
    devIdx - Math.floor(DEV_ROWS / 2),
    managedDevices.length - DEV_ROWS));
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

      <Box paddingLeft={2}><Text color="cyan" bold>── Категории устройств ──</Text></Box>
      <Box paddingLeft={3} marginBottom={1}>
        <Text color="gray" dimColor>
          {'Space — переключить: [✓] разрешить · [✗] заблокировать.  Всегда разрешены: ' +
            CATEGORIES.filter(c => c.locked).map(c => c.title.toLowerCase()).join(', ')}
        </Text>
      </Box>
      {SELECTABLE_CATEGORIES.map((c, i) => {
        const cur = focus === 'categories' && i === catIdx;
        const on  = allowed.has(c.id);
        return (
          <Box key={c.id} paddingLeft={2}>
            <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
            {/* Как и в списке устройств: флажок и есть решение */}
            <Text color={on ? 'green' : 'red'} bold>{on ? '[✓] ' : '[✗] '}</Text>
            <Text color={cur ? 'white' : 'gray'} bold={cur}>{c.title.padEnd(22)}</Text>
            <Text color="gray" dimColor>{truncate(c.hint, Math.max(10, width - 34))}</Text>
          </Box>
        );
      })}

      <Box paddingLeft={2} marginTop={1}>
        <Text color="cyan" bold>── Исключения: разрешить устройство поимённо ──</Text>
        <Text color="gray" dimColor>  Space — разрешить. Блокировка задаётся категориями выше</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="gray" dimColor>
          {/* ширины те же, что у строк ниже, иначе колонки разъедутся */}
          {'  ' + '    ' + 'статус'.padEnd(11) + 'ид.'.padEnd(10) + ' ' +
           'устройство'.padEnd(26) + 'тип'.padEnd(17) + 'размер ~'.padEnd(11) + 'узел'}
        </Text>
      </Box>
      {managedDevices.length === 0 ? (
        <Box paddingLeft={3}>
          <Text color="gray" dimColor>
            {!st.serviceActive ? 'демон остановлен — список пуст'
             : devices.length  ? 'выбранные категории пропускают всё, что сейчас подключено'
             :                   'usbguard не отдал список'}
          </Text>
        </Box>
      ) : <>
      {devStart > 0 && (
        <Box paddingLeft={4}><Text color="gray" dimColor>↑ выше ещё {devStart}</Text></Box>
      )}
      {managedDevices.slice(devStart, devStart + DEV_ROWS).map((d, vi) => {
        const i = devStart + vi;
        const cur = focus === 'devices' && i === devIdx;
        const tr  = trusted.has(keyOf(d));
        // Блочный узел важнее класса: картридер с вендорским классом — такой же
        // канал утечки, как флешка, и админ должен это видеть.
        const offline = (d as GuardDevice & { offline?: boolean }).offline === true;
        const nodes = offline ? 'не подключено'
                    : d.storageNodes?.length ? d.storageNodes.map(n => '/dev/' + n).join(' ') : '—';
        const size  = describeSize(d);
        // Тип — как в инвентаризации: «USB-флешка», «USB-накопитель». Для
        // не-накопителей вместо типа показываем категорию, а для устройств
        // вне категорий — классы интерфейсов словами.
        const kind = describeKind(d);
        return (
          <Box key={keyOf(d) + i} paddingLeft={2}>
            <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
            {/* Здесь устройства только разрешают: блокировка задаётся
                категориями выше. Поэтому неотмеченное — просто пустой флажок,
                без красного креста: оно не «запрещено этим списком», а всего
                лишь не внесено в исключения. */}
            <Text color={tr ? 'green' : 'gray'} bold={tr}>{tr ? '[✓] ' : '[ ] '}</Text>
            <Text color={tr ? 'green' : 'gray'} dimColor={!tr}>
              {(tr ? 'разрешено' : '').padEnd(11)}
            </Text>
            <Text color={cur ? 'white' : 'gray'} bold={cur}>
              {(d.deviceId || '—').padEnd(10)} {truncate(describeDevice(d), 25).padEnd(26)}
            </Text>
            <Text color={d.uncategorized ? 'yellow' : 'gray'} dimColor={!d.uncategorized}>
              {truncate(kind, 16).padEnd(17)}
            </Text>
            <Text color={size.stale ? 'yellow' : 'gray'} dimColor={!size.stale}>
              {truncate(size.stale ? size.text + ' ~' : size.text, 10).padEnd(11)}
            </Text>
            <Text color={offline ? 'yellow' : nodes === '—' ? 'gray' : 'red'} dimColor={nodes === '—'}>
              {nodes}
            </Text>
          </Box>
        );
      })}
      {devStart + DEV_ROWS < managedDevices.length && (
        <Box paddingLeft={4}>
          <Text color="gray" dimColor>↓ ниже ещё {managedDevices.length - devStart - DEV_ROWS}</Text>
        </Box>
      )}
      </>}

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
           : focus === 'devices'  ? '↑↓ выбор · Space разрешить устройство · Tab к действиям · Q выход'
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
