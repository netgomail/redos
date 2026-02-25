import type { Text } from 'ink';

export type MessageRole = 'user' | 'assistant' | 'system' | 'error';

export interface Message {
  id: number;
  role: MessageRole;
  content: string;
}

export type Screen = 'chat' | 'hardening' | 'baseline';

export type TextColor = Parameters<typeof Text>[0]['color'];
