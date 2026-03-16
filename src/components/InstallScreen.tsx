import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { loadConfig } from '../features/packages/config';
import { fetchManifest } from '../features/packages/client';
import { getPackageStatus, installPackage } from '../features/packages/installer';
import type { Manifest, PackageRecipe, PackageStatus, InstallStep, AppConfig } from '../features/packages/types';

interface Props {
  onExit: () => void;
}

type Phase = 'loading' | 'list' | 'installing' | 'done' | 'error';

const STATUS_ICON: Record<PackageStatus, string> = {
  installed:   '✓',
  available:   '↓',
  update:      '⟳',
  downloading: '…',
  installing:  '…',
  error:       '✗',
  empty:       '—',
};

const STATUS_COLOR: Record<PackageStatus, string> = {
  installed:   'green',
  available:   'cyan',
  update:      'yellow',
  downloading: 'gray',
  installing:  'gray',
  error:       'red',
  empty:       'gray',
};

const STATUS_LABEL: Record<PackageStatus, string> = {
  installed:   'установлен',
  available:   'доступен',
  update:      'обновление',
  downloading: 'скачивание',
  installing:  'установка',
  error:       'ошибка',
  empty:       'нет файлов',
};

const STEP_ICON = { pending: '○', running: '◌', done: '✓', error: '✗' };
const STEP_COLOR = { pending: 'gray', running: 'cyan', done: 'green', error: 'red' };

