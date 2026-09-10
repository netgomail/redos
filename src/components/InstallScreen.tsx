import React, { useState, useRef, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Spinner } from './Spinner';
import { INSTALL_APPS, installApp, launchApp, hasGraphicalSession } from '../features/install';
import type { InstallApp, InstallResult } from '../features/install';

interface Props {
  onExit: () => void;
}

type Phase = 'list' | 'running' | 'result';

export function InstallScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const [phase, setPhase] = useState<Phase>('list');
  const [idx, setIdx] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);

  // Ink продолжает рисовать во время await, но обновлять state после ухода с
  // экрана нельзя — держим флаг живости (тот же приём, что в PrinterScreen).
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const app = INSTALL_APPS[idx];

  const step = (msg: string) => { if (alive.current) setLog(l => [...l, msg]); };
  const onProgress = (received: number, total: number) => {
    if (alive.current) setProgress({ received, total });
  };

  const runInstall = async (a: InstallApp) => {
    setLog([]);
    setProgress(null);
    setLaunchMsg(null);
    setPhase('running');
    const r = await installApp(a, step, onProgress);
    if (!alive.current) return;
    setResult(r);
    // Файл на диске — ещё не установленная программа: сама «установка»
    // (докачка недостающего с сервера обновлений) начинается только при
    // первом запуске stimrun, поэтому запускаем сразу, без отдельного шага.
    if (r.ok) {
      step('Запускаю...');
      const lr = launchApp(a);
      if (!alive.current) return;
      setLaunchMsg(lr.msg);
    }
    setPhase('result');
  };

  useInput((char, key) => {
    if (phase === 'running') return;
    const k = (c: string) => !key.ctrl && !key.meta && char.toLowerCase() === c;

    if (phase === 'result') {
      if (k('l') && result?.ok) {
        setLaunchMsg(launchApp(app).msg);
        return;
      }
      if (k('q') || key.escape || key.return) onExit();
      return;
    }

    // phase === 'list'
    if (k('q') || key.escape) { onExit(); return; }
    if (key.upArrow)   setIdx(i => Math.max(0, i - 1));
    if (key.downArrow) setIdx(i => Math.min(INSTALL_APPS.length - 1, i + 1));
    if (key.return)    runInstall(app);
  });

  if (phase === 'running') {
    return (
      <Frame width={width} subtitle={`установка · ${app.name}`}>
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          <Text color="gray">  • ставится в ~/{app.installSubdir}/</Text>
          <Text color="gray">  • права на ~/{app.installSubdir}/: rwxr-xr-x (запись — только владельцу)</Text>
          <Text color="gray">  • ярлык добавляется на рабочий стол и в меню приложений</Text>
          {app.ini && (
            <Text color="gray">  • сервер прописывается в ~/{app.installSubdir}/{app.ini.fileName}</Text>
          )}
        </Box>
        {progress && progress.total > 0 && (
          <Box paddingLeft={3} marginBottom={1}>
            <Text color="gray">{renderBar(progress.received, progress.total)}</Text>
          </Box>
        )}
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
        <Box paddingLeft={3} marginBottom={1}><Text bold>{app.name}</Text></Box>
        {result.msg.split('\n').map((l, i) => (
          <Box key={i} paddingLeft={3}>
            <Text color={i === 0 ? (result.ok ? 'green' : 'red') : 'gray'}>
              {i === 0 ? (result.ok ? '✓ ' : '✗ ') : '  '}{l}
            </Text>
          </Box>
        ))}
        {launchMsg && (
          <Box paddingLeft={3} marginTop={1}>
            <Text color={launchMsg.startsWith('Ошибка') || launchMsg.startsWith('Нет графической') ? 'yellow' : 'green'}>
              {launchMsg}
            </Text>
          </Box>
        )}
        <Box paddingLeft={2} marginTop={1}>
          <Text color="gray" dimColor>
            {result.ok && hasGraphicalSession() ? 'L — запустить снова · ' : ''}
            Q/Esc/Enter — назад
          </Text>
        </Box>
      </Frame>
    );
  }

  // phase === 'list'
  return (
    <Frame width={width} subtitle={`программ: ${INSTALL_APPS.length}`}>
      <Box paddingLeft={2}><Text color="cyan" bold>── Доступные программы ──</Text></Box>
      <Box flexDirection="column" marginBottom={1}>
        {INSTALL_APPS.map((a, i) => {
          const cur = i === idx;
          return (
            <Box key={a.id} flexDirection="column">
              <Box paddingLeft={2}>
                <Text color={cur ? 'white' : 'gray'}>{cur ? '❯ ' : '  '}</Text>
                <Text color={cur ? 'white' : 'gray'} bold={cur}>{a.name}</Text>
              </Box>
              {cur && (
                <Box paddingLeft={4}>
                  <Text color="gray" dimColor>{a.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      <Box paddingLeft={2}>
        <Text color="gray" dimColor>↑↓ выбор · Enter установить · Q/Esc выход</Text>
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
        <Text bold>Установка программ  </Text>
        <Text color="gray">{subtitle}</Text>
      </Box>
      {children}
    </Box>
  );
}

function renderBar(received: number, total: number, width = 22): string {
  const filled = Math.min(width, Math.floor((received / total) * width));
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const pct = Math.floor((received / total) * 100);
  return `Скачиваю [${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${pct}% (${mb(received)} / ${mb(total)} MB)`;
}
