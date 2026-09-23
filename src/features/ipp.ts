/**
 * Минимальный IPP-клиент: только Get-Printer-Attributes.
 *
 * Нужен, чтобы спросить у самого аппарата, в каком он состоянии и умеет ли
 * IPP Everywhere, без cups-ipptool (его на машинах обычно нет). Запрос идёт
 * по http на порт 631: антивирус (Kaspersky Endpoint Security) перехватывает
 * https к веб-интерфейсу МФУ из-за самоподписанного сертификата, а IPP на 631
 * не трогает.
 *
 * Формат — RFC 8010: заголовок (версия, операция, request-id), группы
 * атрибутов, у каждого значения тег типа, имя и значение с длинами.
 */

export type IppValue = string | number | boolean;
export type IppAttributes = Map<string, IppValue[]>;

export interface IppResponse {
  status: number;          // 0x0000 successful-ok
  attrs:  IppAttributes;   // атрибуты принтера (коллекции пропускаются)
}

const OP_GET_PRINTER_ATTRIBUTES = 0x000b;

const TAG = {
  operation:  0x01,
  end:        0x03,
  integer:    0x21,
  boolean:    0x22,
  enum:       0x23,
  begCollection: 0x34,
  endCollection: 0x37,
  keyword:    0x44,
  uri:        0x45,
  charset:    0x47,
  language:   0x48,
} as const;

/** Атрибуты, которые нужны для диагностики и решения о переводе. */
export const PRINTER_ATTRS = [
  'printer-make-and-model',
  'printer-device-id',
  'printer-state',
  'printer-state-reasons',
  'printer-state-message',
  'printer-is-accepting-jobs',
  'queued-job-count',
  'document-format-supported',
  'sides-supported',
  'media-ready',
  'marker-names',
  'marker-levels',
  'printer-firmware-string-version',
] as const;

// ─── кодирование запроса ──────────────────────────────────────────────────────

function attr(tag: number, name: string, value: string): number[] {
  const n = [...new TextEncoder().encode(name)];
  const v = [...new TextEncoder().encode(value)];
  return [tag, n.length >> 8, n.length & 0xff, ...n, v.length >> 8, v.length & 0xff, ...v];
}

export function encodeGetPrinterAttributes(printerUri: string, requested: readonly string[] = PRINTER_ATTRS): Uint8Array {
  const bytes: number[] = [
    0x02, 0x00,                                   // IPP 2.0
    OP_GET_PRINTER_ATTRIBUTES >> 8, OP_GET_PRINTER_ATTRIBUTES & 0xff,
    0x00, 0x00, 0x00, 0x01,                       // request-id
    TAG.operation,
    ...attr(TAG.charset,  'attributes-charset',          'utf-8'),
    ...attr(TAG.language, 'attributes-natural-language', 'en'),
    ...attr(TAG.uri,      'printer-uri',                 printerUri),
  ];
  // 1setOf: первое значение с именем, остальные — с пустым именем
  requested.forEach((r, i) => bytes.push(...attr(TAG.keyword, i === 0 ? 'requested-attributes' : '', r)));
  bytes.push(TAG.end);
  return new Uint8Array(bytes);
}

// ─── разбор ответа ────────────────────────────────────────────────────────────

