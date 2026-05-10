import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import {
  PRESETS,
  readPwQuality, readLoginDefs,
  applyPwQuality, applyLoginDefs,
  pwqDropinExists,
  listLocalUsers, applyChageDates, forcePasswordChange,
  detectCurrentUser,
  PWQ_DROPIN_FILE, LOGIN_DEFS_FILE,
} from '../features/passwordPolicy';
import type { Preset, PwQuality, LoginDefs, LocalUser } from '../features/passwordPolicy';
import type { FixResult } from '../utils/sudo';

interface Props {
  onExit: () => void;
}

type Phase = 'view' | 'users' | 'result';

type Action =
  | { id: 'preset'; preset: Preset; title: string; hint: string }
  | { id: 'force';                  title: string; hint: string };

const ACTIONS: Action[] = [
  { id: 'preset', preset: PRESETS[0], title: 'Применить пресет «Базовая»',   hint: PRESETS[0].hint + ' + обновить сроки пароля для отмеченных пользователей' },
  { id: 'preset', preset: PRESETS[1], title: 'Применить пресет «Усиленная»', hint: PRESETS[1].hint + ' + обновить сроки пароля для отмеченных пользователей' },
  { id: 'force',                      title: 'Потребовать смену пароля при следующем входе...', hint: 'для отмеченных пользователей будет запрошен новый пароль при логине' },
];

