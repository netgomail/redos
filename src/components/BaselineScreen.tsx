import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { buildBaselineChecks, statusIcon, statusColor } from '../features/baseline';
import type { BaselineItem, CheckStatus, FixResult } from '../features/baseline';

interface Props {
  onExit: () => void;
}

export function BaselineScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const [checks] = useState<BaselineItem[]>(() => buildBaselineChecks());
  const [results, setResults] = useState<Map<string, CheckStatus>>(new Map());
  const [selected, setSelected] = useState(0);
  const [exported, setExported] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [fixMessages, setFixMessages] = useState<Map<string, FixResult>>(new Map());

  useEffect(() => {
    const map = new Map<string, CheckStatus>();
    for (const item of checks) {
      try { map.set(item.id, item.check()); }
      catch { map.set(item.id, 'unknown'); }
    }
    setResults(map);
    setRunning(false);
  }, [checks]);

  const categories = useMemo(
    () => [...new Set(checks.map(c => c.category))],
    [checks],
  );

  const stats = useMemo(() => {
    const values = [...results.values()];
    return {
      pass: values.filter(s => s === 'pass').length,
      fail: values.filter(s => s === 'fail').length,
      warn: values.filter(s => s === 'warn').length,
    };
  }, [results]);

  useInput((char, key) => {
    if (key.upArrow)   setSelected(i => Math.max(0, i - 1));
    if (key.downArrow) setSelected(i => Math.min(checks.length - 1, i + 1));

    if (char === 'q' || key.escape) { onExit(); return; }

    if (char === 'f' || char === 'F') {
      const item = checks[selected];
      if (!item?.fix) return;
      const status = results.get(item.id) ?? 'unknown';
      if (status === 'pass') return;

      const result = item.fix();
      let newStatus: CheckStatus;
      try { newStatus = item.check(); } catch { newStatus = 'unknown'; }

      setResults(prev => new Map(prev).set(item.id, newStatus));
      setFixMessages(prev => new Map(prev).set(item.id, result));
      return;
    }

    if (char === 'e') {
      const date = new Date().toISOString().slice(0, 10);
      const filename = `baseline-report-${date}.txt`;
      const lines: string[] = [
        '=== CIS Baseline — РедОС / RHEL ===',
        `Дата: ${new Date().toLocaleString('ru-RU')}`,
        `Хост: ${process.env.HOSTNAME ?? 'неизвестно'}`,
        '',
      ];

      for (const cat of categories) {
        lines.push(`── ${cat} ──`);
        for (const item of checks.filter(c => c.category === cat)) {
          const s = results.get(item.id) ?? 'unknown';
          lines.push(`  [${statusIcon(s)}] ${item.title}`);
          if (s !== 'pass') lines.push(`       Рекомендация: ${item.hint}`);
        }
        lines.push('');
      }

      lines.push(`Итого: ✓ ${stats.pass} пройдено  ✗ ${stats.fail} не пройдено  ⚠ ${stats.warn} предупреждений`);

      try {
        Bun.write(filename, lines.join('\n') + '\n');
        setExported(filename);
      } catch { setExported('Ошибка записи файла'); }
    }
  });

  const selectedItem   = checks[selected];
  const selectedStatus = selectedItem ? (results.get(selectedItem.id) ?? 'unknown') : 'unknown';
  const canFix         = !running && selectedItem?.fix !== undefined && selectedStatus !== 'pass';

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1} width={width}>
        <Text color="cyan" bold>◆  </Text>
        <Text bold>CIS Baseline — РедОС / RHEL  </Text>
        {running
          ? <Text color="gray">Проверяю...</Text>
          : <Text color="gray">
              <Text color="green">{`✓ ${stats.pass}`}</Text>
              <Text color="gray">  </Text>
              <Text color="red">{`✗ ${stats.fail}`}</Text>
              <Text color="gray">{`  ⚠ ${stats.warn}  из ${checks.length}`}</Text>
            </Text>
        }
      </Box>

      {categories.map(cat => (
        <Box key={cat} flexDirection="column" marginBottom={1}>
          <Box paddingLeft={2}>
            <Text color="cyan" bold>{`── ${cat} ──`}</Text>
          </Box>
          {checks.filter(c => c.category === cat).map((item) => {
            const globalIdx = checks.indexOf(item);
            const isSelected = globalIdx === selected;
            const status = results.get(item.id) ?? 'unknown';
            const icon = running ? '…' : statusIcon(status);
            const color = running ? 'gray' : statusColor(status);
            return (
              <Box key={item.id} paddingLeft={3}>
                <Text color={isSelected ? 'white' : 'gray'}>{isSelected ? '❯ ' : '  '}</Text>
                <Text color={color} bold={isSelected}>
                  {`[${icon}] `}
                </Text>
                <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                  {item.title}
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}

      {!running && selectedItem && (
        <Box flexDirection="column" marginBottom={1}>
          {selectedStatus !== 'pass' && (
            <Box paddingLeft={4}>
              <Text color="yellow">{'↳ '}</Text>
              <Text color="yellow">{selectedItem.hint}</Text>
            </Box>
          )}
          {(() => {
            const fix = fixMessages.get(selectedItem.id);
            if (!fix) return null;
            return fix.msg.split('\n').map((line, i) => (
              <Box key={i} paddingLeft={4}>
                <Text color={fix.ok ? 'green' : 'red'}>
                  {i === 0 ? (fix.ok ? '✓ ' : '✗ ') + line : '  ' + line}
                </Text>
              </Box>
            ));
          })()}
        </Box>
      )}

      {exported && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text color="green">{`✓ Отчёт сохранён: ${exported}`}</Text>
        </Box>
      )}

      <Box paddingLeft={2}>
        <Text color="gray" dimColor>
          {'↑↓ навигация  ·  E экспорт' + (canFix ? '  ·  F исправить' : '') + '  ·  Q/Esc выход'}
        </Text>
      </Box>
    </Box>
  );
}
