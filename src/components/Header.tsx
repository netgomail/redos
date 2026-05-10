import React, { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { homedir } from 'os';
import { version as VERSION } from '../../package.json';
import { checkLatestVersion } from '../utils/update';

export function Header() {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const cwd = process.cwd();
  const home = homedir();
  const dir = (cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd).replace(/\\/g, '/');

  // Один фоновой запрос при mount. Запуск приложения не блокируется:
  // useEffect выполнится после первого рендера, и до ответа в шапке просто
  // не будет строчки про обновление. Если обновления нет / ошибка / таймаут —
  // строчка не появляется вовсе.
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    checkLatestVersion().then(r => {
      if (!cancelled && r?.hasUpdate) setLatest(r.latest);
    }).catch(() => { /* fail silently */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={latest ? 'yellow' : 'cyan'} paddingX={1} width={width}>
        <Text color="cyan" bold>{'◆  '}</Text>
        <Text bold>РедОС  </Text>
        <Text color="gray" dimColor>{'v' + VERSION + '  ·  '}</Text>
        <Text color="green">{dir}</Text>
        {latest && (
          <>
            <Text color="gray" dimColor>{'  ·  '}</Text>
            <Text color="yellow" bold>{`↑ v${latest}`}</Text>
            <Text color="gray" dimColor>{'  ·  '}</Text>
            <Text color="cyan">{'redos update'}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
