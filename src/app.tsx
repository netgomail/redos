import React, { useState, useCallback, useEffect, useRef } from 'react';
import { render, Box, useInput, useApp } from 'ink';
import { Header }          from './components/Header';
import { WelcomeTips }     from './components/WelcomeTips';
import { InputBox }        from './components/InputBox';
import { PasswordPolicyScreen } from './components/PasswordPolicyScreen';
import { USBPolicyScreen } from './components/USBPolicyScreen';
import { PrinterScreen }   from './components/PrinterScreen';
import { InstallScreen }   from './components/InstallScreen';
import {
  UserMessage,
  SystemMessage, ErrorMessage,
} from './components/Messages';
import { useMessages }    from './hooks/useMessages';
import { useInputState }  from './hooks/useInputState';
import { useCommands }    from './commands/index';
import { checkLatestVersion, selfUpdate } from './utils/update';
import { version as VERSION } from '../package.json';
import { setRestartHandler } from './utils/restart';
import type { Screen } from './types';

// ─── App ─────────────────────────────────────────────────────────────────────
type AppProps = { autoCmd?: string; initialError?: string };

function App({ autoCmd, initialError }: AppProps) {
  const { exit } = useApp();
  const { messages, add, clear } = useMessages();
  const [screen, setScreen] = useState<Screen>('chat');
  // Версия, до которой приложение само обновилось в этом сеансе (см. ниже).
  // Пока не null — держит напоминание о перезапуске в шапке.
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);

  const {
    input, setInput,
    history, historyIdx, setHistoryIdx,
    savedInput, setSavedInput,
    suggestions, setSuggestions,
    sugIdx, setSugIdx,
    pushHistory,
  } = useInputState();

  const handleCommand = useCommands(add, clear, exit, setScreen);

  // Однократное действие при первом монтировании Ink: показать сообщение
  // об отмене pkexec (если родителя перезапустили) и/или автоматически
  // открыть команду из --auto-cmd, чтобы не приходилось вводить её повторно.
  const ranAutoRef = useRef(false);
  useEffect(() => {
    if (ranAutoRef.current) return;
    ranAutoRef.current = true;
    if (initialError) add('error', initialError);
    if (autoCmd && autoCmd.startsWith('/')) {
      Promise.resolve().then(() => handleCommand(autoCmd, ''));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Автообновление: один фоновой запрос при старте, без участия пользователя.
  // Если на GitHub есть более новая версия — сразу качаем и подменяем бинарник
  // (rename, см. selfUpdate). Текущий процесс всё ещё работает со старым
  // inode, поэтому просто оставляем заметное напоминание перезапустить —
  // приложение не закрываем и работу не прерываем.
  const ranUpdateRef = useRef(false);
  useEffect(() => {
    if (ranUpdateRef.current) return;
    ranUpdateRef.current = true;
    (async () => {
      const check = await checkLatestVersion();
      if (!check?.hasUpdate) return;
      const result = await selfUpdate();
      if (result.startsWith('Обновлено')) {
        setUpdatedTo(check.latest);
        add('system', `✓ Обновлено: v${VERSION} → v${check.latest}. Перезапустите redos.`);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

    // На полноэкранных режимах ввод обрабатывается внутри их компонентов
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
  if (screen === 'passwd-policy') {
    return <PasswordPolicyScreen onExit={() => setScreen('chat')} />;
  }
  if (screen === 'usb-policy') {
    return <USBPolicyScreen onExit={() => setScreen('chat')} />;
  }
  if (screen === 'printer') {
    return <PrinterScreen onExit={() => setScreen('chat')} />;
  }
  if (screen === 'install') {
    return <InstallScreen onExit={() => setScreen('chat')} />;
  }

  // ── Основной чат-интерфейс ─────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      <Header updatedTo={updatedTo} />
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

// ─── CLI entry ────────────────────────────────────────────────────────────────
// --auto-cmd <name> — внутренний флаг, который проставляет escalateViaPkexec
// дочернему процессу, чтобы тот сам открыл нужный экран после повышения прав.
const userArgs = process.argv.slice(2);
let autoCmd: string | undefined;
const idx = userArgs.indexOf('--auto-cmd');
if (idx !== -1 && userArgs[idx + 1]) autoCmd = userArgs[idx + 1];

const startApp = (opts: AppProps = {}) => {
  render(<App autoCmd={opts.autoCmd} initialError={opts.initialError} />);
};
// requireRoot вызывает restartApp, если pkexec был отменён, — Ink уже
// разобран, поэтому пересоздаём дерево заново с уведомлением.
setRestartHandler(msg => startApp({ initialError: msg }));
startApp({ autoCmd });
