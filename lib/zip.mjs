/**
 * Минимальный ZIP-писатель на чистом Node (без внешних зависимостей).
 *
 * Записи кладутся без сжатия (method 0, store): для docx этого достаточно,
 * а отсутствие deflate убирает целый класс ошибок с размерами и контрольными
 * суммами. Формат — обычный ZIP (local file headers + central directory + EOCD),
 * поэтому файл открывается Word, LibreOffice, Explorer и unzip.
 */

import { Buffer } from "node:buffer";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 (IEEE 802.3) от буфера/строки — нужен и писателю, и проверочному скрипту. */
export function crc32(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS-время/дата для заголовков (ZIP не умеет годы до 1980 и хранит секунды парами). */
function dosDateTime(value) {
  const d = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError("zipStore: данные записи должны быть Buffer, Uint8Array или строкой");
}

function normalizeName(raw) {
  const name = String(raw ?? "");
  if (!name) throw new Error("zipStore: у записи пустое имя");
  if (name.includes("\0")) throw new Error("zipStore: NUL-символ в имени записи");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new Error(`zipStore: абсолютный путь недопустим («${name}»)`);
  // В ZIP разделитель — всегда «/», поэтому обратные слэши Windows аккуратно приводим.
  const normalized = name.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) throw new Error(`zipStore: «..» в имени записи недопустим («${name}»)`);
  return normalized;
}

/**
 * Собирает ZIP-архив из записей.
 * @param {{ name: string, data: Buffer | Uint8Array | string }[]} entries
 * @param {{ date?: Date }} [options] — date фиксирует отметку времени (удобно для тестов)
 * @returns {Buffer}
 */
export function zipStore(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError("zipStore: entries должен быть непустым массивом");
  }
  if (entries.length > 0xffff) {
    throw new RangeError("zipStore: больше 65535 записей без ZIP64 не поддерживается");
  }

  const { time, date } = dosDateTime(options.date);
  const localParts = [];
  const centralParts = [];
  const seen = new Set();
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeName(entry?.name);
    if (seen.has(name)) throw new Error(`zipStore: дубликат имени записи «${name}»`);
    seen.add(name);

    const data = toBuffer(entry?.data);
    if (data.length > 0xffffffff) throw new RangeError(`zipStore: запись «${name}» больше 4 ГиБ`);
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length > 0xffff) throw new RangeError(`zipStore: имя записи «${name}» длиннее 65535 байт`);

    const crc = crc32(data);

    // Local file header: 30 байт + имя + данные.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed (2.0)
    local.writeUInt16LE(0x0800, 6); // bit 11 — имена в UTF-8
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    // Central directory header: 46 байт + имя.
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by (2.0, MS-DOS)
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // UTF-8
    central.writeUInt16LE(0, 10); // method: store
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // relative offset of local header

    localParts.push(local, nameBytes, data);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
    if (offset > 0xffffffff) throw new RangeError("zipStore: архив больше 4 ГиБ без ZIP64 не поддерживается");
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.length > 0xffffffff) throw new RangeError("zipStore: central directory больше 4 ГиБ");

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // entries total
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16); // offset of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, eocd], offset + centralDirectory.length + eocd.length);
}
