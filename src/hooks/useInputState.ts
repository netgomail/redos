import { useState, useEffect } from 'react';
import { COMMAND_NAMES } from '../commands/index';

export function useInputState() {
  const [input, setInput]           = useState('');
  const [history, setHistory]       = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [savedInput, setSavedInput] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [sugIdx, setSugIdx]           = useState(0);

  useEffect(() => {
    if (input.startsWith('/') && !input.includes(' ')) {
      const q = input.toLowerCase();
      const filtered = COMMAND_NAMES.filter(c => c.startsWith(q) && c !== q);
      setSuggestions(filtered);
      setSugIdx(0);
    } else {
      setSuggestions([]);
    }
  }, [input]);

  const pushHistory = (text: string) => {
    setHistory(h => h.length && h[h.length - 1] === text ? h : [...h, text]);
    setHistoryIdx(-1);
    setSavedInput('');
    setSuggestions([]);
    setSugIdx(0);
  };

  return {
    input, setInput,
    history, historyIdx, setHistoryIdx,
    savedInput, setSavedInput,
    suggestions, setSuggestions,
    sugIdx, setSugIdx,
    pushHistory,
  };
}
