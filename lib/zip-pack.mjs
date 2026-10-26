/**
 * Экспорт прогона в ZIP: файлы проекта + README.md + отчёты (artifacts/*.md).
 *
 * Раскладка файлов:
 *   <корень>            — файлы проекта из artifacts/work/**
 *   README.md           — задача, план блоков и как открыть проект
 *   artifacts/**        — спеки, проверки, правки и сводка
 *
 * Если в проекте уже есть свой README.md, он попадает в архив как
 * README.project.md — так README.md всегда описывает сам архив.
 *
 * Архив пишется потоково (zipStream): заголовок записи, данные файла,
 * затем central directory и EOCD. Файлы на диске не читаются в память целиком:
 * CRC и размер считаются блоками по 64 КБ, а сами данные уходят в ответ
 * чанками по мере чтения. Формат — обычный store-ZIP (без сжатия), поэтому
 * он открывается Explorer, Word, LibreOffice и unzip.
 */
import fs from "node:fs";
import path from "node:path";

const REPORT_RE = /\.md$/i;
const CHUNK = 64 * 1024;

/* Тот же CRC32 (IEEE 802.3), что и в lib/zip.mjs, но с накопительным состоянием:
   так контрольную сумму можно считать по блокам, не собирая файл в память. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crcUpdate(state, buf) {
  let c = state;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function crcOf(buf) {
  return (crcUpdate(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

/** DOS-время/дата для заголовков (ZIP не умеет годы до 1980 и хранит секунды парами). */
function dosDateTime(value) {
  const d = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** Все файлы каталога рекурсивно: [{ rel, full }], разделитель — «/». */
function walkFiles(dir, prefix = "") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, rel));
    else if (entry.isFile()) out.push({ rel, full });
  }
  return out;
}

