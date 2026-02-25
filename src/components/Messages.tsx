import React from 'react';
import { Box, Text } from 'ink';

export const UserMessage = React.memo(function UserMessage({ content }: { content: string }) {
  return (
    <Box marginBottom={1} paddingLeft={2}>
      <Text color="white" bold>{'> '}</Text>
      <Text color="white">{content}</Text>
    </Box>
  );
});

export const SystemMessage = React.memo(function SystemMessage({ content }: { content: string }) {
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={4}>
      {content.split('\n').map((line, i) => (
        <Text key={i} color="gray">{line}</Text>
      ))}
    </Box>
  );
});

export const ErrorMessage = React.memo(function ErrorMessage({ content }: { content: string }) {
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      {content.split('\n').map((line, i) => (
        <Text key={i} color="red">{i === 0 ? '✗  ' + line : '   ' + line}</Text>
      ))}
    </Box>
  );
});
