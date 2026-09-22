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
  allowedByCategories, categoriesOf, BLOCK_SCRIPT_BODY, portsToReauthorize,
  predictTarget, explainPolicy, describeKind, effectiveClass,
  appliedVersion, CURRENT_POLICY_VERSION,
} from './deviceControl';
import type { UsbDevice, PolicyInput, UsbSysfsDevice } from './deviceControl';

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

  test('рубеж по блочному узлу — только для дисков на USB', () => {
    const line = rules.split('\n').find(l => l.startsWith('SUBSYSTEM=="block"'))!;
    expect(line).toContain('ENV{DEVTYPE}=="disk"');
    expect(line).toContain('SUBSYSTEMS=="usb"');
    expect(line).toContain('--storage $devpath');
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

  test('вендорский интерфейс рядом с разрешённым не блокирует принтер', () => {
    // HP объявляет 07 и рядом свой ff. Категория «Принтеры» — locked, то есть
    // разрешена всегда, и аппарат обязан проходить при любой политике.
    expect(allowedByCategories(dev(['07:01:02', 'ff:cc:00']), new Set())).toBe(true);
    expect(allowedByCategories(dev(['07:01:02', '07:01:04', 'ff:ff:ff']), new Set())).toBe(true);
  });

  test('вендорский интерфейс не спасает выключенную категорию', () => {
    // Тот же принтер, но со слотом карт: 08 при запрещённых накопителях
    // блокирует, и «зато есть ff» тут ничего не меняет.
    expect(allowedByCategories(dev(['07:01:02', '08:06:50', 'ff:cc:00']), new Set())).toBe(false);
    expect(allowedByCategories(dev(['07:01:02', '08:06:50', 'ff:cc:00']), new Set(['storage']))).toBe(true);
  });

  test('одного вендорского класса мало, чтобы пройти', () => {
    // Разрешать нечем: ни один интерфейс не попадает в категорию.
    expect(allowedByCategories(dev(['ff:ff:ff']), new Set(['storage', 'video']))).toBe(false);
  });

  test('накопитель с клавиатурой блокируется и при разрешённых категориях', () => {
    // Повторяет правило 1 скрипта: BadUSB проверяется до разрешений.
    expect(allowedByCategories(dev(['08:06:50', '03:00:01']), new Set(['storage']))).toBe(false);
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
  /**
   * Интерфейсы: либо один класс («08»), либо класс с подклассом и протоколом
   * («ff:06:50») — тогда в sysfs лягут все три файла, как у настоящего.
   */
  interfaces: string[];
  policyText: string;
  vendor?:  string;
  product?: string;
  serial?:  string;
  /** Состояние authorized до прогона. По умолчанию устройство разрешено. */
  authorized?: '0' | '1';
  /**
   * Прогон рубежа по блочному узлу: скрипт зовётся так же, как из правила на
   * SUBSYSTEM=="block" — с путём диска, а не интерфейса.
   */
  storageNode?: boolean;
}

function decide(opts: ScriptCase): 'allow' | 'block' {
  const root = mkdtempSync(join(tmpdir(), 'redos-usb-'));
  try {
    const port = '2-4';
    const dev  = join(root, 'sys/devices/pci0000:00/usb2', port);
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, 'authorized'), opts.authorized ?? '1');
    writeFileSync(join(dev, 'idVendor'),  opts.vendor  ?? '24a9');
    writeFileSync(join(dev, 'idProduct'), opts.product ?? '205a');
    writeFileSync(join(dev, 'serial'),    opts.serial  ?? '89880401');
    opts.interfaces.forEach((spec: string, i: number) => {
      const iface = join(dev, `${port}:1.${i}`);
      mkdirSync(iface, { recursive: true });
      const [cls, sub, proto] = spec.split(':');
      writeFileSync(join(iface, 'bInterfaceClass'), cls!);
      if (sub)   writeFileSync(join(iface, 'bInterfaceSubClass'), sub);
      if (proto) writeFileSync(join(iface, 'bInterfaceProtocol'), proto);
    });

    // Блочный узел где-то под интерфейсом — так он и лежит у настоящей флешки:
    // .../2-4/2-4:1.0/host0/target0:0:0/0:0:0:0/block/sdb
    const nodePath = `/devices/pci0000:00/usb2/${port}/${port}:1.0/host0/block/sdb`;
    if (opts.storageNode) mkdirSync(join(root, 'sys' + nodePath), { recursive: true });
    const conf = join(root, 'policy.conf');
    writeFileSync(conf, opts.policyText);
    writeFileSync(join(root, 'mounts'), '');
    const script = join(root, 'block.sh');
    writeFileSync(script, BLOCK_SCRIPT_BODY
      .replace('conf=/etc/redos/device-control.conf', `conf=${conf}`)
      .replace('dev="/sys$1"', `dev="${root}/sys$1"`)
      .replace('while [ "$dev" != /sys ]', `while [ "$dev" != ${root}/sys ]`)
      .replace(/\/proc\/self\/mounts/g, join(root, 'mounts')), { mode: 0o755 });

    const args = opts.storageNode
      ? ['--storage', nodePath]
      : [`/devices/pci0000:00/usb2/${port}/${port}:1.0`];
    Bun.spawnSync(['sh', script, ...args], { stdout: 'pipe', stderr: 'pipe' });
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

  test('принтер с вендорским интерфейсом проходит при пустой политике', () => {
    // Ровно то, из-за чего ни один HP не работал: 07 разрешён всегда,
    // а ff не покрыт категориями и блокировать не должен.
    expect(decide({
      interfaces: ['07:01:02', 'ff:cc:00'],
      policyText: generatePolicy(policy()),
    })).toBe('allow');
  });

  test('принтер со слотом карт подчиняется запрету накопителей', () => {
    const ifaces = ['07:01:02', '08:06:50', 'ff:cc:00'];
    expect(decide({ interfaces: ifaces, policyText: generatePolicy(policy()) })).toBe('block');
    expect(decide({
      interfaces: ifaces,
      policyText: generatePolicy(policy({ allowed: ['storage'] })),
    })).toBe('allow');
  });

  test('устройство из одного вендорского класса не проходит', () => {
    expect(decide({
      interfaces: ['ff:ff:ff'],
      policyText: generatePolicy(policy({ allowed: ['storage', 'video'] })),
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

  test('накопитель с вендорским классом подчиняется категории', () => {
    // Встроенный картридер Realtek: класс ff, но подкласс 06 (SCSI) и
    // протокол 50 (Bulk-Only) — это накопитель, и ядро видит его так же.
    const asStorage = { interfaces: ['ff:06:50'] };
    expect(decide({ ...asStorage, policyText: generatePolicy(policy()) })).toBe('block');
    expect(decide({ ...asStorage, policyText: generatePolicy(policy({ allowed: ['storage'] })) }))
      .toBe('allow');
  });

  test('вендорский класс без SCSI-переноса остаётся вне категорий', () => {
    // Wi-Fi-донгл RTL8188 объявляет ff:ff:ff. Разрешить его можно только
    // поимённо: включение любой категории на него не действует.
    const dongle = { interfaces: ['ff:ff:ff'] };
    expect(decide({ ...dongle, policyText: generatePolicy(policy({ allowed: ['network', 'wireless'] })) }))
      .toBe('block');
    expect(decide({ ...dongle, policyText: generatePolicy(policy({
      trusted: [{ deviceId: '24a9:205a', serial: '89880401', name: '' }],
    })) })).toBe('allow');
  });

  test('накопитель, объявивший себя клавиатурой, ловится по блочному узлу', () => {
    // Обход политики по классам: устройство объявляет разрешённый класс, но
    // подставляет vid:pid известного накопителя — ядро привязывает драйвер по
    // идентификаторам, и usb-storage загружается мимо решения по классу.
    // По классу такое устройство проходит:
    expect(decide({ interfaces: ['03'], policyText: generatePolicy(policy()) })).toBe('allow');
    // а появившийся диск подделать уже нечем:
    expect(decide({ interfaces: ['03'], storageNode: true, policyText: generatePolicy(policy()) }))
      .toBe('block');
  });

  test('при разрешённых накопителях блочный узел не мешает', () => {
    expect(decide({
      interfaces: ['08'], storageNode: true,
      policyText: generatePolicy(policy({ allowed: ['storage'] })),
    })).toBe('allow');
  });

  test('доверенному устройству блочный узел разрешён', () => {
    expect(decide({
      interfaces: ['08'], storageNode: true,
      policyText: generatePolicy(policy({
        trusted: [{ deviceId: '24a9:205a', serial: '89880401', name: '' }],
      })),
    })).toBe('allow');
  });

  test('без файла политики скрипт ничего не блокирует', () => {
    expect(decide({ interfaces: ['08'], policyText: '' })).toBe('allow');
  });
});

// ─── накопитель, не назвавшийся накопителем ──────────────────────────────────

describe('опознание накопителя по SCSI-переносу', () => {
  test('вендорский класс с SCSI Bulk-Only считается накопителем', () => {
    expect(effectiveClass('ff:06:50')).toBe('08');
    expect(effectiveClass('ff:06:62')).toBe('08');   // UAS
  });

  test('вендорский класс без SCSI-переноса остаётся вендорским', () => {
    expect(effectiveClass('ff:ff:ff')).toBe('ff');
    expect(effectiveClass('ff')).toBe('ff');
  });

  test('картридер попадает в категорию накопителей, а не «вне категорий»', () => {
    expect(categoriesOf(['ff:06:50'])).toEqual(['storage']);
  });

  test('и подчиняется её галочке в обе стороны', () => {
    const reader: UsbDevice = {
      port: '1-12', target: 'allow', deviceId: '0bda:0129', name: '', serial: '',
      interfaces: ['ff:06:50'], categories: ['storage'], uncategorized: false,
    };
    expect(allowedByCategories(reader, new Set(['storage']))).toBe(true);
    expect(allowedByCategories(reader, new Set())).toBe(false);
    expect(explainPolicy(reader, new Set())).toContain('Накопители');
  });
});

describe('версия политики', () => {
  test('свежая политика не считается устаревшей', () => {
    expect(appliedVersion(generatePolicy(policy()))).toBe(CURRENT_POLICY_VERSION);
  });

  test('файл без отметки версии считается устаревшим', () => {
    const old = generatePolicy(policy()).split('\n')
      .filter(l => !l.startsWith('# redos-device-control-version:')).join('\n');
    expect(appliedVersion(old)).toBe(0);
  });

  test('чужой файл версии не имеет', () => {
    expect(appliedVersion('ALLOWED_CLASSES=03\n')).toBe(0);
  });
});

// ─── что видно про заблокированное устройство ────────────────────────────────

/**
 * Заблокированное устройство: интерфейсов нет, потому что ядро их не
 * конфигурирует. Так оно и выглядит в sysfs.
 */
const blockedDevice = (over: Partial<UsbDevice> = {}): UsbDevice => ({
  port: '1-4', target: 'block', deviceId: '2357:0109', name: '802.11n NIC',
  serial: '', interfaces: [], categories: [], uncategorized: false, ...over,
});

describe('устройство вне категорий', () => {
  test('вендорский класс не покрыт ни одной категорией — только поимённо', () => {
    const dongle = blockedDevice({ interfaces: ['ff:ff:ff'], target: 'allow' });
    expect(allowedByCategories(dongle, new Set(['network', 'wireless']))).toBe(false);
    expect(explainPolicy(dongle, new Set(['network', 'wireless'])))
      .toContain('ни одна категория его не покрывает');
  });

  test('выключенная категория названа по имени', () => {
    const flash = blockedDevice({ interfaces: ['08:06:50'], target: 'allow' });
    expect(explainPolicy(flash, new Set())).toContain('Накопители');
  });

  test('у заблокированного классы не выдумываются', () => {
    // Пустой список интерфейсов — это «не видно», а не «ни во что не попал»:
    // «вне категорий:» с пустым перечнем говорил ровно обратное.
    expect(describeKind(blockedDevice())).toBe('классы не видны');
    expect(explainPolicy(blockedDevice(), new Set())).toContain('не видны');
  });

  test('классы с последнего подключения подставляются с пометкой', () => {
    const d = blockedDevice({
      remembered: { model: '', kind: '', sizeBytes: 0, seen: '', interfaces: ['ff:ff:ff'] },
    });
    // В колонке — только коды: расшифровка словами не влезает, а обрезанная
    // не говорит ничего. Словами класс называет разбор под таблицей.
    expect(describeKind(d)).toBe('вне категорий ff');
    expect(explainPolicy(d, new Set())).toContain('последнего подключения');
  });
});

describe('прогноз состояния', () => {
  const flash = () => blockedDevice({
    remembered: { model: '', kind: '', sizeBytes: 0, seen: '', interfaces: ['08:06:50'] },
  });

  test('разрешённая категория поднимет заблокированное устройство', () => {
    expect(predictTarget(flash(), new Set(['storage']), false)).toBe('allow');
  });

  test('при выключенной категории останется заблокированным', () => {
    expect(predictTarget(flash(), new Set(), false)).toBe('block');
  });

  test('поимённое исключение сильнее категорий', () => {
    expect(predictTarget(flash(), new Set(), true)).toBe('allow');
  });

  test('про устройство без известных классов прогноза нет', () => {
    expect(predictTarget(blockedDevice(), new Set(['storage']), false)).toBe('unknown');
  });
});

// ─── возврат авторизации ─────────────────────────────────────────────────────

/**
 * Устройство, снятое с авторизации, теряет интерфейсы: ядро их не
 * конфигурирует. Ровно в таком виде оно и лежит в sysfs, пока заблокировано.
 */
const blockedSysfs = (over: Partial<UsbSysfsDevice> = {}): UsbSysfsDevice => ({
  port: '2-4', deviceId: '24a9:205a', serial: '89880401',
  manufacturer: '', product: '', authorized: false,
  interfaces: [], declared: [], storage: [], ...over,
});

describe('возврат авторизации перед прогоном правил', () => {
  test('снятая блокировка не действует, пока устройство не переавторизовано', () => {
    // Такой набор — заблокированная флешка при политике, которая её уже
    // разрешает. Правило висит на событии интерфейса, а интерфейсов нет:
    // решение по устройству не принимается, и оно остаётся заблокированным.
    expect(decide({
      interfaces: [],
      authorized: '0',
      policyText: generatePolicy(policy({ allowed: ['storage'] })),
    })).toBe('block');
  });

  test('после возврата авторизации разрешённое устройство проходит', () => {
    expect(decide({
      interfaces: ['08'],
      authorized: '1',
      policyText: generatePolicy(policy({ allowed: ['storage'] })),
    })).toBe('allow');
  });

  test('переподнимаются только заблокированные устройства', () => {
    const ports = portsToReauthorize([
      blockedSysfs({ port: '2-4' }),
      blockedSysfs({ port: '1-8', authorized: true, interfaces: ['03'] }),
    ]);
    expect(ports).toEqual(['2-4']);
  });

  test('корневые хабы не трогаются', () => {
    // authorized на контроллере относится ко всей шине: запись в него ради
    // одного устройства задела бы всё дерево.
    expect(portsToReauthorize([blockedSysfs({ port: 'usb2' })])).toEqual([]);
  });
});

test('всегда разрешённые категории нельзя выключить с экрана', () => {
  for (const id of LOCKED_CATEGORIES) {
    expect(CATEGORIES.find(c => c.id === id)?.locked).toBe(true);
  }
});
