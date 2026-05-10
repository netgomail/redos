import { basename } from 'path';
import { version as VERSION } from '../../package.json';

const REPO = 'netgomail/redos';

export function getPlatformBinary(): string {
  if (process.platform === 'darwin')
    return process.arch === 'arm64' ? 'redos-mac-arm' : 'redos-mac-x64';
  return 'redos-linux';
}

function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface UpdateCheck {
  current:   string;
  latest:    string;
  hasUpdate: boolean;
}

/** Лёгкий запрос к GitHub API, без скачивания. Один раз при старте. */
export async function checkLatestVersion(timeoutMs = 4000): Promise<UpdateCheck | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return null;
    const json = await resp.json() as { tag_name?: string };
    if (!json.tag_name) return null;
    const latest = json.tag_name.replace(/^v/, '');
    // Любое расхождение версий считаем «есть обновление» — позволяет
    // подхватить и более свежий релиз, и переезд на тег с меньшим номером
    // (когда последний на GitHub оказался ниже установленного).
    return { current: VERSION, latest, hasUpdate: latest !== VERSION };
  } catch {
    return null;
  }
}

export async function selfUpdate(
  onStep:     (msg: string) => void = () => {},
  onProgress: (received: number, total: number) => void = () => {},
): Promise<string> {
  onStep('Проверяю обновления...');
  let release: { tag_name: string; assets: unknown[] };
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!resp.ok) throw new Error('GitHub API: HTTP ' + resp.status);
    release = await resp.json() as typeof release;
  } catch (e) {
    return 'Ошибка при проверке обновлений: ' + (e as Error).message;
  }

  const latest = release.tag_name.replace(/^v/, '');
  if (latest === VERSION) return `Уже установлена последняя версия v${VERSION}`;

  onStep(`Найдено обновление: v${VERSION} → v${latest}`);
  const url = `https://github.com/${REPO}/releases/download/v${latest}/${getPlatformBinary()}`;
  let data: Uint8Array;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const total = Number(resp.headers.get('content-length') ?? 0);
    const reader = resp.body?.getReader();
    if (!reader) throw new Error('нет тела ответа');

    const chunks: Uint8Array[] = [];
    let received = 0;
    onProgress(0, total);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(received, total);
    }
    data = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) { data.set(c, offset); offset += c.byteLength; }
  } catch (e) {
    return 'Ошибка при скачивании: ' + (e as Error).message;
  }

  const exePath = process.execPath;
  if (basename(exePath).toLowerCase().startsWith('bun'))
    return `Обновление доступно: v${VERSION} → v${latest}\nЗапустите install.sh чтобы обновить.`;

  onStep('Устанавливаю...');
  try {
    // Linux/macOS: нельзя перезаписать запущенный бинарник (ETXTBSY).
    // Решение: пишем во временный файл, затем rename() атомарно заменяет
    // directory entry. Старый inode живёт пока процесс не завершится.
    const { chmodSync, renameSync } = await import('fs');
    const tmpPath = exePath + '.tmp.' + process.pid;
    await Bun.write(tmpPath, data);
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, exePath);
    return `Обновлено: v${VERSION} → v${latest}. Перезапустите redos.`;
  } catch (e) {
    return 'Ошибка при установке: ' + (e as Error).message;
  }
}
