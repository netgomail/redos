/**
 * Обратная совместимость с версиями 0.10–0.11.2, где контроль устройств был
 * построен на USBGuard.
 *
 * Здесь нет ни строчки, которая что-то блокирует: модуль умеет только найти
 * следы прежнего движка и убрать их, чтобы машину можно было перевести на
 * udev-политику.
 *
 * Порядок очистки важен и не сводится к `dnf remove`. USBGuard выставляет на
 * контроллерах authorized_default=0 — так новое устройство не успевает
 * сконфигурироваться до решения демона, — а в конфигурации, которую писала
 * версия 0.11, стоит RestoreControllerDeviceState=false: при остановке демон
 * намеренно НЕ возвращает это состояние. Удалить пакет, не поправив
 * authorized_default, значит оставить машину, на которой ни одно новое
 * USB-устройство не поднимется до перезагрузки — включая клавиатуру, если её
 * переткнуть.
 */

import { readdirSync, existsSync } from 'fs';
import { readFile } from '../utils/fs';
import { sudoRun } from '../utils/sudo';
import type { FixResult } from '../utils/sudo';
import { runPty, runPtyLines } from '../utils/terminal';

export const GUARD_RULES  = '/etc/usbguard/rules.conf';
export const GUARD_CONF   = '/etc/usbguard/usbguard-daemon.conf';
/** Кэш имён устройств, который вела версия на USBGuard. */
export const GUARD_CACHE  = '/var/lib/redos/usb-devices.json';

const C_LOCALE = { LC_ALL: 'C', LANG: 'C', LANGUAGE: 'C' };
const USBGUARD_PATHS = ['/usr/bin/usbguard', '/usr/sbin/usbguard', '/bin/usbguard'];
/** Маркер rules.conf, записанного версией 0.10–0.11. */
const GUARD_MARK = '# redos-device-control: managed';

export interface UsbGuardTraces {
  /** Пакет установлен. */
  installed:      boolean;
  serviceUnit:    string;
  serviceEnabled: boolean;
  serviceActive:  boolean;
  /** Есть /etc/usbguard/rules.conf. */
  rulesFile:      boolean;
  /** Правила писала наша прошлая версия (есть маркер). */
  managed:        boolean;
  /** Контроллеры, на которых USBGuard оставил authorized_default=0. */
  lockedControllers: string[];
}

/**
 * Наличие usbguard определяется по файлу, а не запуском: у утилиты нет ни
 * --version, ни --help как опции, и любой пробный запуск даёт ненулевой код.
 */
function usbguardBinary(): string | null {
  return USBGUARD_PATHS.find(p => existsSync(p)) ?? null;
}

/**
 * Контроллеры, на которых новые устройства не авторизуются автоматически.
 * Именно это состояние оставляет после себя остановленный USBGuard.
 */
export function lockedControllers(): string[] {
  let ports: string[];
  try { ports = readdirSync('/sys/bus/usb/devices'); } catch { return []; }

  return ports.filter(p => {
    if (!/^usb\d+$/.test(p)) return false;
    const dir = `/sys/bus/usb/devices/${p}`;
    const dev = (readFile(`${dir}/authorized_default`) ?? '').trim();
    const iface = (readFile(`${dir}/interface_authorized_default`) ?? '').trim();
    return dev === '0' || iface === '0';
  });
}

async function detectServiceUnit(): Promise<string> {
  for (const unit of ['usbguard.service', 'usbguard-daemon.service']) {
    const r = await runPtyLines(['systemctl', 'cat', unit], { env: C_LOCALE, timeoutMs: 8000 });
    if (r.some(l => l.includes('[Unit]'))) return unit;
  }
  return 'usbguard.service';
}

export async function findUsbGuardTraces(): Promise<UsbGuardTraces> {
  const rules = readFile(GUARD_RULES);
  const base: UsbGuardTraces = {
    installed:      usbguardBinary() !== null,
    serviceUnit:    'usbguard.service',
    serviceEnabled: false,
    serviceActive:  false,
    rulesFile:      rules !== null,
    managed:        rules?.includes(GUARD_MARK) ?? false,
    lockedControllers: lockedControllers(),
  };
  if (!base.installed) return base;

  base.serviceUnit = await detectServiceUnit();
  const [en, act] = await Promise.all([
    runPtyLines(['systemctl', 'is-enabled', base.serviceUnit], { env: C_LOCALE, timeoutMs: 8000 }),
    runPtyLines(['systemctl', 'is-active',  base.serviceUnit], { env: C_LOCALE, timeoutMs: 8000 }),
  ]);
  base.serviceEnabled = en.some(l => l.trim() === 'enabled');
  base.serviceActive  = act.some(l => l.trim() === 'active');
  return base;
}

/** Есть ли вообще что убирать. */
export function hasTraces(t: UsbGuardTraces): boolean {
  return t.installed || t.rulesFile || t.lockedControllers.length > 0;
}

/**
 * Убирает USBGuard с машины и возвращает устройствам работоспособность.
 *
 * Пакет удаляется последним: сначала снимается всё, что он успел сделать с
 * ядром, — иначе останавливать и разблокировать было бы уже нечем.
 */
export async function cleanupUsbGuard(onStep: (m: string) => void = () => {}): Promise<FixResult> {
  const traces = await findUsbGuardTraces();
  if (!hasTraces(traces)) return { ok: true, msg: 'следов USBGuard нет' };

  const done: string[] = [];

  if (traces.installed) {
    onStep('Останавливаю usbguard');
    sudoRun(['systemctl', 'disable', '--now', traces.serviceUnit]);
    done.push('служба остановлена');
  }

  // Контроллеры: без этого шага новые устройства не поднимутся до перезагрузки
  if (traces.lockedControllers.length > 0) {
    onStep('Возвращаю автоматическую авторизацию на контроллерах');
    const cmd = traces.lockedControllers.map(p =>
      `printf 1 > '/sys/bus/usb/devices/${p}/authorized_default' 2>/dev/null;` +
      `printf 1 > '/sys/bus/usb/devices/${p}/interface_authorized_default' 2>/dev/null;`,
    ).join(' ');
    sudoRun(['sh', '-c', cmd + ' exit 0']);
    done.push(`контроллеров разблокировано: ${traces.lockedControllers.length}`);
  }

  onStep('Возвращаю авторизацию устройствам');
  let restored = 0;
  await runPty(['sudo', '-n', 'sh', '-c',
    'for f in /sys/bus/usb/devices/*/authorized; do ' +
    '[ "$(cat "$f")" = "0" ] && echo 1 > "$f" && echo "$f"; done; exit 0'],
    { env: C_LOCALE, timeoutMs: 20_000, onLine: l => { if (l.includes('authorized')) restored++; } });
  if (restored) done.push(`устройств разблокировано: ${restored}`);

  if (traces.installed) {
    onStep('Удаляю пакет usbguard');
    const r = await runPty(['sudo', '-n', 'dnf', 'remove', '-y', 'usbguard'], {
      env: C_LOCALE,
      timeoutMs: 300_000,
      onLine: l => { if (l.trim()) onStep(l.trim()); },
    });
    if (r.code !== 0) {
      return {
        ok: false,
        msg: `устройства разблокированы, но dnf remove usbguard завершился с кодом ${r.code}`,
      };
    }
    done.push('пакет удалён');
  }

  // Кэш имён устройств от прошлой версии — мусор, политика его не читает
  if (readFile(GUARD_CACHE) !== null) sudoRun(['rm', '-f', GUARD_CACHE]);

  return { ok: true, msg: `USBGuard убран: ${done.join(', ')}` };
}
