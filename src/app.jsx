import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const VERSION = '0.1.0';
let _id = 0;
const uid = () => ++_id;

// ─── Spinner ──────────────────────────────────────────────────────────────────
function Spinner() {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI(n => (n + 1) % frames.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color="cyan">{frames[i]}</Text>;
}

// ─── Header ───────────────────────────────────────────────────────────────────
function Header() {
  const { stdout } = useStdout();
  const width = (stdout?.columns || 80);
  const cwd = process.cwd();
  const home = homedir();
  const short = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const dir = short.replace(/\\/g, '/');

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        <Text color="cyan" bold>{'◆  '}</Text>
        <Text bold>МойКод  </Text>
        <Text color="gray" dimColor>{'v' + VERSION + '  ·  '}</Text>
        <Text color="green">{dir}</Text>
      </Box>
    </Box>
  );
}

// ─── Welcome tips (показываются только при пустой истории) ───────────────────
function WelcomeTips() {
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Box marginBottom={1}>
        <Text color="gray">Начните вводить сообщение или используйте команду:</Text>
      </Box>
      {[
        ['/help',   'список всех команд'],
        ['/files',  'файлы в текущей папке'],
        ['/model',  'информация о модели'],
        ['/status', 'статус сессии'],
        ['/exit',   'выход'],
      ].map(([cmd, desc]) => (
        <Box key={cmd}>
          <Text color="gray">{'  • '}</Text>
          <Text color="cyan">{cmd}</Text>
          <Text color="gray">{'  ' + desc}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ─── Сообщение пользователя ───────────────────────────────────────────────────
function UserMessage({ content }) {
  return (
    <Box marginBottom={1} paddingLeft={2}>
      <Text color="white" bold>{'> '}</Text>
      <Text color="white">{content}</Text>
    </Box>
  );
}

// ─── Сообщение ассистента ─────────────────────────────────────────────────────
function AssistantMessage({ content }) {
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Box>
        <Text color="magenta" bold>{'◆  '}</Text>
        <Text>{content}</Text>
      </Box>
    </Box>
  );
}

// ─── Системное сообщение (вывод команд) ──────────────────────────────────────
function SystemMessage({ content }) {
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={4}>
      {content.split('\n').map((line, i) => (
        <Box key={i}>
          <Text color="gray">{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ─── Сообщение об ошибке ──────────────────────────────────────────────────────
function ErrorMessage({ content }) {
  return (
    <Box marginBottom={1} paddingLeft={2}>
      <Text color="red">{'✗  '}</Text>
      <Text color="red">{content}</Text>
    </Box>
  );
}

// ─── Индикатор "думаю" ────────────────────────────────────────────────────────
function Thinking() {
  return (
    <Box marginBottom={1} paddingLeft={2}>
      <Spinner />
      <Text color="gray">{'  Думаю...'}</Text>
    </Box>
  );
}

// ─── Поле ввода (внизу, бокс как в Claude Code) ───────────────────────────────
function InputBox({ value, isThinking, isMultiline }) {
  const { stdout } = useStdout();
  const width = (stdout?.columns || 80);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        borderStyle="round"
        borderColor={isThinking ? 'gray' : 'cyan'}
        paddingX={1}
        paddingY={0}
        width={width}
        minHeight={3}
      >
        <Box flexDirection="column" flexGrow={1}>
          {isThinking ? (
            <Box>
              <Spinner />
              <Text color="gray">{'  Ожидание ответа...'}</Text>
            </Box>
          ) : (
            <Box>
              <Text color="cyan" bold>{'> '}</Text>
              <Text color="white">{value}</Text>
              {/* блок-курсор */}
              <Text backgroundColor="cyan" color="black">{' '}</Text>
            </Box>
          )}
        </Box>
      </Box>
      <Box paddingLeft={2}>
        <Text color="gray" dimColor>
          {'Enter отправить  ·  Ctrl+C выход  ·  /help команды'}
        </Text>
      </Box>
    </Box>
  );
}

// ─── Команды ──────────────────────────────────────────────────────────────────
function useCommands(addMsg, clearMsgs, exit) {
  return useCallback((cmd, arg) => {
    switch (cmd) {
      case '/exit':
      case '/quit':
        exit();
        break;

      case '/clear':
        clearMsgs();
        break;

      case '/help':
        addMsg('system', [
          'Доступные команды:',
          '',
          '  /help            показать этот список',
          '  /clear           очистить историю',
          '  /version         версия приложения',
          '  /model           информация о модели',
          '  /status          статус сессии',
          '  /files [путь]    файлы в директории',
          '  /run <команда>   выполнить команду (заглушка)',
          '  /config          настройки (заглушка)',
          '  /exit            завершить работу',
        ].join('\n'));
        break;

      case '/version':
        addMsg('system', 'МойКод v' + VERSION);
        break;

      case '/model':
        addMsg('system', [
          'Модель:     mycode-stub-1',
          'Провайдер:  localhost (заглушка)',
          'Контекст:   200 000 токенов',
          'Статус:     ● онлайн',
        ].join('\n'));
        break;

      case '/status': {
        const up = process.uptime();
        const m = Math.floor(up / 60), s = Math.floor(up % 60);
        addMsg('system', [
          'Статус:         ● активна',
          'Аптайм:         ' + (m > 0 ? m + 'м ' : '') + s + 'с',
          'Рабочая папка:  ' + process.cwd().replace(/\\/g, '/'),
          'Node.js:        ' + process.version,
          'ОС:             ' + (process.platform === 'win32' ? 'Windows' : process.platform),
        ].join('\n'));
        break;
      }

      case '/files': {
        const target = arg || process.cwd();
        try {
          const entries = readdirSync(target);
          const dirs = [], files = [];
          for (const name of entries) {
            try {
              const st = statSync(join(target, name));
              st.isDirectory() ? dirs.push(name) : files.push({ name, size: st.size });
            } catch { files.push({ name, size: 0 }); }
          }
          const fmt = sz => sz > 1048576
            ? (sz / 1048576).toFixed(1) + ' МБ'
            : sz > 1024 ? (sz / 1024).toFixed(1) + ' КБ' : sz + ' Б';
          addMsg('system', [
            target.replace(/\\/g, '/'),
            '',
            ...dirs.sort().map(d => '  📁  ' + d + '/'),
            ...files.sort((a, b) => a.name.localeCompare(b.name)).map(f => '  📄  ' + f.name + '  ' + fmt(f.size)),
            '',
            '  ' + dirs.length + ' папок, ' + files.length + ' файлов',
          ].join('\n'));
        } catch {
          addMsg('error', 'Не удалось открыть: ' + target);
        }
        break;
      }

      case '/run':
        addMsg('system', '[заглушка] В реальной версии выполнилась бы: ' + (arg || '(пусто)'));
        break;

      case '/config':
        addMsg('system', [
          'Настройки (заглушка):',
          '  Тема:            dark',
          '  Язык:            ru',
          '  Автосохранение:  включено',
          '  Телеметрия:      выключена',
        ].join('\n'));
        break;

      default:
        addMsg('error', 'Неизвестная команда: ' + cmd + '  (введите /help)');
    }
  }, [addMsg, clearMsgs, exit]);
}

// ─── Главный компонент ────────────────────────────────────────────────────────
function App() {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [isThinking, setIsThinking] = useState(false);

  const addMsg = useCallback((role, content) =>
    setMessages(prev => [...prev, { id: uid(), role, content }]), []);

  const clearMsgs = useCallback(() => setMessages([]), []);

  const handleCommand = useCommands(addMsg, clearMsgs, exit);

  const handleSubmit = useCallback((text) => {
    const t = text.trim();
    if (!t || isThinking) return;

    if (t.startsWith('/')) {
      const sp = t.indexOf(' ');
      const cmd = sp === -1 ? t : t.slice(0, sp);
      const arg = sp === -1 ? '' : t.slice(sp + 1).trim();
      handleCommand(cmd.toLowerCase(), arg);
      return;
    }

    addMsg('user', t);
    setIsThinking(true);

    setTimeout(() => {
      setIsThinking(false);
      const rs = [
        'Понял задачу: "' + t.slice(0, 60) + (t.length > 60 ? '…' : '') + '". Обрабатываю...',
        'Хороший вопрос! В реальной версии здесь был бы настоящий ответ.',
        'Анализирую запрос. Это заглушка — AI не подключён.',
        'Запрос принят. Токенов: ~' + (Math.floor(Math.random() * 200) + 50) + ' [заглушка]',
      ];
      addMsg('assistant', rs[Math.floor(Math.random() * rs.length)]);
    }, 1200 + Math.random() * 800);
  }, [isThinking, addMsg, handleCommand]);

  useInput((char, key) => {
    if (key.ctrl && char === 'c') { exit(); return; }
    if (key.return) { handleSubmit(input); setInput(''); return; }
    if (key.backspace || key.delete) { setInput(s => s.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && !key.escape && char) {
      setInput(s => s + char);
    }
  });

  return (
    <Box flexDirection="column">
      <Header />
      {messages.length === 0 && <WelcomeTips />}
      {messages.map(msg => {
        if (msg.role === 'user')      return <UserMessage      key={msg.id} content={msg.content} />;
        if (msg.role === 'assistant') return <AssistantMessage key={msg.id} content={msg.content} />;
        if (msg.role === 'error')     return <ErrorMessage     key={msg.id} content={msg.content} />;
        return                               <SystemMessage    key={msg.id} content={msg.content} />;
      })}
      {isThinking && <Thinking />}
      <InputBox value={input} isThinking={isThinking} />
    </Box>
  );
}

render(<App />);
