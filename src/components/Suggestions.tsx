import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  items: string[];
  selectedIdx: number;
  typed: string;
}

export const Suggestions = React.memo(function Suggestions({ items, selectedIdx, typed }: Props) {
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={3} marginBottom={0}>
      {items.map((cmd, i) => {
        const isSelected = i === selectedIdx;
        const rest = cmd.slice(typed.length);
        return (
          <Box key={cmd}>
            <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '❯ ' : '  '}</Text>
            <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>{typed}</Text>
            <Text color={isSelected ? 'cyan'  : 'gray'}>{rest}</Text>
          </Box>
        );
      })}
    </Box>
  );
});
