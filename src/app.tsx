import React, { useState, useCallback, useEffect, useRef } from 'react';
import { render, Box, useInput, useApp } from 'ink';
import { Header }          from './components/Header';
import { WelcomeTips }     from './components/WelcomeTips';
import { InputBox }        from './components/InputBox';
import { PasswordPolicyScreen } from './components/PasswordPolicyScreen';
import { USBPolicyScreen } from './components/USBPolicyScreen';
import { PrinterScreen }   from './components/PrinterScreen';
import {
  UserMessage,
  SystemMessage, ErrorMessage,
} from './components/Messages';
import { useMessages }    from './hooks/useMessages';
import { useInputState }  from './hooks/useInputState';
import { useCommands }    from './commands/index';
import { selfUpdate, REPO } from './utils/update';
import { version as VERSION } from '../package.json';
import { setRestartHandler } from './utils/restart';
import type { Screen } from './types';

// ─── App ─────────────────────────────────────────────────────────────────────
type AppProps = { autoCmd?: string; initialError?: string };

function App({ autoCmd, initialError }: AppProps) {
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

// ─── CLI entry ────────────────────────────────────────────────────────────────
if (process.argv[2] === 'update') {
  const ESC   = '\x1b';
  const reset = `${ESC}[0m`;
  const bold  = `${ESC}[1m`;
  const dim   = `${ESC}[2m`;
  const cyan  = `${ESC}[96m`;
  const green = `${ESC}[92m`;
  const red   = `${ESC}[91m`;
  const gray  = `${ESC}[90m`;

  // Прогресс-бар. Ровно тот же, что рисует install.sh при первой установке:
  // ширина 22, заполненная часть зелёная, пустая серая. floor, а не round, —
  // иначе бар выглядит полным ещё до конца загрузки (и расходится с install.sh).
  const bar = (received: number, total: number, width = 22): string => {
    if (total <= 0) return '';
    const filled = Math.min(width, Math.floor((received / total) * width));
    return `${dim}[${reset}${green}${'█'.repeat(filled)}${gray}${'░'.repeat(width - filled)}${dim}]${reset}`;
  };

  // Подкрашиваем версии: «vX.Y.Z → vA.B.C» — старая серая, стрелка cyan, новая зелёная жирная.
  const colorVersions = (s: string) => /v\d+\.\d+\.\d+\s*→\s*v\d+\.\d+\.\d+/.test(s)
    ? s.replace(/v(\d+\.\d+\.\d+)\s*→\s*v(\d+\.\d+\.\d+)/g,
        `${gray}v$1${reset} ${cyan}→${reset} ${green}${bold}v$2${reset}`)
    : s.replace(/v(\d+\.\d+\.\d+)/g, `${green}${bold}v$1${reset}`);

  // ── Заголовок ─────────────────────────────────────────────────────────────
  // Тот же вид, что у install.sh при первой установке: рамка, имя, версия, ссылка.
  const headerLine = '+' + '-'.repeat(50) + '+';
  process.stdout.write('\n');
  process.stdout.write(`  ${cyan}${headerLine}${reset}\n`);
  process.stdout.write(`  ${cyan}|${reset}  ${bold}РедОС${reset} Updater  ${gray}v${VERSION}${reset}\n`);
  process.stdout.write(`  ${cyan}|${reset}  ${gray}https://github.com/${REPO}${reset}\n`);
  process.stdout.write(`  ${cyan}${headerLine}${reset}\n`);
  process.stdout.write('\n');

  // ── Шаги и прогресс ───────────────────────────────────────────────────────
  let progressActive = false;
  const finishProgressLine = () => {
    if (progressActive) {
      // \n закрывает строку прогресса (поверх неё писали через \r),
      // второй \n добавляет пустую строку, чтобы следующий шаг не прилипал.
      process.stdout.write('\n\n');
      progressActive = false;
    }
  };
  const step = (msg: string) => {
    finishProgressLine();
    process.stdout.write(`  ${cyan}›${reset} ${colorVersions(msg)}\n`);
  };
  const progress = (received: number, total: number) => {
    const mb  = (n: number) => (n / 1024 / 1024).toFixed(1);
    const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
    const text = total > 0
      ? `Скачиваю ${bar(received, total)} ${bold}${pct.toString().padStart(3)}%${reset} ${dim}(${mb(received)} / ${mb(total)} MB)${reset}`
      : `Скачиваю ${mb(received)} MB`;
    process.stdout.write(`\r  ${cyan}›${reset} ${text}   `);
    progressActive = true;
  };

  const result = await selfUpdate(step, progress);
  finishProgressLine();
  process.stdout.write('\n');

  // ── Итог без рамки: иконка + текст с подсветкой версий ────────────────────
  const isError = result.startsWith('Ошибка');
  const icon    = isError ? `${red}${bold}✗${reset}` : `${green}${bold}✓${reset}`;
  result.split('\n').forEach((l, i) => {
    const prefix = i === 0 ? `${icon} ` : '  ';
    process.stdout.write(`  ${prefix}${colorVersions(l)}\n`);
  });
  process.stdout.write('\n');
  process.exit(0);
} else {
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
}
