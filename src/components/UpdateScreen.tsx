import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Spinner } from './Spinner';
import { checkLatestVersion, selfUpdate } from '../utils/update';
import { version as VERSION } from '../../package.json';

interface Props {
  // installedVersion передаётся только при успешном обновлении — родитель
  // покажет напоминание о перезапуске в чате и в шапке.
  onExit: (installedVersion?: string) => void;
}

type Phase = 'checking' | 'none' | 'confirm' | 'running' | 'result';

export function UpdateScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const [phase, setPhase] = useState<Phase>('checking');
  const [latest, setLatest] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Тот же приём, что в PrinterScreen/InstallScreen: не обновлять state после
  // ухода с экрана (await селфапдейта может завершиться уже после onExit).
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    checkLatestVersion().then(r => {
      if (!alive.current) return;
      if (r?.hasUpdate) { setLatest(r.latest); setPhase('confirm'); }
      else setPhase('none');
    }).catch(() => { if (alive.current) setPhase('none'); });
  }, []);

  const step = (msg: string) => { if (alive.current) setLog(l => [...l, msg]); };
  const onProgress = (received: number, total: number) => {
    if (alive.current) setProgress({ received, total });
  };

  const runUpdate = async () => {
    setLog([]);
    setProgress(null);
    setPhase('running');
    const r = await selfUpdate(step, onProgress);
    if (!alive.current) return;
    setResult(r);
    setPhase('result');
  };

  const success = result?.startsWith('Обновлено') ?? false;
  const isError = result?.startsWith('Ошибка') ?? false;

  useInput((char, key) => {
    if (phase === 'checking' || phase === 'running') return;
    const k = (c: string) => !key.ctrl && !key.meta && char.toLowerCase() === c;

    if (phase === 'confirm') {
      if (k('y') || key.return) { runUpdate(); return; }
      if (k('n') || key.escape || k('q')) onExit();
      return;
    }

    if (phase === 'none') {
      if (k('q') || key.escape || key.return) onExit();
      return;
    }

    // phase === 'result'
    // Бинарник на диске уже подменён (rename), но текущий процесс всё ещё
    // работает со старым inode — новая версия применится только после
    // перезапуска. Само приложение не закрываем, просто передаём наверх
    // версию, чтобы показать напоминание в чате и в шапке.
    if (k('q') || key.escape || key.return) onExit(success ? (latest ?? undefined) : undefined);
  });

  if (phase === 'checking') {
    return (
      <Frame width={width} subtitle="проверка">
        <Box paddingLeft={3} marginBottom={1}>
          <Spinner /><Text color="gray"> проверяю обновления...</Text>
        </Box>
      </Frame>
    );
  }

  if (phase === 'none') {
    return (
      <Frame width={width} subtitle="актуальная версия">
        <Box paddingLeft={3} marginBottom={1}>
          <Text color="green">✓ Уже установлена последняя версия v{VERSION}</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>Q/Esc/Enter — назад</Text>
        </Box>
      </Frame>
    );
  }

  if (phase === 'confirm') {
    return (
      <Frame width={width} subtitle="найдено обновление">
        <Box paddingLeft={3} marginBottom={1}>
          <Text color="yellow" bold>↑ Доступно обновление: v{VERSION} → v{latest}</Text>
        </Box>
        <Box paddingLeft={3} marginBottom={1}>
          <Text color="gray">Скачать и установить сейчас?</Text>
        </Box>
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>Y/Enter — обновить · N/Esc — отмена</Text>
        </Box>
      </Frame>
    );
  }

  if (phase === 'running') {
    return (
      <Frame width={width} subtitle={`обновление · v${VERSION} → v${latest}`}>
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

  // phase === 'result'
  return (
    <Frame width={width} subtitle="результат">
      {(result ?? '').split('\n').map((l, i) => (
        <Box key={i} paddingLeft={3}>
          <Text color={i === 0 ? (success ? 'green' : isError ? 'red' : 'yellow') : 'gray'}>
            {i === 0 ? (success ? '✓ ' : isError ? '✗ ' : 'ℹ ') : '  '}{l}
          </Text>
        </Box>
      ))}
      <Box paddingLeft={2} marginTop={1}>
        <Text color="gray" dimColor>
          {success
            ? 'Q/Esc/Enter — назад · не забудьте перезапустить redos'
            : 'Q/Esc/Enter — назад'}
        </Text>
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
        <Text bold>Обновление  </Text>
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
