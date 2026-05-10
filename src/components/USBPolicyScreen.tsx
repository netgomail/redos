import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import {
  RULES_FILE,
  readPolicy, applyBlockPolicy, removePolicy, listUsbBlockDevices,
} from '../features/usbPolicy';
import type { Policy, UsbDevice, AllowedDevice } from '../features/usbPolicy';
import type { FixResult } from '../utils/sudo';

interface Props {
  onExit: () => void;
}

type Phase = 'loading' | 'view' | 'result';

export function USBPolicyScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const [phase,   setPhase]   = useState<Phase>('loading');
  const [policy,  setPolicy]  = useState<Policy>({ mode: 'open', allowed: [] });
  const [devices, setDevices] = useState<UsbDevice[]>([]);
  // имена «trusted» — ключ vendor:product:serial; новые отметки добавляются сюда
  const [trustKeys, setTrustKeys] = useState<Set<string>>(new Set());

  const [actionIdx, setActionIdx]   = useState(0);
  const [deviceIdx, setDeviceIdx]   = useState(0);
  const [focus,     setFocus]       = useState<'devices' | 'actions'>('devices');

  const [resultTitle, setResultTitle] = useState('');
  const [resultMsg,   setResultMsg]   = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = async () => {
    const pol = readPolicy();
    setPolicy(pol);
    setTrustKeys(new Set(pol.allowed.map(keyOf)));
    const list = await listUsbBlockDevices(pol.allowed);
    setDevices(list);
    if (list.length > 0 && deviceIdx >= list.length) setDeviceIdx(0);
    setPhase('view');
  };

  useEffect(() => {
    refresh();
  }, []);

  const isPolicyActive = policy.mode === 'blocked';
  const actions = isPolicyActive
    ? ['Заблокировать всё кроме отмеченных', 'Снять блокировку (разрешить все USB)']
    : ['Заблокировать всё кроме отмеченных'];

  // Объединённый список: подключённые сейчас + orphan-доверенные (в trustKeys, но не подключены).
  // Навигация и Space работают по этому общему индексу.
  const allItems = useMemo(() => {
    const present = new Set(devices.map(keyOf));
    const connected = devices.map(d => ({
      kind: 'connected' as const,
      key:   keyOf(d),
      vendor:  d.vendor,
      product: d.product,
      serial:  d.serial,
      device:  d as UsbDevice | null,
    }));
    const orphans = policy.allowed
      .filter(a => !present.has(keyOf(a)))
      .map(a => ({
        kind: 'orphan' as const,
        key:   keyOf(a),
        vendor:  a.vendor,
        product: a.product,
        serial:  a.serial,
        device:  null,
        label:   a.label,
      }));
    return [...connected, ...orphans];
  }, [devices, policy]);

  // ── обработчики действий ───────────────────────────────────────────────────

  const buildAllowedFromState = (): AllowedDevice[] => {
    // отмеченные подключённые устройства
    const fromDevices: AllowedDevice[] = devices
      .filter(d => trustKeys.has(keyOf(d)))
      .map(d => ({
        vendor:  d.vendor,
        product: d.product,
        serial:  d.serial,
        label:   describeDevice(d),
      }));
    // orphan'ы: были в политике, не подключены, и пользователь оставил их в trustKeys
    const presentKeys = new Set(devices.map(keyOf));
    const fromPolicy: AllowedDevice[] = policy.allowed
      .filter(a => !presentKeys.has(keyOf(a)) && trustKeys.has(keyOf(a)));
    return [...fromDevices, ...fromPolicy];
  };

  const toggleAt = (idx: number) => {
    const item = allItems[idx];
    if (!item) return;
    setTrustKeys(prev => {
      const next = new Set(prev);
      if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
      return next;
    });
  };

  const doApply = () => {
    const allowed = buildAllowedFromState();
    const r = applyBlockPolicy(allowed);
    showResult('Применение политики', r);
  };

  const doRemove = () => {
    const r = removePolicy();
    showResult('Снятие блокировки', r);
  };

  const showResult = (title: string, r: FixResult) => {
    setResultTitle(title);
    setResultMsg({ ok: r.ok, text: r.msg });
    setPhase('result');
  };

  // ── ввод ────────────────────────────────────────────────────────────────────

  useInput((char, key) => {
    if (phase === 'loading') return;

    if (phase === 'result') {
      if (char === 'q' || key.escape || key.return) {
        setPhase('loading');
        refresh();
      }
      return;
    }

    // phase === 'view'
    if (char === 'q' || key.escape) { onExit(); return; }

    if (key.tab) {
      setFocus(f => f === 'devices' ? 'actions' : 'devices');
      return;
    }

    if (focus === 'devices') {
      if (allItems.length === 0) {
        if (key.upArrow || key.downArrow) setFocus('actions');
        return;
      }
      if (key.upArrow) {
        if (deviceIdx === 0) setFocus('actions');
        else setDeviceIdx(i => Math.max(0, i - 1));
      }
      if (key.downArrow) {
        if (deviceIdx === allItems.length - 1) setFocus('actions');
        else setDeviceIdx(i => Math.min(allItems.length - 1, i + 1));
      }
      if (char === ' ') toggleAt(deviceIdx);
      return;
    }

    // focus === 'actions'
    if (key.upArrow) {
      if (actionIdx === 0 && allItems.length > 0) {
        setFocus('devices');
        setDeviceIdx(allItems.length - 1);
      } else {
        setActionIdx(i => Math.max(0, i - 1));
      }
    }
    if (key.downArrow) setActionIdx(i => Math.min(actions.length - 1, i + 1));
    if (key.return) {
      const a = actions[actionIdx];
      if (a.startsWith('Снять блокировку')) doRemove();
      else doApply();
    }
  });

  // ── фаза loading ────────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <Box flexDirection="column" width={width}>
        <Header width={width} subtitle="загрузка..." />
        <Box paddingLeft={3}><Text color="gray">Считываю lsblk и udev...</Text></Box>
      </Box>
    );
  }

  // ── фаза result ─────────────────────────────────────────────────────────────

  if (phase === 'result') {
    return (
      <Box flexDirection="column" width={width}>
        <Header width={width} subtitle="Результат" />
        <Box paddingLeft={3} marginBottom={1}>
          <Text bold>{resultTitle}</Text>
        </Box>
        {resultMsg && (
          <Box paddingLeft={3} marginBottom={1}>
            <Text color={resultMsg.ok ? 'green' : 'red'}>
              {(resultMsg.ok ? '✓ ' : '✗ ') + resultMsg.text}
            </Text>
          </Box>
        )}
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>Q/Esc/Enter — назад</Text>
        </Box>
      </Box>
    );
  }

  // ── фаза view ───────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" width={width}>
      <Header
        width={width}
        subtitle={isPolicyActive
          ? `заблокировано · ${policy.allowed.length} доверенных · ${RULES_FILE}`
          : 'нет блокировки (все USB-накопители монтируются)'}
      />

      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text color="cyan" bold>── USB-накопители — отметьте доверенные ──</Text>
        </Box>
        <Box paddingLeft={3} marginBottom={1}>
          <Text color="gray" dimColor>
            После применения политики: отмеченные — доступны, остальные — заблокированы
          </Text>
        </Box>
        {allItems.length === 0 ? (
          <Box paddingLeft={3}>
            <Text color="gray" dimColor>устройств нет — подключите USB-накопитель и переоткройте /usb-policy</Text>
          </Box>
        ) : (
          allItems.map((it, i) => {
            const isCur = focus === 'devices' && i === deviceIdx;
            const isSel = trustKeys.has(it.key);
            const d = it.device;
            const left = it.kind === 'connected' && d
              ? `/dev/${d.block}`.padEnd(11) + ' ' + (d.size || '').padEnd(8)
              : '(не подключён)'.padEnd(20);
            const name = it.kind === 'connected' && d
              ? (d.modelLabel || d.productName || '')
              : (it.kind === 'orphan' ? (it.label || '—') : '—');
            return (
              <Box key={it.key} paddingLeft={2}>
                <Text color={isCur ? 'white' : 'gray'}>{isCur ? '❯ ' : '  '}</Text>
                <Text color={isSel ? 'green' : 'red'}>{isSel ? '[✓] доверен   ' : '[ ] блокировка'}</Text>
                <Text color={isCur ? 'white' : 'gray'} bold={isCur}> {left} </Text>
                <Text color={isCur ? 'white' : 'gray'} dimColor={it.kind === 'orphan'}>
                  {name.padEnd(28)}
                </Text>
                <Text color="gray" dimColor>
                  {`${it.vendor}:${it.product} S/N ${it.serial}`}
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text color="cyan" bold>── Действия ──</Text>
        </Box>
        {actions.map((a, i) => {
          const isCur = focus === 'actions' && i === actionIdx;
          return (
            <Box key={a} paddingLeft={3}>
              <Text color={isCur ? 'white' : 'gray'}>{isCur ? '❯ ' : '  '}</Text>
              <Text color={isCur ? 'white' : 'gray'} bold={isCur}>{a}</Text>
            </Box>
          );
        })}
      </Box>

      <Box paddingLeft={2}>
        <Text color="gray" dimColor>
          {focus === 'devices'
            ? '↑↓ переход · Space — отметить как доверенное · Tab к действиям · Q/Esc выход'
            : '↑↓ переход · Enter применить · Tab к устройствам · Q/Esc выход'}
        </Text>
      </Box>
    </Box>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function keyOf(d: { vendor: string; product: string; serial: string }): string {
  return `${d.vendor}:${d.product}:${d.serial}`;
}

function describeDevice(d: UsbDevice): string {
  const name = d.modelLabel || d.productName || '(USB-накопитель)';
  return `${name} (${d.vendor}:${d.product}, S/N=${d.serial})`;
}

function Header({ width, subtitle }: { width: number; subtitle: string }) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1} width={width}>
      <Text color="cyan" bold>◆  </Text>
      <Text bold>USB-накопители  </Text>
      <Text color="gray">{subtitle}</Text>
    </Box>
  );
}
