import { basename } from 'path';
import { version as VERSION } from '../../package.json';

const REPO = 'netgomail/mycode';

export function getPlatformBinary(): string {
  if (process.platform === 'win32') return 'mycode.exe';
  if (process.platform === 'darwin')
    return process.arch === 'arm64' ? 'mycode-mac-arm' : 'mycode-mac-x64';
  return 'mycode-linux';
}

export async function selfUpdate(onProgress: (msg: string) => void = () => {}): Promise<string> {
  onProgress('Проверяю обновления...');
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

  onProgress(`Скачиваю v${latest}...`);
  const url = `https://github.com/${REPO}/releases/download/v${latest}/${getPlatformBinary()}`;
  let data: Uint8Array;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    data = new Uint8Array(await resp.arrayBuffer());
  } catch (e) {
    return 'Ошибка при скачивании: ' + (e as Error).message;
  }

  const exePath = process.execPath;
  if (basename(exePath).toLowerCase().startsWith('bun'))
    return `Обновление доступно: v${VERSION} → v${latest}\nЗапустите install.sh / install.ps1 чтобы обновить.`;

  try {
    if (process.platform === 'win32') {
      const newPath = exePath + '.new';
      await Bun.write(newPath, data);
      const pid = process.pid;
      const { spawn } = await import('child_process');
      // Ждём завершения текущего процесса по PID, затем заменяем файл с повторными попытками
      const ps = [
        `$p = ${pid}`,
        `while (Get-Process -Id $p -ErrorAction SilentlyContinue) { Start-Sleep 1 }`,
        `$i = 0`,
        `while ($i -lt 10) {`,
        `  try { Move-Item -Force '${newPath}' '${exePath}'; break } catch { Start-Sleep 2; $i++ }`,
        `}`,
      ].join('; ');
      spawn('powershell.exe',
        ['-WindowStyle', 'Hidden', '-Command', ps],
        { detached: true, stdio: 'ignore' }).unref();
      return `Обновление скачано: v${VERSION} → v${latest}\nЗамена выполнится после выхода. Перезапустите mycode.`;
    }
    // Linux/macOS: нельзя перезаписать запущенный бинарник (ETXTBSY).
    // Решение: пишем во временный файл, затем rename() атомарно заменяет
    // directory entry. Старый inode живёт пока процесс не завершится.
    const { chmodSync, renameSync } = await import('fs');
    const tmpPath = exePath + '.tmp.' + process.pid;
    await Bun.write(tmpPath, data);
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, exePath);
    return `Обновлено до v${latest}. Перезапустите mycode.`;
  } catch (e) {
    return 'Ошибка при установке: ' + (e as Error).message;
  }
}
