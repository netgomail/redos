import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { Suggestions } from './Suggestions';

interface Props {
  value: string;
  suggestions: string[];
  sugIdx: number;
}

export function InputBox({ value, suggestions, sugIdx }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const hasSugs = suggestions.length > 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        width={width}
        minHeight={3}
      >
        <Box flexGrow={1}>
          <Text color="cyan" bold>{'> '}</Text>
          <Text color="white">{value}</Text>
          <Text backgroundColor="cyan" color="black">{' '}</Text>
        </Box>
      </Box>

      {hasSugs && <Suggestions items={suggestions} selectedIdx={sugIdx} typed={value} />}

      <Box paddingLeft={2}>
        <Text color="gray" dimColor>
          {hasSugs
            ? 'Tab/Enter выбрать  ·  ↑↓ навигация  ·  Esc закрыть'
            : 'Enter отправить  ·  ↑↓ история  ·  Ctrl+C выход  ·  /help команды'}
        </Text>
      </Box>
    </Box>
  );
}