export function PasswordPolicyScreen({ onExit }: Props) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const [phase, setPhase] = useState<Phase>('view');

  const [pwq,   setPwq]   = useState<Partial<PwQuality>>(() => readPwQuality());
  const [login, setLogin] = useState<Partial<LoginDefs>>(() => readLoginDefs());
  const [hasDropin, setHasDropin] = useState(() => pwqDropinExists());

  const [actionIdx, setActionIdx] = useState(0);

  // users-list
  const [users, setUsers] = useState<LocalUser[]>([]);
  const [userIdx, setUserIdx] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [usersMode, setUsersMode] = useState<'preset' | 'force'>('preset');
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  const [currentUser] = useState<string | null>(() => detectCurrentUser());

  // результат (общий для пресетов и user-операций)
  const [resultTitle, setResultTitle] = useState('');
  const [resultLines, setResultLines] = useState<{ ok: boolean; text: string }[]>([]);

  const refreshPolicy = () => {
    setPwq(readPwQuality());
    setLogin(readLoginDefs());
    setHasDropin(pwqDropinExists());
  };

  const openUsers = (mode: 'preset' | 'force', preset: Preset | null) => {
    const list = listLocalUsers();
    setUsers(list);
    // По умолчанию отмечаем именно того, кто запустил redos (через sudo/pkexec) —
    // в норме это единственный non-system пользователь системы и нужен только он.
    // Если определить не удалось — отмечаем всех non-system как раньше.
    const def = new Set<string>();
    if (currentUser && list.find(u => u.name === currentUser)) {
      def.add(currentUser);
    } else {
      list.filter(u => !u.systemAccount).forEach(u => def.add(u.name));
    }
    setSelected(def);
    // Курсор тоже ставим на текущего пользователя, если он есть.
    const idx = currentUser ? list.findIndex(u => u.name === currentUser) : 0;
    setUserIdx(idx >= 0 ? idx : 0);
    setUsersMode(mode);
    setActivePreset(preset);
    setPhase('users');
  };

  const applyAction = () => {
    const targets = users.filter(u => selected.has(u.name));
    const lines: { ok: boolean; text: string }[] = [];

    if (usersMode === 'preset' && activePreset) {
      // Сначала пишем файлы политики (всегда), затем chage по отмеченным
      const r1 = applyPwQuality(activePreset.pwquality);
      const r2 = applyLoginDefs(activePreset.login);
      lines.push(lineFor('Сложность пароля → ' + PWQ_DROPIN_FILE, r1));
      lines.push(lineFor('Сроки пароля → '     + LOGIN_DEFS_FILE, r2));
      for (const u of targets) {
        const r = applyChageDates(u.name, activePreset.login);
        lines.push(lineFor(`Сроки пароля для ${u.name}`, r));
      }
      const noun = targets.length === 1 ? 'пользователя' : 'пользователей';
      setResultTitle(
        `Пресет «${activePreset.title}» применён` +
        (targets.length > 0 ? `, сроки обновлены для ${targets.length} ${noun}` : ' (пользователи не выбраны)'),
      );
    } else {
      for (const u of targets) {
        const r = forcePasswordChange(u.name);
        lines.push(lineFor(`Смена пароля при следующем входе для ${u.name}`, r));
      }
      const noun = targets.length === 1 ? 'пользователю' : 'пользователям';
      setResultTitle(`Смена пароля будет запрошена ${targets.length} ${noun} при следующем входе`);
    }

    setResultLines(lines);
    setPhase('result');
    refreshPolicy();
  };

  useInput((char, key) => {
    if (phase === 'view') {
      if (char === 'q' || key.escape) { onExit(); return; }
      if (key.upArrow)   setActionIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setActionIdx(i => Math.min(ACTIONS.length - 1, i + 1));
      if (key.return) {
        const a = ACTIONS[actionIdx];
        if (a.id === 'preset') openUsers('preset', a.preset);
        else openUsers('force', null);
      }
      return;
    }

    if (phase === 'users') {
      if (char === 'q' || key.escape) { setPhase('view'); return; }
      if (key.upArrow)   setUserIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setUserIdx(i => Math.min(users.length - 1, i + 1));
      if (char === ' ') {
        const u = users[userIdx];
        if (!u) return;
        setSelected(prev => {
          const next = new Set(prev);
          if (next.has(u.name)) next.delete(u.name); else next.add(u.name);
          return next;
        });
      }
      if (char === 'a' || char === 'A') {
        setSelected(prev => {
          const allSelected = users.every(u => prev.has(u.name));
          return allSelected ? new Set() : new Set(users.map(u => u.name));
        });
      }
      if (key.return) {
        // preset можно применить даже без выбранных пользователей (только файлы);
        // force без выбора смысла не имеет
        if (usersMode === 'preset' || selected.size > 0) applyAction();
      }
      return;
    }

    if (phase === 'result') {
      if (char === 'q' || key.escape || key.return) {
        setPhase('view');
      }
    }
  });

  // ── Phase: result ───────────────────────────────────────────────────────────
  if (phase === 'result') {
    return (
      <Box flexDirection="column" width={width}>
        <Header width={width} subtitle="Готово" />
        <Box paddingLeft={3} marginBottom={1}>
          <Text color="white" bold>{resultTitle}</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          {resultLines.map((l, i) => (
            <Box key={i}>
              <Text color={l.ok ? 'green' : 'red'}>{l.ok ? '✓ ' : '✗ '}</Text>
              <Text color={l.ok ? 'gray' : 'red'}>{l.text}</Text>
            </Box>
          ))}
        </Box>
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>Q/Esc/Enter — назад</Text>
        </Box>
      </Box>
    );
  }

  // ── Phase: users ────────────────────────────────────────────────────────────
  if (phase === 'users') {
    const isPreset = usersMode === 'preset' && activePreset;
    const subtitle = isPreset
      ? `Применить пресет «${activePreset!.title}» — выберите пользователей`
      : 'Потребовать смену пароля — выберите пользователей';
    const p = activePreset;
    const explainLines = isPreset && p
      ? [
          `Минимум ${p.pwquality.minlen} символов, ${p.pwquality.minclass} разных классов символов, отличия от прошлого пароля — ${p.pwquality.difok} симв., попыток ввода — ${p.pwquality.retry}`,
          `Срок действия пароля: до ${p.login.PASS_MAX_DAYS} дн., менять не чаще раза в ${p.login.PASS_MIN_DAYS} дн., предупреждение за ${p.login.PASS_WARN_AGE} дн.`,
          `Для отмеченных ниже пользователей будут установлены те же сроки пароля.`,
        ]
      : ['При следующем входе отмеченные пользователи должны будут задать новый пароль.'];
    const noun = (n: number) => n === 1 ? 'пользователю' : 'пользователям';
    const enterHint = isPreset
      ? (selected.size > 0
          ? `Enter применить (политика + сроки для ${selected.size} ${noun(selected.size)})`
          : 'Enter применить (только политика, без обновления сроков)')
      : (selected.size > 0
          ? `Enter применить (для ${selected.size} ${noun(selected.size)})`
          : 'выберите пользователей');
    return (
      <Box flexDirection="column" width={width}>
        <Header width={width} subtitle={subtitle} />
        <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
          {explainLines.map((l, i) => (
            <Text key={i} color="yellow">{l}</Text>
          ))}
        </Box>
        {users.length === 0 ? (
          <Box paddingLeft={3} marginBottom={1}>
            <Text color="red">Не удалось прочитать /etc/passwd</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginBottom={1}>
            {users.map((u, i) => {
              const isCur  = i === userIdx;
              const isSel  = selected.has(u.name);
              const isYou  = currentUser === u.name;
              const dim    = u.systemAccount;
              return (
                <Box key={u.name} paddingLeft={2}>
                  <Text color={isCur ? 'white' : 'gray'}>{isCur ? '❯ ' : '  '}</Text>
                  <Text color={isSel ? 'green' : 'gray'}>{isSel ? '[✓] ' : '[ ] '}</Text>
                  <Text color={dim ? 'gray' : (isCur ? 'white' : 'gray')} dimColor={dim} bold={isCur && !dim}>
                    {u.name.padEnd(20)}
                  </Text>
                  {isYou && <Text color="cyan" bold>(вы) </Text>}
                  <Text color="gray" dimColor>
                    {`uid=${String(u.uid).padEnd(6)} `}
                    {u.systemAccount ? '[system] ' : ''}
                    {u.forced ? '[смена ожидается] ' : ''}
                    {u.lastChange ? `last=${u.lastChange} ` : ''}
                    {u.passwordExpires ? `до=${u.passwordExpires}` : ''}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>
            {`↑↓ выбор · Space отметить · A все · ${enterHint} · Q/Esc назад`}
          </Text>
        </Box>
      </Box>
    );
  }

  // ── Phase: view (главный экран) ─────────────────────────────────────────────
  const a = ACTIONS[actionIdx];
  return (
    <Box flexDirection="column" width={width}>
      <Header width={width} subtitle={hasDropin ? 'управляется redos' : 'исходные настройки системы'} />

      {/* Текущая сложность */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text color="cyan" bold>── Сложность · /etc/security/pwquality.conf{hasDropin ? '.d/50-redos.conf' : ''} ──</Text>
        </Box>
        <PolicyRow label="minlen"   value={pwq.minlen}   />
        <PolicyRow label="minclass" value={pwq.minclass} />
        <PolicyRow label="dcredit"  value={pwq.dcredit}  />
        <PolicyRow label="ucredit"  value={pwq.ucredit}  />
        <PolicyRow label="lcredit"  value={pwq.lcredit}  />
        <PolicyRow label="ocredit"  value={pwq.ocredit}  />
        <PolicyRow label="difok"    value={pwq.difok}    />
        <PolicyRow label="retry"    value={pwq.retry}    />
      </Box>

      {/* Текущий срок действия */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text color="cyan" bold>── Срок действия · /etc/login.defs ──</Text>
        </Box>
        <PolicyRow label="PASS_MAX_DAYS" value={login.PASS_MAX_DAYS} />
        <PolicyRow label="PASS_MIN_DAYS" value={login.PASS_MIN_DAYS} />
        <PolicyRow label="PASS_WARN_AGE" value={login.PASS_WARN_AGE} />
      </Box>

      {/* Действия */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text color="cyan" bold>── Действия ──</Text>
        </Box>
        {ACTIONS.map((act, i) => {
          const isSel = i === actionIdx;
          return (
            <Box key={i} paddingLeft={3}>
              <Text color={isSel ? 'white' : 'gray'}>{isSel ? '❯ ' : '  '}</Text>
              <Text color={isSel ? 'white' : 'gray'} bold={isSel}>{act.title}</Text>
            </Box>
          );
        })}
        {a && (
          <Box paddingLeft={5} marginTop={1}>
            <Text color="yellow">{'↳ ' + a.hint}</Text>
          </Box>
        )}
      </Box>

      {/* Подсказка */}
      <Box paddingLeft={2}>
        <Text color="gray" dimColor>↑↓ выбор · Enter применить · Q/Esc выход</Text>
      </Box>
    </Box>
  );
}

// ─── вспомогательные компоненты ───────────────────────────────────────────────

function PolicyRow({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Box paddingLeft={5}>
      <Text color="gray">{label.padEnd(16)}</Text>
      <Text color={value === undefined ? 'gray' : 'white'} dimColor={value === undefined}>
        {value === undefined ? '(не задано)' : `= ${value}`}
      </Text>
    </Box>
  );
}

function Header({ width, subtitle }: { width: number; subtitle: string }) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1} width={width}>
      <Text color="cyan" bold>◆  </Text>
      <Text bold>Парольная политика  </Text>
      <Text color="gray">{subtitle}</Text>
    </Box>
  );
}

function lineFor(label: string, r: FixResult): { ok: boolean; text: string } {
  return { ok: r.ok, text: `${label} — ${r.msg}` };
}