function cleanBase(raw, fallback) {
  const name = String(raw ?? "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 60);
  return name || fallback;
}

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** ASCII-имя для заголовка Content-Disposition (filename* всё равно несёт UTF-8). */
function asciiBase(name) {
  return String(name)
    .toLowerCase()
    .split("")
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function readmeFor({ run, project, files, reports, entry }) {
  const name = project?.name || run.plan?.title || "Проект";
  const lines = [
    `# ${name}`,
    "",
    "## Задача",
    "",
    String(run.task ?? "").trim() || "—",
    "",
  ];

  if (run.change) {
    lines.push("## Доработка", "", String(run.change), "");
  }

  const blocks = run.blocks ?? [];
  lines.push("## План блоков", "");
  if (blocks.length) {
    for (const b of blocks) {
      const parts = [`- **${b.id}** «${b.title}»`];
      if (b.goal) parts.push(`— ${b.goal}`);
      parts.push(`· статус: ${b.status ?? "—"}`);
      lines.push(parts.join(" "));
    }
  } else {
    lines.push("- плана нет");
  }
  lines.push("");

  lines.push("## Как открыть", "");
  if (entry) {
    lines.push("1. Распакуй архив в любую папку.");
    lines.push(`2. Открой \`${entry}\` в браузере — проект статический, сборка не нужна.`);
  } else {
    lines.push("1. Распакуй архив в любую папку.");
    lines.push("2. Файлов с точкой входа (index.html) в проекте нет — смотри файлы в корне архива.");
  }
  lines.push("3. Отчёты агентов (спеки, проверки, правки, сводка) — в папке `artifacts/`.");
  lines.push("");

  lines.push("## Что в архиве", "");
  lines.push(`- Файлов проекта: ${files.length}`);
  lines.push(`- Отчётов: ${reports.length}`);
  if (reports.length) {
    lines.push("");
    for (const r of reports) lines.push(`- \`${r}\``);
  }
  lines.push("");
  lines.push(
    `_Прогон ${run.id} · ${run.createdAt ?? "—"} · стоимость $${Number(run.usage?.cost ?? 0).toFixed(4)}_`,
    ""
  );
  return lines.join("\n");
}

/**
 * Готовит список записей архива. Файлы на диске НЕ читаются — только пути,
 * поэтому память занята именами и мелким текстом (workspace, README).
 *
 * @param {{ run: object, store: object, project?: object|null }} args
 * @returns {{ entries: { name: string, path?: string, data?: string|Buffer }[], name: string, ascii: string }}
 */
export function buildProjectZipEntries({ run, store, project = null }) {
  if (!run?.id) throw new Error("buildProjectZipEntries: нет прогона");
  const entries = [];
  const added = new Set();

  const add = (name, spec, { unique = false } = {}) => {
    let final = name;
    if (added.has(final)) {
      if (!unique) return false;
      const ext = path.posix.extname(final);
      const base = ext ? final.slice(0, -ext.length) : final;
      let i = 2;
      while (added.has(`${base}-${i}${ext}`)) i++;
      final = `${base}-${i}${ext}`;
    }
    added.add(final);
    entries.push({ name: final, ...spec });
    return true;
  };

  /* 1. файлы проекта: artifacts/work/** (на диске — правда), плюс workspace как запасной вариант */
  const workDir = path.join(store.runDir(run.id), "artifacts", "work");
  const workFiles = walkFiles(workDir);
  const onDisk = new Set();
  for (const f of workFiles) {
    onDisk.add(f.rel);
    if (f.rel === "README.md") add("README.project.md", { path: f.full });
    else add(f.rel, { path: f.full });
  }
  for (const [rel, content] of Object.entries(run.workspace ?? {})) {
    const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!clean || clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.split("/").includes("..") || onDisk.has(clean)) continue;
    if (clean === "README.md") add("README.project.md", { data: String(content ?? "") });
    else add(clean, { data: String(content ?? "") });
  }

  /* 2. отчёты: только md, без work/** (это уже файлы проекта) */
  const reports = [];
  for (const a of store.listArtifacts(run)) {
    if (!REPORT_RE.test(a.path) || a.path.startsWith("work/")) continue;
    const full = path.join(store.runDir(run.id), "artifacts", a.path);
    if (!fs.existsSync(full)) continue;
    const name = `artifacts/${a.path}`;
    if (add(name, { path: full }, { unique: true })) reports.push(name);
  }

  /* 3. README.md — всегда в корне; имя записи не должно конфликтовать */
  const entry =
    entries.find((e) => e.name === "index.html")?.name ??
    entries.find((e) => /\.html?$/i.test(e.name))?.name ??
    null;
  const fileNames = [...added].filter((n) => !n.startsWith("artifacts/") && n !== "README.md");
  const readme = readmeFor({ run, project, files: fileNames, reports, entry });
  if (added.has("README.md")) {
    // сюда можно попасть только если workspace подсунул README.md мимо проверки выше
    add("README_PORTAL.md", { data: readme });
  } else {
    add("README.md", { data: readme });
  }

  const base = cleanBase(project?.name || run.plan?.title || "Проект", "project");
  return {
    entries,
    name: `${base}.zip`,
    ascii: `${asciiBase(base) || "project"}-${run.id}.zip`,
  };
}

function toBuffer(data, label) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new TypeError(`zipStream: данные записи «${label}» должны быть Buffer, Uint8Array или строкой`);
}

function normalizeName(raw) {
  const name = String(raw ?? "");
  if (!name) throw new Error("zipStream: у записи пустое имя");
  if (name.includes("\0")) throw new Error("zipStream: NUL-символ в имени записи");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new Error(`zipStream: абсолютный путь недопустим («${name}»)`);
  // В ZIP разделитель — всегда «/», поэтому обратные слэши Windows аккуратно приводим.
  const normalized = name.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) throw new Error(`zipStream: «..» в имени записи недопустим («${name}»)`);
  return normalized;
}

/** Размер и CRC записи. Файл читается блоками по 64 КБ — в память целиком не попадает. */
async function measureEntry(entry, name) {
  if (entry.path) {
    let size = 0;
    let state = 0xffffffff;
    const stream = fs.createReadStream(entry.path, { highWaterMark: CHUNK });
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 0xffffffff) throw new RangeError(`zipStream: запись «${name}» больше 4 ГиБ`);
        state = crcUpdate(state, chunk);
      }
    } finally {
      stream.destroy();
    }
    return { size, crc: (state ^ 0xffffffff) >>> 0 };
  }
  const buf = toBuffer(entry.data, name);
  if (buf.length > 0xffffffff) throw new RangeError(`zipStream: запись «${name}» больше 4 ГиБ`);
  return { size: buf.length, crc: crcOf(buf) };
}

