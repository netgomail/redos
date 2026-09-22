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

export async function getPrinterAttributes(ip: string, timeoutMs = 8000): Promise<IppResponse> {
  const printerUri = `ipp://${ip}/ipp/print`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://${ip}:631/ipp/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/ipp' },
      body: encodeGetPrinterAttributes(printerUri),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return parseIppResponse(new Uint8Array(await resp.arrayBuffer()));
  } finally {
    clearTimeout(t);
  }
}

// ─── сводка для диагностики ───────────────────────────────────────────────────

export interface PrinterInfo {
  model:        string;
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
