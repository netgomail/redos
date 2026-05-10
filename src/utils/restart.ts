// Перезапуск Ink-инстанса после отмены pkexec: app.tsx регистрирует обработчик
// при старте, а requireRoot вызывает его, если пользователь закрыл диалог
// авторизации (родитель уже разобрал TTY, поэтому Ink создаётся заново).

let handler: ((msg: string) => void) | null = null;

export function setRestartHandler(fn: (msg: string) => void) { handler = fn; }
export function restartApp(msg: string) { handler?.(msg); }
