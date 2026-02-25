import React from 'react';
import { Box, Text } from 'ink';
import { COMMANDS } from '../commands/index';

const TIPS = COMMANDS.filter(c => c.showInTips);

export function WelcomeTips() {
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Box marginBottom={1}>
        <Text color="gray">Начните вводить сообщение или используйте команду:</Text>
      </Box>
      {TIPS.map(cmd => (
        <Box key={cmd.name}>
          <Text color="gray">{'  • '}</Text>
          <Text color="cyan">{cmd.name}</Text>
          <Text color="gray">{'  ' + cmd.description}</Text>
        </Box>
      ))}
    </Box>
  );
}
