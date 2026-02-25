import React, { useState, useCallback } from 'react';
import { render, Box, useInput, useApp } from 'ink';
import { Header }          from './components/Header';
import { WelcomeTips }     from './components/WelcomeTips';
import { InputBox }        from './components/InputBox';
import { HardeningScreen } from './components/HardeningScreen';
import { BaselineScreen } from './components/BaselineScreen';
import {
  UserMessage,
  SystemMessage, ErrorMessage,
} from './components/Messages';
import { useMessages }    from './hooks/useMessages';
import { useInputState }  from './hooks/useInputState';
import { useCommands }    from './commands/index';
import { selfUpdate }     from './utils/update';
import type { Screen } from './types';

// ─── App ─────────────────────────────────────────────────────────────────────
function App() {
  const { exit } = useApp();
  const { messages, add, clear } = useMessages();
  const [screen, setScreen] = useState<Screen>('chat');

  const {
    input, setInput,
    history, historyIdx, setHistoryIdx,
    savedInput, setSavedInput,
    suggestions, setSuggestions,
    sugIdx, setSugIdx,
    pushHistory,
  } = useInputState();

  const handleCommand = useCommands(add, clear, exit, setScreen);

  const handleSubmit = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;

    pushHistory(t);

    if (t.startsWith('/')) {
      const sp = t.indexOf(' ');
      handleCommand(
        sp === -1 ? t          : t.slice(0, sp),
        sp === -1 ? ''         : t.slice(sp + 1).trim(),
      );
      return;
    }

    add('error', 'Введите команду. /help — список команд');
  }, [add, handleCommand, pushHistory]);

  useInput((char, key) => {
    if (key.ctrl && char === 'c') { exit(); return; }

    // Экран харденинга — ввод обрабатывается внутри HardeningScreen
    if (screen !== 'chat') return;

    const hasSugs = suggestions.length > 0;

    if (key.upArrow) {
      if (hasSugs) {
        setSugIdx(i => Math.max(0, i - 1));
      } else if (history.length > 0) {
        if (historyIdx === -1) {
          setSavedInput(input);
          const idx = history.length - 1;
          setHistoryIdx(idx);
          setInput(history[idx]);
        } else if (historyIdx > 0) {
          const idx = historyIdx - 1;
          setHistoryIdx(idx);
          setInput(history[idx]);
        }
      }
      return;
    }

    if (key.downArrow) {
      if (hasSugs) {
        setSugIdx(i => Math.min(suggestions.length - 1, i + 1));
      } else if (historyIdx !== -1) {
        if (historyIdx < history.length - 1) {
          const idx = historyIdx + 1;
          setHistoryIdx(idx);
          setInput(history[idx]);
        } else {
          setHistoryIdx(-1);
          setInput(savedInput);
        }
      }
      return;
    }

    if (key.tab) {
      if (hasSugs) setInput(suggestions[sugIdx]);
      return;
    }

    if (key.escape) {
      if (hasSugs) {
        setSuggestions([]);
      } else if (historyIdx !== -1) {
        setHistoryIdx(-1);
        setInput(savedInput);
      }
      return;
    }

    if (key.return) {
      const text = hasSugs ? suggestions[sugIdx] : input;
      handleSubmit(text);
      setInput('');
      return;
    }

    if (key.backspace || key.delete) {
      setInput(s => s.slice(0, -1));
      if (historyIdx !== -1) setHistoryIdx(-1);
      return;
    }

    if (!key.ctrl && !key.meta && !key.escape && char) {
      setInput(s => s + char);
      if (historyIdx !== -1) setHistoryIdx(-1);
    }
  });

  // ── Полноэкранные режимы ─────────────────────────────────────────────────
  if (screen === 'hardening') {
    return <HardeningScreen onExit={() => setScreen('chat')} />;
  }
  if (screen === 'baseline') {
    return <BaselineScreen onExit={() => setScreen('chat')} />;
  }

  // ── Основной чат-интерфейс ─────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      <Header />
      {messages.length === 0 && <WelcomeTips />}
      {messages.map(msg => {
        if (msg.role === 'user')  return <UserMessage  key={msg.id} content={msg.content} />;
        if (msg.role === 'error') return <ErrorMessage key={msg.id} content={msg.content} />;
        return                           <SystemMessage key={msg.id} content={msg.content} />;
      })}
      <InputBox
        value={input}
        suggestions={suggestions}
        sugIdx={sugIdx}
      />
    </Box>
  );
}

// ─── Применяем отложенное обновление (.new файл на Windows) ──────────────────
if (process.platform === 'win32') {
  const { existsSync, renameSync } = await import('fs');
  const newPath = process.execPath + '.new';
  if (existsSync(newPath)) {
    try {
      renameSync(newPath, process.execPath);
      process.stdout.write('  Обновление применено. Перезапустите mycode.\n');
      process.exit(0);
    } catch {
      // файл ещё занят — проигнорировать, попробуем в следующий раз
    }
  }
}

// ─── CLI entry ────────────────────────────────────────────────────────────────
if (process.argv[2] === 'update') {
  const step = (msg: string) => process.stdout.write('  > ' + msg + '\n');
  process.stdout.write('\n  МойКод — обновление\n\n');
  const result = await selfUpdate(step);
  result.split('\n').forEach(l => process.stdout.write('  ' + l + '\n'));
  process.stdout.write('\n');
  process.exit(0);
} else {
  render(<App />);
}