export function parseIppResponse(buf: Uint8Array): IppResponse {
  if (buf.length < 9) throw new Error('ответ IPP слишком короткий');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const status = view.getUint16(2);
  const attrs: IppAttributes = new Map();
  const dec = new TextDecoder();

  let i = 8;
  let name = '';
  let depth = 0; // вложенность коллекций: их содержимое не нужно
  while (i < buf.length) {
    const tag = buf[i++];
    if (tag === TAG.end) break;
    if (tag < 0x10) continue; // начало группы атрибутов

    if (i + 2 > buf.length) break;
    const nl = view.getUint16(i); i += 2;
    const n = dec.decode(buf.subarray(i, i + nl)); i += nl;
    if (i + 2 > buf.length) break;
    const vl = view.getUint16(i); i += 2;
    const v = buf.subarray(i, i + vl); i += vl;

    if (tag === TAG.begCollection) {
      if (depth === 0 && n) name = n;
      depth++;
      continue;
    }
    if (tag === TAG.endCollection) { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;

    if (n) name = n;
    if (!name) continue;

    let value: IppValue;
    if ((tag === TAG.integer || tag === TAG.enum) && vl === 4) {
      value = new DataView(v.buffer, v.byteOffset, 4).getInt32(0);
    } else if (tag === TAG.boolean && vl === 1) {
      value = v[0] !== 0;
    } else if (tag >= 0x30 && tag !== 0x31 && tag !== 0x32 && tag !== 0x33) {
      // строковые типы; dateTime/resolution/rangeOfInteger не нужны
      value = dec.decode(v);
    } else {
      continue;
    }
    const list = attrs.get(name);
    if (list) list.push(value); else attrs.set(name, [value]);
  }
  return { status, attrs };
}

// ─── запрос к аппарату ────────────────────────────────────────────────────────

/**
 * Аппарат спрашивается по host:port, а не по IP: у сетевого это IP и 631, а у
 * USB — 127.0.0.1 и порт, который выдал ipp-usb. Дальше по протоколу разницы
 * между ними нет.
 */
export async function getPrinterAttributes(
  host: string, port = 631, timeoutMs = 8000, tls = false,
): Promise<IppResponse & { tls: boolean; port: number }> {
  const printerUri = `${tls ? 'ipps' : 'ipp'}://${host}${port === 631 ? '' : ':' + port}/ipp/print`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${tls ? 'https' : 'http'}://${host}:${port}/ipp/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/ipp' },
      body: encodeGetPrinterAttributes(printerUri),
      signal: ctrl.signal,
      redirect: 'manual',
      // У МФУ сертификат самоподписанный: проверять его не с чем.
      tls: { rejectUnauthorized: false },
    });
    // Аппарат с выключенным простым IPP (Kyocera с «IPP over SSL») отвечает на
    // 631 редиректом на https://host:443/ — там тот же IPP, только в TLS.
    const loc = resp.headers.get('location') ?? '';
    if (!tls && resp.status >= 300 && resp.status < 400 && /^https:/i.test(loc)) {
      const u = new URL(loc);
      clearTimeout(t);
      return getPrinterAttributes(host, Number(u.port) || 443, timeoutMs, true);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { ...parseIppResponse(new Uint8Array(await resp.arrayBuffer())), tls, port };
  } finally {
    clearTimeout(t);
  }
}

// ─── обход битых ответов прошивки ────────────────────────────────────────────

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Заменяет в ответе IPP значения типа uri без схемы на `replacement`.
 *
 * lpadmin из CUPS 2.4 перед построением PPD проверяет ответ аппарата и при
 * любой ошибке отказывается целиком. Катюша M348 (прошивка 202306220) кладёт в
 * printer-more-info строку «airprint-1.3» — и очередь не создаётся, хотя
 * URF аппарат поддерживает. Остальные байты ответа копируются как есть,
 * коллекции тоже: их значения идут теми же записями тег-имя-значение.
 */
export function fixInvalidUris(buf: Uint8Array, replacement: string): { buf: Uint8Array; fixed: string[] } {
  if (buf.length < 9) return { buf, fixed: [] };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const rep = new TextEncoder().encode(replacement);
  const out: number[] = [...buf.subarray(0, 8)];
  const fixed: string[] = [];

  let i = 8;
  let name = '';
  while (i < buf.length) {
    const tag = buf[i];
    if (tag === TAG.end) { out.push(...buf.subarray(i)); break; }
    if (tag < 0x10) { out.push(tag); i++; continue; }
    if (i + 3 > buf.length) { out.push(...buf.subarray(i)); break; }
    const nl = view.getUint16(i + 1);
    if (i + 5 + nl > buf.length) { out.push(...buf.subarray(i)); break; }
    const n = buf.subarray(i + 3, i + 3 + nl);
    const vl = view.getUint16(i + 3 + nl);
    const v = buf.subarray(i + 5 + nl, i + 5 + nl + vl);
    if (nl) name = dec.decode(n);

    let value: Uint8Array = v;
    if (tag === TAG.uri && !URI_SCHEME.test(dec.decode(v))) {
      fixed.push(`${name}="${dec.decode(v)}"`);
      value = rep;
    }
    out.push(tag, nl >> 8, nl & 0xff, ...n, value.length >> 8, value.length & 0xff, ...value);
    i += 5 + nl + vl;
  }
  return { buf: new Uint8Array(out), fixed };
}

