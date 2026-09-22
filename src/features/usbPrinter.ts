/**
 * МФУ, подключённый по USB: опознание и driverless через ipp-usb.
 *
 * Сетевой аппарат сам говорит по IPP на порт 631, и вся схема перевода
 * держится на этом. У USB такого порта нет, поэтому driverless по USB — это
 * демон ipp-usb: он берёт устройство, которое умеет IPP-over-USB, и публикует
 * его как обычный сетевой принтер на 127.0.0.1:60000. Дальше всё то же самое —
 * lpadmin -m everywhere по этому адресу и eSCL по нему же для сканирования,
 * без hplip и без драйверов вовсе.
 *
 * Признак пригодности читается из sysfs: интерфейс класса 07 (принтер) с
 * протоколом 04 — это и есть IPP-over-USB. Нет такого интерфейса — driverless
 * по USB невозможен, и утилита обязана сказать это прямо, а не пытаться.
 *
 * Порт у каждого устройства свой: ipp-usb раздаёт их подряд от 60000, и какой
 * достался нашему — заранее неизвестно. Поэтому порты перебираются, и ответ
 * сверяется с серийником аппарата: на машине может стоять не один МФУ.
 */

import { listUsbSysfs } from './deviceControl';
import { getPrinterAttributes, summarize } from './ipp';
import type { PrinterInfo } from './ipp';
import { runPty } from '../utils/terminal';

/** Класс интерфейса «принтер» и протокол IPP-over-USB внутри него. */
const PRINTER_CLASS   = '07';
const IPP_PROTOCOL    = '04';

/** Диапазон, который занимает ipp-usb: по порту на устройство, подряд. */
export const IPP_USB_PORT_BASE  = 60000;
export const IPP_USB_PORT_COUNT = 11;

export interface UsbPrinter {
  port:       string;   // 2-4 — положение в дереве USB
  deviceId:   string;   // 03f0:0f2a
  serial:     string;
  model:      string;   // product из sysfs
  vendor:     string;   // manufacturer из sysfs
  /** Есть интерфейс 07:*:04 — аппарат умеет IPP-over-USB. */
  ippOverUsb: boolean;
  /** Устройство деавторизовано ядром: его заблокировала политика /usb-policy. */
  blocked:    boolean;
}

/** Человекочитаемое имя: «HP LaserJet MFP M426fdn» без повтора производителя. */
export function usbPrinterName(p: UsbPrinter): string {
  const model = p.model.trim();
  const vendor = p.vendor.trim();
  if (!model) return vendor || p.deviceId;
  return vendor && !model.toLowerCase().startsWith(vendor.toLowerCase())
    ? `${vendor} ${model}` : model;
}

/** Принтеры среди подключённых USB-устройств — по классу интерфейса. */
export function usbPrintersFrom(devices: ReturnType<typeof listUsbSysfs>): UsbPrinter[] {
  const out: UsbPrinter[] = [];
  for (const d of devices) {
    // У заблокированного устройства интерфейсов нет — ядро их не
    // конфигурирует. Заявленные подходят, чтобы узнать принтер и сказать,
    // что он заблокирован: решение по ним всё равно не принимается.
    const ifaces = d.interfaces.length ? d.interfaces : d.declared;
    const printer = ifaces.filter(i => i.split(':')[0]?.toLowerCase() === PRINTER_CLASS);
    if (printer.length === 0) continue;
    out.push({
      port:       d.port,
      deviceId:   d.deviceId,
      serial:     d.serial,
      model:      d.product,
      vendor:     d.manufacturer,
      ippOverUsb: printer.some(i => i.split(':')[2]?.toLowerCase() === IPP_PROTOCOL),
      blocked:    !d.authorized,
    });
  }
  return out;
}

export function findUsbPrinters(): UsbPrinter[] {
  return usbPrintersFrom(listUsbSysfs());
}

// ─── демон ipp-usb ────────────────────────────────────────────────────────────

export interface IppUsbState {
  installed: boolean;
  active:    boolean;
}

export async function readIppUsbState(): Promise<IppUsbState> {
  const [rpm, act] = await Promise.all([
    runPty(['rpm', '-q', 'ipp-usb'], { timeoutMs: 10_000 }),
    runPty(['systemctl', 'is-active', '-q', 'ipp-usb.service'], { timeoutMs: 8000 }),
  ]);
  return { installed: rpm.code === 0, active: act.code === 0 };
}

/** Убираем регистр и разделители: «HP LaserJet MFP M426fdn» ≈ «hp_laserjet_mfp_m426fdn». */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Тот ли это аппарат, что мы ищем, на порту ipp-usb.
 *
 * Серийник надёжнее: он есть в printer-device-id (поле SN или SERN) и не
 * совпадает у двух одинаковых МФУ. Модель — запасной вариант для устройств,
 * которые серийник не сообщают.
 */
export function matchesDevice(info: PrinterInfo, p: UsbPrinter): boolean {
  const sn = info.deviceId.match(/(?:^|;)\s*(?:SN|SERN)\s*:\s*([^;]+)/i)?.[1]?.trim();
  if (sn && p.serial) return normalize(sn) === normalize(p.serial);
  if (!p.model) return false;
  return normalize(info.model).includes(normalize(p.model))
      || normalize(p.model).includes(normalize(info.model));
}

/**
 * Порт, на котором ipp-usb опубликовал этот аппарат. 0 — не нашёлся.
 *
 * Порты перебираются по одному и с коротким тайм-аутом: закрытый порт
 * отвечает отказом сразу, а перебор одиннадцати штук не должен подвешивать
 * экран, пока пользователь ждёт проверку.
 */
export async function findIppUsbPort(p: UsbPrinter, timeoutMs = 2000): Promise<number> {
  for (let port = IPP_USB_PORT_BASE; port < IPP_USB_PORT_BASE + IPP_USB_PORT_COUNT; port++) {
    try {
      const r = await getPrinterAttributes('127.0.0.1', port, timeoutMs);
      if (r.status >= 0x0100) continue;
      if (matchesDevice(summarize(r.attrs), p)) return port;
    } catch {
      // порт закрыт или за ним не ipp-usb — просто следующий
    }
  }
  return 0;
}

/**
 * Почему driverless по USB невозможен в принципе; пустая строка — возможен.
 *
 * Здесь только то, чего утилита сделать не может: аппарат не умеет
 * IPP-over-USB или его не пускает политика USB. Отсутствие ipp-usb сюда не
 * входит — это не препятствие, а шаг плана: демон ставится и запускается в
 * ходе перевода.
 */
export function usbBlocker(p: UsbPrinter): string {
  if (p.blocked)
    return `${usbPrinterName(p)} заблокирован политикой USB — разрешите его в /usb-policy`;
  if (!p.ippOverUsb)
    return `${usbPrinterName(p)} не умеет IPP-over-USB (нет интерфейса 07:*:04) — ` +
           'driverless по USB для него невозможен, очередь на hplip останется';
  return '';
}

/** Что ещё нужно сделать, чтобы аппарат заговорил по IPP; пусто — всё готово. */
export function usbPending(state: IppUsbState, port: number): string {
  if (!state.installed) return 'ipp-usb не установлен — будет установлен при переводе';
  if (!state.active)    return 'служба ipp-usb не запущена — будет запущена при переводе';
  if (port === 0)
    return 'ipp-usb работает, но аппарат на его портах не отвечает: проверьте, ' +
           'не занят ли USB-интерфейс драйвером usblp';
  return '';
}
