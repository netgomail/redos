import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { homedir } from 'os';
import { version as VERSION } from '../../package.json';
import { Spinner } from './Spinner';

interface Props {
  // Статус автообновления (см. app.tsx): version — куда обновляемся,
  // done — бинарник уже подменён, ждём перезапуска.
  update?: { version: string; done: boolean } | null;
}

export function Header({ update }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const cwd = process.cwd();
  const home = homedir();
  const dir = (cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd).replace(/\\/g, '/');

  const borderColor = update ? (update.done ? 'green' : 'yellow') : 'cyan';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={borderColor} paddingX={1} width={width}>
        <Text color="cyan" bold>{'◆  '}</Text>
        <Text bold>РедОС  </Text>
        <Text color="gray" dimColor>{'v' + VERSION + '  ·  '}</Text>
        <Text color="green">{dir}</Text>
        {update && (
          <>
            <Text color="gray" dimColor>{'  ·  '}</Text>
            {update.done ? (
              <Text color="green" bold>{`Обновлено до v${update.version} — перезапустите для обновления`}</Text>
            ) : (
              <>
                <Spinner />
                <Text color="yellow"> {`Обновление до v${update.version}`}</Text>
              </>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
