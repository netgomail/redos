import { useCallback } from 'react';
import { collectInventory, formatInventory } from '../features/inventory';
import { runAudit, formatAudit } from '../features/audit';
import { runFirewallAnalysis, formatFirewall } from '../features/firewall';
import { runLogAnalysis, formatLogs } from '../features/logs';
import type { Screen } from '../types';

export interface CommandDef {
  name: string;
  description: string;
  usage?: string;
  showInTips?: boolean;
}

export const COMMANDS: CommandDef[] = [
  { name: '/audit',     description: 'аудит пользователей и файловой системы', usage: '/audit [файл.txt]', showInTips: true },
  { name: '/baseline',  description: 'CIS Benchmark для РедОС/RHEL', showInTips: true },
  { name: '/clear',     description: 'очистить историю' },
  { name: '/exit',      description: 'завершить работу' },
  { name: '/firewall',  description: 'анализ фаервола и SELinux', usage: '/firewall [файл.txt]', showInTips: true },
  { name: '/hardening', description: 'чеклист харденинга Linux', showInTips: true },
  { name: '/help',      description: 'показать список команд', showInTips: true },
  { name: '/inventory', description: 'инвентаризация системы', usage: '/inventory [файл.txt]', showInTips: true },
  { name: '/logs',      description: 'анализ логов безопасности', usage: '/logs [файл.txt]', showInTips: true },
  { name: '/quit',      description: 'завершить работу' },
];

export const COMMAND_NAMES = COMMANDS.map(c => c.name);

type AddFn = (role: 'user' | 'assistant' | 'system' | 'error', content: string) => void;

// ─── helpers ─────────────────────────────────────────────────────────────────

function linuxOnly(add: AddFn, label: string): boolean {
  if (process.platform !== 'linux') {
    add('error', `${label} доступен только на Linux.`);
    return false;
  }
  return true;
}

async function runAndOutput(
  add: AddFn,
  arg: string,
  run: () => { title: string; lines: string[] }[],
  format: (sections: { title: string; lines: string[] }[]) => string,
  defaultFile: string,
) {
  const sections = run();
  const text = format(sections);
  if (arg) {
    const filename = arg.trim();
    try {
      await Bun.write(filename, text);
      add('system', `✓ Отчёт сохранён: ${filename}`);
    } catch {
      add('error', 'Не удалось записать файл: ' + filename);
    }
  } else {
    add('system', text);
  }
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

function handleHardening(add: AddFn, openScreen: (s: Screen) => void) {
  if (linuxOnly(add, 'Чеклист харденинга')) openScreen('hardening');
}

function handleBaseline(add: AddFn, openScreen: (s: Screen) => void) {
  if (linuxOnly(add, 'CIS Baseline')) openScreen('baseline');
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

async function handleAudit(add: AddFn, arg: string) {
  if (!linuxOnly(add, 'Аудит безопасности')) return;
  add('system', 'Запускаю аудит безопасности...');
  await runAndOutput(add, arg, runAudit, formatAudit, 'audit-report');
}

async function handleFirewall(add: AddFn, arg: string) {
  if (!linuxOnly(add, 'Анализ фаервола')) return;
  add('system', 'Анализирую фаервол...');
  await runAndOutput(add, arg, runFirewallAnalysis, formatFirewall, 'firewall-report');
}

async function handleLogs(add: AddFn, arg: string) {
  if (!linuxOnly(add, 'Анализ логов')) return;
  add('system', 'Анализирую логи безопасности...');
  await runAndOutput(add, arg, runLogAnalysis, formatLogs, 'security-logs');
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
      case '/quit':      exit(); break;
      case '/clear':     clear(); break;
      case '/help':      handleHelp(add); break;
      case '/hardening': handleHardening(add, openScreen); break;
      case '/baseline':  handleBaseline(add, openScreen); break;
      case '/inventory': handleInventory(add, arg); break;
      case '/audit':     handleAudit(add, arg); break;
      case '/firewall':  handleFirewall(add, arg); break;
      case '/logs':      handleLogs(add, arg); break;
      default:           add('error', 'Неизвестная команда: ' + cmd + '  (введите /help)');
    }
  }, [add, clear, exit, openScreen]);
}
