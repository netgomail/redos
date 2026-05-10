import type { Text } from 'ink';

export type MessageRole = 'user' | 'system' | 'error';

export interface Message {
  id: number;
  role: MessageRole;
  content: string;
}

export type Screen = 'chat' | 'passwd-policy' | 'usb-policy';

export type TextColor = Parameters<typeof Text>[0]['color'];
