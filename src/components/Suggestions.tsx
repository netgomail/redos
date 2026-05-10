import React from 'react';
import { Box, Text } from 'ink';
import { COMMANDS } from '../commands/index';

interface Props {
  items: string[];
  selectedIdx: number;
  typed: string;
}

const DESCRIPTIONS = new Map(COMMANDS.map(c => [c.name, c.description]));
const NAME_WIDTH   = Math.max(...COMMANDS.map(c => c.name.length)) + 2;

export const Suggestions = React.memo(function Suggestions({ items, selectedIdx, typed }: Props) {
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={3} marginBottom={0}>
      {items.map((cmd, i) => {
        const isSelected = i === selectedIdx;
        const rest = cmd.slice(typed.length);
        const padding = ' '.repeat(Math.max(0, NAME_WIDTH - cmd.length));
        const description = DESCRIPTIONS.get(cmd) ?? '';
        return (
          <Box key={cmd}>
            <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '❯ ' : '  '}</Text>
            <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>{typed}</Text>
            <Text color={isSelected ? 'cyan'  : 'gray'}>{rest}</Text>
            <Text color="gray" dimColor>{padding + description}</Text>
          </Box>
        );
      })}
    </Box>
  );
});
