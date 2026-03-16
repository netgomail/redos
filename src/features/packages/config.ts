import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AppConfig } from './types';

const CONFIG_DIR = join(homedir(), '.config', 'redos');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: AppConfig = {
  server: '',
  secret: '',
};

export function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: AppConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

export function maskSecret(secret: string): string {
  if (!secret) return '(не задан)';
  if (secret.length <= 8) return '****';
  return secret.slice(0, 4) + '****' + secret.slice(-4);
}
