/**
 * Проверки политики контроля устройств.
 *
 * Проверяется то, что нельзя проверить руками на живой машине без риска:
 * что политика не разрешает шире задуманного, что применённая политика
 * читается обратно ровно такой, какой её записали, и что скрипт решения
 * принимает верное решение по набору интерфейсов.
 *
 * Запуск: bun test
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CATEGORIES, TOKEN_DEVICE_IDS, LOCKED_CATEGORIES,
  generatePolicy, generateRules, parseAppliedPolicy, validatePolicyInput,
  allowedByCategories, categoriesOf, BLOCK_SCRIPT_BODY,
} from './deviceControl';
import type { UsbDevice, PolicyInput } from './deviceControl';

const policy = (over: Partial<PolicyInput> = {}): PolicyInput =>
  ({ allowed: [], trusted: [], ...over });

const classesOf = (text: string): string[] =>
  (text.match(/^ALLOWED_CLASSES=(.*)$/m)?.[1] ?? '').split(' ').filter(Boolean);

describe('файл политики', () => {
  test('без выбранных категорий разрешены только всегда разрешённые классы', () => {
    const classes = classesOf(generatePolicy(policy()));
    const lockedClasses = new Set(CATEGORIES.filter(c => c.locked)
      .flatMap(c => c.classes).map(p => p.split(':')[0]));
    for (const c of classes) expect(lockedClasses.has(c)).toBe(true);
    // накопители не разрешены, пока их не выбрали
    expect(classes).not.toContain('08');
  });

  test('выбор категории добавляет её классы', () => {
    const classes = classesOf(generatePolicy(policy({ allowed: ['storage'] })));
    expect(classes).toContain('08');
  });

  test('сеть — это два класса, и оба попадают в политику', () => {
    const classes = classesOf(generatePolicy(policy({ allowed: ['network'] })));
    expect(classes).toContain('02');
    expect(classes).toContain('0a');
  });

  test('токены перечислены поимённо, без разрешения всего производителя', () => {
    const text = generatePolicy(policy());
    expect(text).not.toContain('0a89:*');
    expect(text).toContain(TOKEN_DEVICE_IDS[0]);
  });

  test('серийный номер с пробелом не попадает в файл через проверку', () => {
    const errors = validatePolicyInput(policy({
      trusted: [{ deviceId: '24a9:205a', serial: 'A B', name: '' }],
    }));
    expect(errors.length).toBeGreaterThan(0);
  });

  test('кривой идентификатор отклоняется', () => {
    expect(validatePolicyInput(policy({
      trusted: [{ deviceId: 'zzzz', serial: '1', name: '' }],
    })).length).toBeGreaterThan(0);
  });
});

describe('чтение применённой политики', () => {
  test('категории и доверенные читаются обратно без потерь', () => {
    const input = policy({
      allowed: ['storage', 'network'],
      trusted: [{ deviceId: '24a9:205a', serial: '89880401', name: 'Kingston DataTraveler' }],
    });
    const back = parseAppliedPolicy(generatePolicy(input));
    expect(back).not.toBeNull();
    expect(back!.allowed).toContain('storage');
    expect(back!.allowed).toContain('network');
    expect(back!.trusted).toHaveLength(1);
    expect(back!.trusted[0]).toMatchObject({
      deviceId: '24a9:205a', serial: '89880401', name: 'Kingston DataTraveler',
    });
  });

  test('устройство без серийного номера читается обратно', () => {
    const back = parseAppliedPolicy(generatePolicy(policy({
      trusted: [{ deviceId: '090c:1000', serial: '', name: 'без S/N' }],
    })));
    expect(back!.trusted[0]).toMatchObject({ deviceId: '090c:1000', serial: '' });
  });

  test('чужой файл не считается нашей политикой', () => {
    expect(parseAppliedPolicy('ALLOWED_CLASSES=08\n')).toBeNull();
    expect(parseAppliedPolicy(null)).toBeNull();
  });
});

describe('правило udev', () => {
  const rules = generateRules();

  test('срабатывает на интерфейсе, где класс уже известен ядру', () => {
    expect(rules).toContain('ENV{DEVTYPE}!="usb_interface"');
  });

  test('вызывает скрипт решения', () => {
    expect(rules).toContain('RUN+="/usr/local/sbin/redos-block-usb.sh $devpath"');
  });
});

describe('категории устройства', () => {
  const dev = (interfaces: string[], deviceId = '1234:5678'): UsbDevice => ({
    port: '2-4', target: 'allow', deviceId, name: '', serial: '',
    interfaces, categories: categoriesOf(interfaces, deviceId), uncategorized: false,
  });

  test('устройство проходит, только если разрешены все его интерфейсы', () => {
    // Накопитель с камерой: обе категории выключаемые, поэтому видно,
    // что одной разрешённой мало — нужна каждая.
    const composite = dev(['08:06:50', '0e:01:00']);
    expect(allowedByCategories(composite, new Set(['storage']))).toBe(false);
    expect(allowedByCategories(composite, new Set(['video']))).toBe(false);
    expect(allowedByCategories(composite, new Set(['storage', 'video']))).toBe(true);
  });

  test('всегда разрешённый класс не тянет за собой выключенный', () => {
    // Клавиатура (03) разрешена всегда, накопитель (08) — нет
    expect(allowedByCategories(dev(['08:06:50', '03:00:01']), new Set())).toBe(false);
  });

  test('токен опознаётся по идентификатору, а не по классу', () => {
    expect(categoriesOf(['03:00:00'], TOKEN_DEVICE_IDS[0])).toContain('token');
  });

  test('токен, объявляющий накопитель, поблажки не получает', () => {
    const fake = dev(['08:06:50'], TOKEN_DEVICE_IDS[0]);
    expect(allowedByCategories(fake, new Set())).toBe(false);
  });
});

// ─── скрипт решения ──────────────────────────────────────────────────────────

/**
 * Прогон настоящего sh-скрипта на фиктивном дереве sysfs.
 *
 * Пути в скрипте абсолютные, поэтому для теста они переставляются на корень
 * временного каталога. Логика — та же самая, что уедет на машину.
 */
