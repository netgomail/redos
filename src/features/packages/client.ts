import { createHmac } from 'crypto';
import type { AppConfig, Manifest } from './types';

function signRequest(file: string, secret: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update(file + timestamp)
    .digest('hex');
  return { timestamp, signature };
}

export async function fetchFromServer(
  config: AppConfig,
  file: string,
): Promise<Response> {
  if (!config.server) throw new Error('Сервер не настроен. Выполните /config server <url>');
  if (!config.secret) throw new Error('Секрет не задан. Выполните /config secret <ключ>');

  const { timestamp, signature } = signRequest(file, config.secret);
  const url = `${config.server}/download.php?file=${encodeURIComponent(file)}`;

  const resp = await fetch(url, {
    headers: {
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    },
  });

  if (resp.status === 403) throw new Error('Доступ запрещён — проверьте секрет');
  if (resp.status === 404) throw new Error(`Файл не найден: ${file}`);
  if (!resp.ok) throw new Error(`Ошибка сервера: ${resp.status}`);

  return resp;
}

export async function fetchManifest(config: AppConfig): Promise<Manifest> {
  const resp = await fetchFromServer(config, 'manifest.json');
  return resp.json() as Promise<Manifest>;
}

export async function downloadFile(
  config: AppConfig,
  file: string,
  destPath: string,
): Promise<void> {
  const resp = await fetchFromServer(config, file);
  const buf = await resp.arrayBuffer();
  await Bun.write(destPath, buf);
}
