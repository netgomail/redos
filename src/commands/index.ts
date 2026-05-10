import { useCallback } from 'react';
import { collectInventory, formatInventory } from '../features/inventory';
import { isRoot, canPkexec, escalateViaPkexec } from '../utils/sudo';
import { restartApp } from '../utils/restart';
import type { Screen, MessageRole } from '../types';

export interface CommandDef {
  name: string;
  description: string;
  usage?: string;
  showInTips?: boolean;
}

export const COMMANDS: CommandDef[] = [
  { name: '/clear',         description: 'очистить историю' },
  { name: '/exit',          description: 'завершить работу' },
  { name: '/help',          description: 'показать список команд', showInTips: true },
  { name: '/inventory',     description: 'инвентаризация системы', usage: '/inventory [файл.txt]', showInTips: true },
  { name: '/passwd-policy', description: 'парольная политика — сложность и срок смены', showInTips: true },
  { name: '/usb-policy',    description: 'блокировка USB-накопителей и список доверенных', showInTips: true },
  { name: '/quit',          description: 'завершить работу' },
];

export const COMMAND_NAMES = COMMANDS.map(c => c.name);

type AddFn = (role: MessageRole, content: string) => void;

// ─── helpers ─────────────────────────────────────────────────────────────────

function linuxOnly(add: AddFn, label: string): boolean {
  if (process.platform !== 'linux') {
    add('error', `${label} доступен только на Linux.`);
    return false;
  }
  return true;
}

/**
 * Проверяет права root. Если их нет — пытается перезапустить приложение через
 * pkexec (системное окно polkit с запросом пароля). При отсутствии графики
 * выводит подсказку про `sudo redos`. Возвращает true только если уже root.
 *
 * cmdName — имя команды («/passwd-policy» и т.п.) пробрасывается дочернему
 * процессу через --auto-cmd, чтобы после успешной авторизации сразу открыть
 * нужный экран. Если пользователь закрыл диалог pkexec, перезапускаем Ink в
 * родителе с уведомлением — приложение остаётся открытым.
 */
async function requireRoot(
  add: AddFn,
  exit: () => void,
  label: string,
  cmdName: string,
): Promise<boolean> {
  if (isRoot()) return true;
  if (canPkexec()) {
    add('system', `⚙ ${label}: открываю окно polkit для запроса пароля администратора...`);
    await new Promise<void>(r => setTimeout(r, 50));
    exit();
    const result = await escalateViaPkexec(cmdName);
    if (result === 'cancelled') {
      restartApp(`${label}: доступ отменён.`);
    }
    return false;
  }
  add('error', [
    `${label}: требуются права администратора.`,
    '  В терминале:  sudo redos',
    '  В графе: установите polkit и запустите снова — появится окно ввода пароля',
  ].join('\n'));
  return false;
}

// ─── handlers ────────────────────────────────────────────────────────────────

function handleHelp(add: AddFn) {
  const lines = ['Доступные команды:', ''];
  for (const cmd of COMMANDS) {
    if (cmd.name === '/quit') continue;
    const label = (cmd.usage ?? cmd.name).padEnd(24);
    lines.push(`  ${label} ${cmd.description}`);
  }
  add('system', lines.join('\n'));
}

async function handleInventory(add: AddFn, arg: string) {
  if (!linuxOnly(add, 'Инвентаризация')) return;
  add('system', 'Собираю данные о системе...');
  try {
    const sections = await collectInventory();
    const text = formatInventory(sections);
    if (arg) {
      const filename = arg.trim();
      try {
        await Bun.write(filename, text);
        add('system', `✓ Инвентаризация сохранена: ${filename}`);
      } catch {
        add('error', 'Не удалось записать файл: ' + filename);
      }
    } else {
      add('system', text);
    }
  } catch (e) {
    add('error', 'Ошибка инвентаризации: ' + (e as Error).message);
  }
}

async function handlePasswdPolicy(add: AddFn, openScreen: (s: Screen) => void, exit: () => void) {
  if (!linuxOnly(add, 'Парольная политика')) return;
  if (!await requireRoot(add, exit, 'Парольная политика', '/passwd-policy')) return;
  openScreen('passwd-policy');
}

async function handleUsbPolicy(add: AddFn, openScreen: (s: Screen) => void, exit: () => void) {
  if (!linuxOnly(add, 'Политика USB')) return;
  if (!await requireRoot(add, exit, 'Политика USB', '/usb-policy')) return;
  openScreen('usb-policy');
}

// ─── hook ────────────────────────────────────────────────────────────────────

export function useCommands(
  add: AddFn,
  clear: () => void,
  exit: () => void,
  openScreen: (s: Screen) => void,
) {
  return useCallback((cmd: string, arg: string) => {
    switch (cmd) {
      case '/exit':
      case '/quit':          exit(); break;
      case '/clear':         clear(); break;
      case '/help':          handleHelp(add); break;
      case '/inventory':     handleInventory(add, arg); break;
      case '/passwd-policy': handlePasswdPolicy(add, openScreen, exit); break;
      case '/usb-policy':    handleUsbPolicy(add, openScreen, exit); break;
      default:               add('error', 'Неизвестная команда: ' + cmd + '  (введите /help)');
    }
  }, [add, clear, exit, openScreen]);
}