export function InstallScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const [config] = useState<AppConfig>(() => loadConfig());
  const [phase, setPhase] = useState<Phase>('loading');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [statuses, setStatuses] = useState<Map<string, PackageStatus>>(new Map());
  const [selected, setSelected] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [installSteps, setInstallSteps] = useState<InstallStep[]>([]);
  const [installResult, setInstallResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const pkgEntries = useMemo(() => {
    if (!manifest) return [];
    return Object.entries(manifest.packages);
  }, [manifest]);

  // Загрузка манифеста
  useEffect(() => {
    if (!config.server || !config.secret) {
      setErrorMsg('Сервер не настроен. Выполните:\n  /config server <url>\n  /config secret <ключ>');
      setPhase('error');
      return;
    }

    fetchManifest(config)
      .then(m => {
        setManifest(m);
        // Определяем статусы
        const map = new Map<string, PackageStatus>();
        for (const [id, recipe] of Object.entries(m.packages)) {
          map.set(id, getPackageStatus(recipe));
        }
        setStatuses(map);
        setPhase('list');
      })
      .catch(e => {
        setErrorMsg(e.message);
        setPhase('error');
      });
  }, [config]);

  // Запуск установки
  const startInstall = async () => {
    const [id, recipe] = pkgEntries[selected];
    const status = statuses.get(id);
    if (status !== 'available' && status !== 'update') return;

    setPhase('installing');
    setInstallSteps([]);
    setInstallResult(null);

    const result = await installPackage(config, id, recipe, setInstallSteps);
    setInstallResult(result);

    if (result.ok) {
      setStatuses(prev => new Map(prev).set(id, 'installed'));
    }
    setPhase('done');
  };

  useInput((char, key) => {
    if (phase === 'loading') return;

    if (char === 'q' || key.escape) {
      if (phase === 'done' || phase === 'error') {
        setPhase('list');
        setInstallResult(null);
        setInstallSteps([]);
        setErrorMsg('');
        return;
      }
      onExit();
      return;
    }

    if (phase !== 'list') return;

    if (key.upArrow) setSelected(i => Math.max(0, i - 1));
    if (key.downArrow) setSelected(i => Math.min(pkgEntries.length - 1, i + 1));

    if (key.return) {
      startInstall();
    }
  });

  // ── Фаза: загрузка ───────────────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <Box flexDirection="column" width={width}>
        <Header width={width} subtitle="Загрузка манифеста..." />
        <Box paddingLeft={4}>
          <Text color="cyan">◌ </Text>
          <Text color="gray">Подключение к {config.server}...</Text>
        </Box>
      </Box>
    );
  }

  // ── Фаза: ошибка ─────────────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <Box flexDirection="column" width={width}>
        <Header width={width} subtitle="Ошибка" />
        <Box paddingLeft={4} flexDirection="column">
          {errorMsg.split('\n').map((line, i) => (
            <Text key={i} color="red">{line}</Text>
          ))}
        </Box>
        <Box paddingLeft={2} marginTop={1}>
          <Text color="gray" dimColor>Q/Esc назад</Text>
        </Box>
      </Box>
    );
  }

  // ── Фаза: установка / результат ───────────────────────────────────────────
  if (phase === 'installing' || phase === 'done') {
    const [id, recipe] = pkgEntries[selected];
    return (
      <Box flexDirection="column" width={width}>
        <Header width={width} subtitle={`Установка ${recipe.name} ${recipe.version}`} />
        <Box flexDirection="column" paddingLeft={3}>
          {installSteps.map((step, i) => (
            <Box key={i}>
              <Text color={STEP_COLOR[step.status]}>{STEP_ICON[step.status]} </Text>
              <Text color={step.status === 'running' ? 'white' : 'gray'}>
                {step.label}
              </Text>
              {step.detail && (
                <Text color={step.status === 'error' ? 'red' : 'gray'}>{`  ${step.detail}`}</Text>
              )}
            </Box>
          ))}
        </Box>
        {installResult && (
          <Box paddingLeft={3} marginTop={1}>
            {installResult.ok
              ? <Text color="green" bold>✓ {recipe.name} успешно установлен</Text>
              : <Text color="red" bold>✗ {installResult.error}</Text>
            }
          </Box>
        )}
        {phase === 'done' && (
          <Box paddingLeft={2} marginTop={1}>
            <Text color="gray" dimColor>Q/Esc назад к списку</Text>
          </Box>
        )}
      </Box>
    );
  }

  // ── Фаза: список пакетов ─────────────────────────────────────────────────
  const selectedEntry = pkgEntries[selected];
  const canInstall = selectedEntry && (statuses.get(selectedEntry[0]) === 'available' || statuses.get(selectedEntry[0]) === 'update');

  return (
    <Box flexDirection="column" width={width}>
      <Header width={width} subtitle={`${manifest!.updated}  ·  ${pkgEntries.length} пакетов`} />

      {/* Таблица пакетов */}
      <Box flexDirection="column" marginBottom={1}>
        {pkgEntries.map(([id, recipe], idx) => {
          const isSelected = idx === selected;
          const status = statuses.get(id) ?? 'empty';
          return (
            <Box key={id} paddingLeft={2}>
              <Text color={isSelected ? 'white' : 'gray'}>
                {isSelected ? '❯ ' : '  '}
              </Text>
              <Text color={STATUS_COLOR[status]}>
                {`[${STATUS_ICON[status]}] `}
              </Text>
              <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                {recipe.name.padEnd(28)}
              </Text>
              <Text color="gray">
                {recipe.version.padEnd(16)}
              </Text>
              <Text color={STATUS_COLOR[status]}>
                {STATUS_LABEL[status]}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Описание выбранного пакета */}
      {selectedEntry && (
        <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
          <Text color="gray">{selectedEntry[1].description}</Text>
          {selectedEntry[1].files.length > 0 && (
            <Text color="gray" dimColor>
              {'Файлы: ' + selectedEntry[1].files.map(f => f.split('/').pop()).join(', ')}
            </Text>
          )}
        </Box>
      )}

      {/* Подвал */}
      <Box paddingLeft={2}>
        <Text color="gray" dimColor>
          {'↑↓ выбор' + (canInstall ? '  ·  Enter установить' : '') + '  ·  Q/Esc выход'}
        </Text>
      </Box>
    </Box>
  );
}

// ── Заголовок экрана ──────────────────────────────────────────────────────────

function Header({ width, subtitle }: { width: number; subtitle: string }) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1} width={width}>
      <Text color="cyan" bold>◆  </Text>
      <Text bold>Установка пакетов  </Text>
      <Text color="gray">{subtitle}</Text>
    </Box>
  );
}
