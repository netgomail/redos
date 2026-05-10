import React from 'react';
import { Box, Text } from 'ink';
import { COMMANDS } from '../commands/index';

const TIPS = COMMANDS.filter(c => c.showInTips);
const NAME_WIDTH = Math.max(...TIPS.map(c => c.name.length)) + 2;

export function WelcomeTips() {
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Box marginBottom={1}>
        <Text color="gray">Начните вводить сообщение или используйте команду:</Text>
      </Box>
      {TIPS.map(cmd => (
        <Box key={cmd.name}>
          <Text color="gray">{'  • '}</Text>
          <Text color="cyan">{cmd.name.padEnd(NAME_WIDTH)}</Text>
          <Text color="gray">{cmd.description}</Text>
        </Box>
      ))}
    </Box>
  );
}