/** Данные записи чанками: файл с диска — потоком, буфер/строка — кусками по 64 КБ. */
async function* readEntryData(entry, name) {
  if (entry.path) {
    const stream = fs.createReadStream(entry.path, { highWaterMark: CHUNK });
    try {
      for await (const chunk of stream) yield chunk;
    } finally {
      stream.destroy();
    }
    return;
  }
  const buf = toBuffer(entry.data, name);
  for (let i = 0; i < buf.length; i += CHUNK) yield buf.subarray(i, Math.min(i + CHUNK, buf.length));
}

/**
 * Потоковый ZIP: async-генератор чанков для res.write.
 *
 * Формат store (method 0), без data descriptor: CRC и размер каждой записи
 * считаются до её заголовка (один проход чтения), затем данные уходят чанками
 * (второй проход). Так local header сразу корректный — архив понимают все
 * архиваторы, а память ограничена одним блоком в 64 КБ.
 *
 * @param {{ name: string, path?: string, data?: Buffer|Uint8Array|string }[]} entries
 * @param {{ date?: Date }} [options] — date фиксирует отметку времени
 * @yields {Buffer}
 */
export async function* zipStream(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError("zipStream: entries должен быть непустым массивом");
  }
  if (entries.length > 0xffff) {
    throw new RangeError("zipStream: больше 65535 записей без ZIP64 не поддерживается");
  }

  const { time, date } = dosDateTime(options.date);
  const seen = new Set();
  const central = []; // метаданные центрального каталога — 46 байт + имя на запись
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeName(entry?.name);
    if (seen.has(name)) throw new Error(`zipStream: дубликат имени записи «${name}»`);
    seen.add(name);

    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length > 0xffff) throw new RangeError(`zipStream: имя записи «${name}» длиннее 65535 байт`);

    const { size, crc } = await measureEntry(entry ?? {}, name);
    const localOffset = offset;

    // Local file header: 30 байт + имя + данные.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed (2.0)
    local.writeUInt16LE(0x0800, 6); // bit 11 — имена в UTF-8
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    yield local;
    yield nameBytes;
    offset += local.length + nameBytes.length;

    let written = 0;
    for await (const chunk of readEntryData(entry ?? {}, name)) {
      written += chunk.length;
      offset += chunk.length;
      if (offset > 0xffffffff) throw new RangeError("zipStream: архив больше 4 ГиБ без ZIP64 не поддерживается");
      yield chunk;
    }
    if (written !== size) throw new Error(`zipStream: файл «${name}» изменился во время сборки архива`);

    central.push({ nameBytes, crc, size, localOffset });
  }

  // Central directory: по заголовку на запись, без склейки всех записей в один буфер.
  const centralOffset = offset;
  let centralSize = 0;
  for (const c of central) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); // signature
    head.writeUInt16LE(20, 4); // version made by (2.0, MS-DOS)
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0x0800, 8); // UTF-8
    head.writeUInt16LE(0, 10); // method: store
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(c.crc, 16);
    head.writeUInt32LE(c.size, 20);
    head.writeUInt32LE(c.size, 24);
    head.writeUInt16LE(c.nameBytes.length, 28);
    head.writeUInt16LE(0, 30); // extra
    head.writeUInt16LE(0, 32); // comment
    head.writeUInt16LE(0, 34); // disk number start
    head.writeUInt16LE(0, 36); // internal attributes
    head.writeUInt32LE(0, 38); // external attributes
    head.writeUInt32LE(c.localOffset, 42); // relative offset of local header

    yield head;
    yield c.nameBytes;
    centralSize += head.length + c.nameBytes.length;
  }
  if (offset + centralSize > 0xffffffff) throw new RangeError("zipStream: архив больше 4 ГиБ без ZIP64 не поддерживается");

  // EOCD: 22 байта, всегда в конце файла.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // entries total
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16); // offset of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  yield eocd;
}
