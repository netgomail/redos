export type MessageRole = 'user' | 'system' | 'error';

export interface Message {
  id: number;
  role: MessageRole;
  content: string;
}

export type Screen = 'chat' | 'passwd-policy' | 'usb-policy' | 'printer';
