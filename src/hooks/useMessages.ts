import { useReducer } from 'react';
import type { Message, MessageRole } from '../types';

let _msgId = 0;

type Action =
  | { type: 'add'; role: MessageRole; content: string }
  | { type: 'clear' };

function messagesReducer(state: Message[], action: Action): Message[] {
  switch (action.type) {
    case 'add':   return [...state, { id: ++_msgId, role: action.role, content: action.content }];
    case 'clear': return [];
    default:      return state;
  }
}

export function useMessages() {
  const [messages, dispatch] = useReducer(messagesReducer, []);

  const add = (role: MessageRole, content: string) =>
    dispatch({ type: 'add', role, content });

  const clear = () => dispatch({ type: 'clear' });

  return { messages, add, clear };
}