interface ScriptCase {
  /** Классы интерфейсов, как они лежат в sysfs: ['08', '03']. */
  interfaces: string[];
  policyText: string;
  vendor?:  string;
  product?: string;
  serial?:  string;
}

function decide(opts: ScriptCase): 'allow' | 'block' {
  const root = mkdtempSync(join(tmpdir(), 'redos-usb-'));
  try {
    const port = '2-4';
    const dev  = join(root, 'sys/devices/pci0000:00/usb2', port);
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, 'authorized'), '1');
    writeFileSync(join(dev, 'idVendor'),  opts.vendor  ?? '24a9');
    writeFileSync(join(dev, 'idProduct'), opts.product ?? '205a');
    writeFileSync(join(dev, 'serial'),    opts.serial  ?? '89880401');
    opts.interfaces.forEach((cls: string, i: number) => {
      const iface = join(dev, `${port}:1.${i}`);
      mkdirSync(iface, { recursive: true });
      writeFileSync(join(iface, 'bInterfaceClass'), cls);
    });
    const conf = join(root, 'policy.conf');
    writeFileSync(conf, opts.policyText);
    writeFileSync(join(root, 'mounts'), '');
    const script = join(root, 'block.sh');
    writeFileSync(script, BLOCK_SCRIPT_BODY
      .replace('conf=/etc/redos/device-control.conf', `conf=${conf}`)
      .replace('dev="/sys$1"', `dev="${root}/sys$1"`)
      .replace('while [ "$dev" != /sys ]', `while [ "$dev" != ${root}/sys ]`)
      .replace(/\/proc\/self\/mounts/g, join(root, 'mounts')), { mode: 0o755 });

    Bun.spawnSync(['sh', script, `/devices/pci0000:00/usb2/${port}/${port}:1.0`],
                  { stdout: 'pipe', stderr: 'pipe' });
    return readSync(join(dev, 'authorized')) === '0' ? 'block' : 'allow';
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readSync(p: string): string {
  return require('fs').readFileSync(p, 'utf-8').trim();
}

describe('скрипт решения', () => {
  test('накопитель блокируется, пока категория не разрешена', () => {
    expect(decide({ interfaces: ['08'], policyText: generatePolicy(policy()) })).toBe('block');
  });

  test('разрешённая категория пропускает устройство', () => {
    expect(decide({
      interfaces: ['08'],
      policyText: generatePolicy(policy({ allowed: ['storage'] })),
    })).toBe('allow');
  });

  test('клавиатура работает даже при пустой политике', () => {
    expect(decide({ interfaces: ['03'], policyText: generatePolicy(policy()) })).toBe('allow');
  });

  test('накопитель + клавиатура блокируется, даже когда разрешены обе категории', () => {
    expect(decide({
      interfaces: ['08', '03'],
      policyText: generatePolicy(policy({ allowed: ['storage'] })),
    })).toBe('block');
  });

  test('доверенное устройство проходит при закрытой категории', () => {
    const text = generatePolicy(policy({
      trusted: [{ deviceId: '24a9:205a', serial: '89880401', name: 'флешка' }],
    }));
    expect(decide({ interfaces: ['08'], policyText: text })).toBe('allow');
  });

  test('доверенное опознаётся по связке ид+серийник, а не по одному серийнику', () => {
    const text = generatePolicy(policy({
      trusted: [{ deviceId: '24a9:205a', serial: '89880401', name: 'флешка' }],
    }));
    expect(decide({
      interfaces: ['08'], policyText: text, vendor: '090c', product: '1000',
    })).toBe('block');
  });

  test('криптотокен проходит при пустой политике', () => {
    const [vendor, product] = TOKEN_DEVICE_IDS[0].split(':');
    expect(decide({
      interfaces: ['0b'], policyText: generatePolicy(policy()), vendor, product,
    })).toBe('allow');
  });

  test('подделка под токен с накопительным интерфейсом блокируется', () => {
    const [vendor, product] = TOKEN_DEVICE_IDS[0].split(':');
    expect(decide({
      interfaces: ['08'], policyText: generatePolicy(policy()), vendor, product,
    })).toBe('block');
  });

  test('без файла политики скрипт ничего не блокирует', () => {
    expect(decide({ interfaces: ['08'], policyText: '' })).toBe('allow');
  });
});

test('всегда разрешённые категории нельзя выключить с экрана', () => {
  for (const id of LOCKED_CATEGORIES) {
    expect(CATEGORIES.find(c => c.id === id)?.locked).toBe(true);
  }
});
