import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { downloadFile } from './client';
import type { AppConfig, PackageRecipe, PackageStatus, InstallStep } from './types';

/** Проверяем, установлен ли пакет через preCheck */
export function checkInstalled(recipe: PackageRecipe): boolean {
  try {
    execSync(recipe.preCheck, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Определяем статус пакета */
export function getPackageStatus(recipe: PackageRecipe): PackageStatus {
  if (recipe.files.length === 0) return 'empty';
  if (checkInstalled(recipe)) return 'installed';
  return 'available';
}

/** Проверяем SHA256 файла */
function verifySha256(filePath: string, expected: string): boolean {
  const buf = readFileSync(filePath);
  const actual = createHash('sha256').update(buf).digest('hex');
  return actual === expected;
}

/** Проверяем зависимости */
export function checkDependencies(deps: string[]): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const dep of deps) {
    try {
      execSync(`rpm -q ${dep}`, { stdio: 'pipe' });
    } catch {
      missing.push(dep);
    }
  }
  return { ok: missing.length === 0, missing };
}

type OnStep = (steps: InstallStep[]) => void;

/** Полный процесс установки пакета */
export async function installPackage(
  config: AppConfig,
  id: string,
  recipe: PackageRecipe,
  onStep: OnStep,
): Promise<{ ok: boolean; error?: string }> {
  const tmpDir = join(tmpdir(), `redos-install-${id}`);
  mkdirSync(tmpDir, { recursive: true });

  const steps: InstallStep[] = [
    { label: 'Проверка зависимостей', status: 'pending' },
    ...recipe.files.map(f => ({ label: `Скачивание ${f.split('/').pop()}`, status: 'pending' as const })),
    { label: 'Проверка SHA256', status: 'pending' },
    { label: 'Установка rpm', status: 'pending' },
    ...recipe.postInstall.map(cmd => ({ label: `Настройка: ${cmd.split(' ').slice(0, 2).join(' ')}...`, status: 'pending' as const })),
  ];

  const update = (idx: number, status: InstallStep['status'], detail?: string) => {
    steps[idx] = { ...steps[idx], status, detail };
    onStep([...steps]);
  };

  let stepIdx = 0;

  try {
    // 1. Проверка зависимостей
    update(stepIdx, 'running');
    const deps = checkDependencies(recipe.dependencies);
    if (!deps.ok) {
      update(stepIdx, 'error', `Не найдены: ${deps.missing.join(', ')}`);
      return { ok: false, error: `Отсутствуют зависимости: ${deps.missing.join(', ')}` };
    }
    update(stepIdx, 'done');
    stepIdx++;

    // 2. Скачивание файлов
    const localFiles: string[] = [];
    for (const file of recipe.files) {
      update(stepIdx, 'running');
      const filename = file.split('/').pop()!;
      const dest = join(tmpDir, filename);
      await downloadFile(config, file, dest);
      localFiles.push(dest);
      update(stepIdx, 'done');
      stepIdx++;
    }

    // 3. Проверка SHA256
    update(stepIdx, 'running');
    for (let i = 0; i < recipe.files.length; i++) {
      const expected = recipe.sha256[recipe.files[i]];
      if (expected && !verifySha256(localFiles[i], expected)) {
        update(stepIdx, 'error', `Не совпадает: ${recipe.files[i].split('/').pop()}`);
        return { ok: false, error: `SHA256 не совпадает для ${recipe.files[i]}` };
      }
    }
    update(stepIdx, 'done');
    stepIdx++;

    // 4. Установка rpm
    update(stepIdx, 'running');
    try {
      execSync(`rpm -ivh ${localFiles.join(' ')}`, { stdio: 'pipe' });
    } catch (e) {
      const msg = (e as any).stderr?.toString() || (e as Error).message;
      update(stepIdx, 'error', msg.slice(0, 100));
      return { ok: false, error: `Ошибка rpm: ${msg}` };
    }
    update(stepIdx, 'done');
    stepIdx++;

    // 5. Post-install команды
    for (const cmd of recipe.postInstall) {
      update(stepIdx, 'running');
      try {
        execSync(cmd, { stdio: 'pipe' });
        update(stepIdx, 'done');
      } catch (e) {
        const msg = (e as any).stderr?.toString() || (e as Error).message;
        update(stepIdx, 'error', msg.slice(0, 100));
        // post-install ошибки не фатальные — продолжаем
      }
      stepIdx++;
    }

    // Чистим tmp
    for (const f of localFiles) {
      try { unlinkSync(f); } catch {}
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
