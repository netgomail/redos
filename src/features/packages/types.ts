export interface PackageRecipe {
  name: string;
  description: string;
  version: string;
  category: string;
  files: string[];
  sha256: Record<string, string>;
  dependencies: string[];
  preCheck: string;
  install: string;
  postInstall: string[];
}

export interface Manifest {
  version: number;
  updated: string;
  packages: Record<string, PackageRecipe>;
}

export type PackageStatus =
  | 'installed'
  | 'available'
  | 'update'
  | 'downloading'
  | 'installing'
  | 'error'
  | 'empty';     // нет файлов в манифесте

export interface AppConfig {
  server: string;
  secret: string;
}

export interface InstallStep {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
}
