import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { homedir } from 'os';
import { version as VERSION } from '../../package.json';

interface Props {
  // Версия, до которой приложение само обновилось в этом сеансе (см. app.tsx).
  // Пока задана — держит в шапке напоминание о перезапуске.
  updatedTo?: string | null;
}

export function Header({ updatedTo }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const cwd = process.cwd();
  const home = homedir();
  const dir = (cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd).replace(/\\/g, '/');

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={updatedTo ? 'yellow' : 'cyan'} paddingX={1} width={width}>
        <Text color="cyan" bold>{'◆  '}</Text>
        <Text bold>РедОС  </Text>
        <Text color="gray" dimColor>{'v' + VERSION + '  ·  '}</Text>
        <Text color="green">{dir}</Text>
        {updatedTo && (
          <>
            <Text color="gray" dimColor>{'  ·  '}</Text>
            <Text color="yellow" bold>{`✓ обновлено до v${updatedTo}`}</Text>
            <Text color="gray" dimColor>{'  ·  '}</Text>
            <Text color="yellow">{'перезапустите redos'}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
