/**
 * Проверки политики контроля устройств.
 *
 * Проверяется то, что нельзя проверить руками на живой машине без риска:
 * что в правила не попадает разрешение шире задуманного и что применённая
 * политика читается обратно ровно такой, какой её записали.
 *
 * Запуск: bun test
 */
import { describe, test, expect } from 'bun:test';
import {
  CATEGORIES, TOKEN_DEVICE_IDS,
  generateRules, generateDaemonConf, parseAppliedPolicy, validatePolicyInput,
  parseDeviceLine, allowedByCategories, categoriesOf,
} from './usbGuard';
import type { GuardDevice, PolicyInput } from './usbGuard';

/** Хеш в том виде, в каком его отдаёт usbguard: base64 от SHA-256. */
const HASH = 'jEP/6WzviqdJ5VSeTUY8PatCNBKeaREvo2OqWCZJhXw=';

const policy = (over: Partial<PolicyInput> = {}): PolicyInput =>
  ({ allowed: [], trusted: [], ...over });

describe('правила токенов', () => {
  const rules = generateRules(policy());

  test('разрешения на весь идентификатор производителя нет', () => {
    expect(rules).not.toContain('0a89:*');
  });

  test('каждая модель разрешена отдельным правилом с запретом накопителя', () => {
    const withGuard = rules.match(/^allow id 0a89:\S+ with-interface none-of \{ 08:\*:\* \}$/gm) ?? [];
    expect(withGuard).toHaveLength(TOKEN_DEVICE_IDS.length);
  });

  test('подложная флешка с идентификатором токена не проходит', () => {
    const fake = { deviceId: '0a89:0030', interfaces: ['08:06:50'], serial: '', hash: 'x' } as GuardDevice;
    expect(allowedByCategories(fake, new Set())).toBe(false);
  });

  test('настоящий токен проходит и при закрытых категориях', () => {
    const token = { deviceId: '0a89:0030', interfaces: ['0b:00:00'], serial: '', hash: 'y' } as GuardDevice;
    expect(allowedByCategories(token, new Set())).toBe(true);
  });
});

describe('исключения', () => {
  test('исключение без единого признака не даёт правила «allow»', () => {
    const rules = generateRules(policy({
      trusted: [{ deviceId: '', serial: '', hash: '', name: 'пустое' }],
    }));
    expect(rules).not.toMatch(/^allow\s*$/m);
    expect(rules).not.toContain('пустое');
  });

  test('исключение с хешем попадает в правила целиком', () => {
    const rules = generateRules(policy({
      trusted: [{ deviceId: '24a9:205a', serial: 'S1', hash: HASH, name: 'Флешка' }],
    }));
    expect(rules).toContain(`allow id 24a9:205a serial "S1" hash "${HASH}"`);
  });
});

describe('проверка политики до записи', () => {
  test('неизвестная категория', () => {
    const errors = validatePolicyInput(policy({ allowed: ['странная' as never] }));
    expect(errors.join()).toContain('неизвестная категория');
  });

  test('идентификатор не того вида', () => {
    const errors = validatePolicyInput(policy({
      trusted: [{ deviceId: '0a89:что-то', serial: '', hash: HASH, name: '' }],
    }));
    expect(errors.join()).toContain('24a9:205a');
  });

  test('хеш с кавычкой, ломающей правило', () => {
    const errors = validatePolicyInput(policy({
      trusted: [{ deviceId: '', serial: '', hash: 'abc" allow', name: '' }],
    }));
    expect(errors.join()).toContain('хеш');
  });

  test('один и тот же хеш дважды', () => {
    const errors = validatePolicyInput(policy({
      trusted: [
        { deviceId: '', serial: '', hash: HASH, name: 'первое' },
        { deviceId: '', serial: '', hash: HASH, name: 'второе' },
      ],
    }));
    expect(errors.join()).toContain('уже разрешён');
  });

  test('корректная политика ошибок не даёт', () => {
    const errors = validatePolicyInput(policy({
      allowed: ['storage', 'video'],
      trusted: [{ deviceId: '24a9:205a', serial: 'S1', hash: HASH, name: 'Флешка' }],
    }));
    expect(errors).toEqual([]);
  });
});

describe('чтение применённой политики', () => {
  const input = policy({
    allowed: ['video', 'network'],
    trusted: [{ deviceId: '24a9:205a', serial: 'S1', hash: HASH, name: 'Флешка' }],
  });
  const applied = parseAppliedPolicy(generateRules(input));

  test('категории возвращаются те же, что записали', () => {
    expect(applied).not.toBeNull();
    expect(applied!.allowed).toContain('video');
    expect(applied!.allowed).toContain('network');
    expect(applied!.allowed).not.toContain('storage');
  });

  test('правила токенов не выдаются за исключения', () => {
    expect(applied!.trusted.map(t => t.deviceId)).toEqual(['24a9:205a']);
    expect(applied!.trusted[0].hash).toBe(HASH);
  });

  test('файл без маркера читается по классам интерфейсов', () => {
    const old = generateRules(input).split('\n')
      .filter(l => !l.startsWith('# redos-device-control-categories:'))
      .join('\n');
    const parsed = parseAppliedPolicy(old);
    expect(parsed!.allowed).toContain('video');
    expect(parsed!.allowed).toContain('network');
    expect(parsed!.allowed).not.toContain('storage');
  });

  test('чужой файл не разбирается', () => {
    expect(parseAppliedPolicy('allow with-interface match-all { 08:*:* }')).toBeNull();
    expect(parseAppliedPolicy(null)).toBeNull();
  });
});

describe('категории и классы интерфейсов', () => {
  test('накопитель опознаётся по классу 08, вендорский класс — нет', () => {
    expect(categoriesOf(['08:06:50'])).toContain('storage');
    expect(categoriesOf(['ff:06:50'])).not.toContain('storage');
  });

  test('составное устройство «клавиатура + накопитель» не проходит по одному HID', () => {
    const d = parseDeviceLine(
      '12: block id 1234:5678 serial "s" name "x" hash "' + HASH +
      '" via-port "2-4" with-interface { 03:01:01 08:06:50 }');
    expect(d).not.toBeNull();
    expect(allowedByCategories(d!, new Set(['input']))).toBe(false);
  });
});

describe('конфигурация демона', () => {
  const conf = generateDaemonConf('');

  test('обязательные параметры выставлены', () => {
    expect(conf).toContain('ImplicitPolicyTarget=block');
    expect(conf).toContain('PresentDevicePolicy=apply-policy');
    expect(conf).toContain('InsertedDevicePolicy=apply-policy');
    expect(conf).toContain('RestoreControllerDeviceState=false');
  });

  test('чужие параметры сохраняются, наши заменяются', () => {
    const out = generateDaemonConf('AuditFilePath=/var/log/x\nImplicitPolicyTarget=allow\n');
    expect(out).toContain('AuditFilePath=/var/log/x');
    expect(out).toContain('ImplicitPolicyTarget=block');
    expect(out).not.toContain('ImplicitPolicyTarget=allow');
  });
});

describe('состав категорий', () => {
  test('у каждой категории либо классы, либо идентификаторы', () => {
    for (const c of CATEGORIES) {
      expect(c.classes.length > 0 || (c.ids?.length ?? 0) > 0).toBe(true);
    }
  });
});
