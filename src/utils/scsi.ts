/**
 * Склейка производителя и модели накопителя в одно имя.
 *
 * Поля SCSI INQUIRY фиксированной ширины: 8 байт под производителя и 16 под
 * модель, добитые пробелами. Источники дают их по-разному, и наивное
 * соединение через пробел портит имя во всех трёх случаях сразу:
 *
 *   sysfs  vendor="SPCC Sol" model="id State Disk"
 *          → название разрезано посередине слова границей полей
 *   lsblk  vendor="SPCC Sol" model="SPCC Solid State Disk"
 *          → модель уже нормализована, производитель дублируется
 *   lsblk  vendor="ATA     " model="KINGSTON SKC600/256G"
 *          → «ATA» это шина подключения, а не производитель
 *
 * Все три встретились на одной машине при проверке инвентаризации.
 */

/** Значения поля производителя, которые обозначают шину, а не изготовителя. */
const BUS_TAGS = new Set(['ata', 'scsi', 'usb', 'nvme', 'sata', 'sas', 'generic']);

export function joinScsiName(rawVendor: string | null | undefined,
                             rawModel:  string | null | undefined): string {
  const raw = rawVendor ?? '';
  const v = raw.trim();
  const m = (rawModel ?? '').trim();

  if (!v) return m;
  if (!m) return v;

  // Модель уже содержит имя производителя — второй раз не нужен
  if (m.toLowerCase().startsWith(v.toLowerCase())) return m;

  // «ATA», «USB» и подобное — это про подключение, в имени модели им не место
  if (BUS_TAGS.has(v.toLowerCase())) return m;

  // Поле производителя заполнено целиком (8 символов без добивки), а модель
  // начинается со строчной буквы — значит одно название разрезано границей
  // полей: "SPCC Sol" + "id State Disk".
  if (raw.length >= 8 && v.length === 8 && /^\p{Ll}/u.test(m)) return v + m;

  return `${v} ${m}`;
}