/**
 * Локальный IPP-прокси к аппарату, который чинит ответ (fixInvalidUris).
 *
 * Нужен только на время `lpadmin -m everywhere`: PPD строится по ответу через
 * прокси, после чего очередь переводится на настоящий адрес аппарата. Бэкенд
 * ipp при печати ответ так строго не проверяет.
 */
export function startFixingProxy(host: string, port = 631, tls = false): {
  port: number; fixed: Set<string>; stop: () => void;
} {
  const target = `${tls ? 'https' : 'http'}://${host}:${port}`;
  const fixed = new Set<string>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const resp = await fetch(target + new URL(req.url).pathname, {
        method: req.method,
        headers: { 'Content-Type': 'application/ipp' },
        body: req.method === 'POST' ? await req.arrayBuffer() : undefined,
        tls: { rejectUnauthorized: false },
      });
      const r = fixInvalidUris(new Uint8Array(await resp.arrayBuffer()), `${target}/`);
      r.fixed.forEach(f => fixed.add(f));
      return new Response(r.buf, { status: resp.status, headers: { 'Content-Type': 'application/ipp' } });
    },
  });
  return { port: server.port ?? 0, fixed, stop: () => server.stop(true) };
}

// ─── сводка для диагностики ───────────────────────────────────────────────────

export interface PrinterInfo {
  model:        string;
  /** printer-device-id — строка IEEE 1284 с серийником: по ней узнаётся аппарат. */
  deviceId:     string;
  state:        'idle' | 'processing' | 'stopped' | 'unknown';
  reasons:      string[];   // без «none»
  message:      string;
  accepting:    boolean;
  formats:      string[];
  sides:        string[];
  media:        string[];
  markers:      { name: string; level: number }[];  // level -1/-2/-3 — неизвестно
  firmware:     string;
  /** PWG-raster или URF — то, на чём работает драйвер «everywhere» в CUPS. */
  everywhere:   boolean;
}

const STATES: Record<number, PrinterInfo['state']> = { 3: 'idle', 4: 'processing', 5: 'stopped' };

export function summarize(attrs: IppAttributes): PrinterInfo {
  const str = (k: string) => (attrs.get(k) ?? []).map(String);
  const first = (k: string) => attrs.get(k)?.[0];
  const formats = str('document-format-supported');
  const names = str('marker-names');
  const levels = (attrs.get('marker-levels') ?? []).map(Number);
  return {
    model:      String(first('printer-make-and-model') ?? ''),
    deviceId:   String(first('printer-device-id') ?? ''),
    state:      STATES[Number(first('printer-state'))] ?? 'unknown',
    reasons:    str('printer-state-reasons').filter(r => r && r !== 'none'),
    message:    String(first('printer-state-message') ?? ''),
    accepting:  first('printer-is-accepting-jobs') !== false,
    formats,
    sides:      str('sides-supported'),
    media:      str('media-ready'),
    markers:    names.map((name, i) => ({ name, level: levels[i] ?? -2 })),
    firmware:   String(first('printer-firmware-string-version') ?? ''),
    everywhere: formats.includes('image/pwg-raster') || formats.includes('image/urf'),
  };
}

/** Причины printer-state-reasons, которые реально мешают печати. */
export function blockingReasons(reasons: string[]): string[] {
  return reasons.filter(r => /-(error|stopped)$|jam|door-open|media-empty|media-needed|toner-empty|marker-supply-empty|offline|paused/.test(r)
    && !r.endsWith('-report') && !r.endsWith('-warning'));
}
