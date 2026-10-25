/**
 * Проверка конвертера Markdown → DOCX без внешних пакетов.
 *
 * Собирает документ с кириллицей, списками, кодом и спецсимволами, затем:
 *   - проверяет ZIP-структуру (сигнатура, EOCD, central directory, CRC, local headers);
 *   - разбирает части пакета и проверяет XML на парность тегов и экранирование;
 *   - проверяет наличие ожидаемого текста и стилей;
 *   - пишет tmp-docx-test.docx в корень проекта.
 *
 * Завершается кодом 1 при любом провале.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { markdownToDocx } from "../lib/docx.mjs";
import { crc32 } from "../lib/zip.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(projectRoot, "tmp-docx-test.docx");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};
const section = (name) => console.log(`\n— ${name} —`);

const TEST_MARKDOWN = [
  "# Отчёт по проекту «Ромашка»",
  "",
  "Первый абзац с **жирным** текстом, *курсивом* и `inline_code` вперемешку.",
  'Вторая строка с символами & < > "кавычки" и кодом `<tag attr="1">`.',
  "",
  "## Возможности",
  "",
  "- маркированный пункт с **акцентом**",
  "- второй пункт с `кодом`",
  "  - вложенный пункт",
  "",
  "## Порядок действий",
  "",
  "1. Установить зависимости",
  "2. Запустить проверку",
  "3. Прочитать результат",
  "",
  "Промежуточный абзац между списками.",
  "",
  "1. Первый шаг нового списка",
  "2. Второй шаг нового списка",
  "",
  "### Пример кода",
  "",
  "```js",
  "const x = 42;",
  "function привет(имя) {",
  "  return `Привет, ${имя}!`;",
  "}",
  "if (x < 10 && x > 0) {}",
  "```",
  "",
  "---",
  "",
  "Конец документа.",
].join("\n");

const EXPECTED_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/core.xml",
  "word/document.xml",
  "word/_rels/document.xml.rels",
  "word/styles.xml",
  "word/numbering.xml",
];

const XML_ROOTS = {
  "[Content_Types].xml": "Types",
  "_rels/.rels": "Relationships",
  "docProps/core.xml": "cp:coreProperties",
  "word/document.xml": "w:document",
  "word/_rels/document.xml.rels": "Relationships",
  "word/styles.xml": "w:styles",
  "word/numbering.xml": "w:numbering",
};

/* ------------------------------------------------------------ ZIP parsing */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function findEocdOffset(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLength = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLength === buf.length) return i;
    }
  }
  return -1;
}

function parseZip(buf) {
  if (buf.length < 22) throw new Error("файл короче 22 байт");
  if (buf.readUInt32LE(0) !== LOCAL_SIG) throw new Error("первая сигнатура не PK\\x03\\x04");

  const eocdOffset = findEocdOffset(buf);
  if (eocdOffset < 0) throw new Error("EOCD (PK\\x05\\x06) не найден");

  const disk = buf.readUInt16LE(eocdOffset + 4);
  const cdDisk = buf.readUInt16LE(eocdOffset + 6);
  const total = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const commentLength = buf.readUInt16LE(eocdOffset + 20);

  if (disk !== 0 || cdDisk !== 0) throw new Error("многотомный архив не ожидался");
  if (commentLength !== 0) throw new Error("комментарий архива не ожидался");
  if (cdOffset + cdSize !== eocdOffset) throw new Error("границы central directory не сходятся с EOCD");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("ZIP64 не ожидался");
  }

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length) throw new Error(`central header #${n} выходит за пределы файла`);
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error(`нет сигнатуры central header #${n}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const entryCommentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLength > buf.length) throw new Error(`имя записи #${n} выходит за пределы файла`);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
    entries.push({ name, flags, method, crc, compressedSize, size, localOffset });
    p += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (p !== cdOffset + cdSize) throw new Error("central directory прочитан не полностью");

  return { entries, eocdOffset, cdOffset, cdSize, total, commentLength };
}

function readStoredEntry(buf, entry) {
  const p = entry.localOffset;
  if (p + 30 > buf.length) throw new Error(`local header «${entry.name}» вне файла`);
  if (buf.readUInt32LE(p) !== LOCAL_SIG) throw new Error(`local header «${entry.name}» без сигнатуры`);
  const nameLength = buf.readUInt16LE(p + 26);
  const extraLength = buf.readUInt16LE(p + 28);
  const name = buf.toString("utf8", p + 30, p + 30 + nameLength);
  if (name !== entry.name) throw new Error(`имя в local header («${name}») не совпало с central directory («${entry.name}»)`);
  const start = p + 30 + nameLength + extraLength;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new Error(`данные «${entry.name}» обрезаны`);
  return { method: buf.readUInt16LE(p + 8), name, data };
}

/* ------------------------------------------------------------ XML checking */

const ENTITY_RE = /&(?:amp|lt|gt|quot|apos);|&#\d+;|&#x[0-9a-fA-F]+;/g;

function assertCleanText(chunk, name) {
  if (/[<>]/.test(chunk)) throw new Error(`сырой < или > вне тега в ${name}`);
  if (chunk.replace(ENTITY_RE, "").includes("&")) throw new Error(`неэкранированный & в ${name}`);
}

/**
 * Ручной XML-парсер: проверяет декларацию, парность тегов, единственный корень
 * и отсутствие неэкранированных < > &. Полноценной схемы не заменяет, но
 * ловит типичные ошибки генератора.
 */
function validateXml(xml, name) {
  if (typeof xml !== "string" || !xml.startsWith("<?xml ")) throw new Error(`в ${name} нет XML-декларации`);
  let src = xml.replace(/^<\?xml[\s\S]*?\?>/, "");
  src = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  if (src.includes("<!DOCTYPE")) throw new Error(`в ${name} неожиданный DOCTYPE`);

  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"<]*")*)\s*(\/?)>/g;
  const stack = [];
  let root = null;
  let lastIndex = 0;
  let match;

  const text = (chunk) => {
    assertCleanText(chunk, name);
    const rest = chunk.replace(ENTITY_RE, "");
    if (rest.includes("&")) throw new Error(`неэкранированный & в ${name}`);
  };

  while ((match = tagRe.exec(src))) {
    text(src.slice(lastIndex, match.index));
    const [, closing, tagName, attrs, selfClosing] = match;
    const attrRest = attrs.replace(ENTITY_RE, "");
    if (attrRest.includes("&")) throw new Error(`неэкранированный & в атрибутах ${name}`);

    if (closing) {
      const open = stack.pop();
      if (!open) throw new Error(`закрывающий </${tagName}> без открывающего в ${name}`);
      if (open !== tagName) throw new Error(`несовпадение тегов <${open}> и </${tagName}> в ${name}`);
    } else {
      if (!stack.length) {
        if (root) throw new Error(`несколько корневых элементов в ${name}`);
        root = tagName;
      }
      if (!selfClosing) stack.push(tagName);
    }
    lastIndex = tagRe.lastIndex;
  }

  text(src.slice(lastIndex));
  if (stack.length) throw new Error(`не закрыты теги: ${stack.join(", ")} (${name})`);
  if (!root) throw new Error(`нет корневого элемента в ${name}`);
  return root;
}

function decodeXmlText(xml) {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ------------------------------------------------------------------- build */

section("сборка документа");

let buffer;
try {
  buffer = markdownToDocx(TEST_MARKDOWN, { title: "Проверка DOCX — кириллица" });
  check("markdownToDocx вернул Buffer", Buffer.isBuffer(buffer), buffer?.constructor?.name ?? typeof buffer);
  check("документ не пустой", Buffer.isBuffer(buffer) && buffer.length > 0, `${buffer?.length ?? 0} байт`);
  writeFileSync(outPath, buffer);
  const written = readFileSync(outPath);
  check(
    "файл записан и побайтово совпадает с буфером",
    written.length === buffer.length && written.equals(buffer) && statSync(outPath).size === buffer.length,
    `${outPath} (${written.length} байт)`
  );
} catch (err) {
  check("сборка и запись документа", false, err.message);
  console.error(err);
  process.exit(1);
}

/* -------------------------------------------------------------- ZIP checks */

section("ZIP-структура");

const signatureOk =
  buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
check("сигнатура PK\\x03\\x04 в начале файла", signatureOk, buffer.subarray(0, 4).toString("hex"));

let archive = null;
try {
  archive = parseZip(buffer);
  check("EOCD найден и сходится с central directory", true, `offset=${archive.eocdOffset}, записей=${archive.total}`);
} catch (err) {
  check("ZIP читается (EOCD + central directory)", false, err.message);
}

if (archive) {
  check("в архиве ровно 7 частей", archive.total === EXPECTED_PARTS.length, `total=${archive.total}`);

  const names = archive.entries.map((entry) => entry.name);
  const missing = EXPECTED_PARTS.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !EXPECTED_PARTS.includes(name));
  check(
    "состав частей совпадает с OOXML-пакетом",
    missing.length === 0 && extra.length === 0 && names.length === new Set(names).size,
    missing.length || extra.length ? `нет: ${missing.join(", ") || "—"}; лишние: ${extra.join(", ") || "—"}` : names.join(", ")
  );

  let brokenEntry = null;
  const partData = new Map();
  for (const entry of archive.entries) {
    try {
      if (entry.method !== 0) throw new Error("метод не store");
      if (!(entry.flags & 0x0800)) throw new Error("не выставлен флаг UTF-8");
      if (entry.size !== entry.compressedSize) throw new Error("size ≠ compressedSize при store");
      const local = readStoredEntry(buffer, entry);
      if (local.method !== 0) throw new Error("local header: метод не store");
      if (crc32(local.data) !== entry.crc) throw new Error("CRC32 не совпал");
      if (local.data.length !== entry.size) throw new Error("длина данных не совпала с central directory");
      partData.set(entry.name, local.data);
    } catch (err) {
      brokenEntry = `${entry.name}: ${err.message}`;
      break;
    }
  }
  check(
    "все записи store, UTF-8, с верным CRC32 и читаемыми local headers",
    brokenEntry === null,
    brokenEntry ?? `${archive.entries.length} записей`
  );

  /* ------------------------------------------------------------------ XML */

  section("XML-части");

  const xmlParts = new Map();
  for (const partName of EXPECTED_PARTS.filter((name) => name.endsWith(".xml") || name.endsWith(".rels"))) {
    const data = partData.get(partName);
    if (!data) {
      check(`часть ${partName} читается`, false, "нет данных");
      continue;
    }
    const xml = data.toString("utf8");
    try {
      const root = validateXml(xml, partName);
      const expectedRoot = XML_ROOTS[partName];
      check(`${partName}: well-formed XML`, root === expectedRoot, `root=${root}`);
      xmlParts.set(partName, xml);
    } catch (err) {
      check(`${partName}: well-formed XML`, false, err.message);
    }
  }

  const documentXml = xmlParts.get("word/document.xml") ?? "";
  const stylesXml = xmlParts.get("word/styles.xml") ?? "";
  const numberingXml = xmlParts.get("word/numbering.xml") ?? "";
  const coreXml = xmlParts.get("docProps/core.xml") ?? "";
  const contentTypesXml = xmlParts.get("[Content_Types].xml") ?? "";
  const rootRelsXml = xmlParts.get("_rels/.rels") ?? "";
  const documentRelsXml = xmlParts.get("word/_rels/document.xml.rels") ?? "";

  section("содержимое word/document.xml");

  check(
    "заголовки H1, H2, H3 используют стили Heading1..3",
    documentXml.includes('<w:pStyle w:val="Heading1"/>') &&
      documentXml.includes('<w:pStyle w:val="Heading2"/>') &&
      documentXml.includes('<w:pStyle w:val="Heading3"/>')
  );

  const documentText = decodeXmlText(documentXml);
  check("кириллический заголовок H1 на месте", documentText.includes("Отчёт по проекту «Ромашка»"));
  check("заголовки H2/H3 на месте", documentText.includes("Возможности") && documentText.includes("Пример кода"));
  check(
    "абзац со смешанным форматированием собран целиком",
    documentText.includes(
      "Первый абзац с жирным текстом, курсивом и inline_code вперемешку. " +
        'Вторая строка с символами & < > "кавычки" и кодом <tag attr="1">.'
    )
  );

  check(
    "**жирный** отрендерен как w:b",
    documentXml.includes(
      '<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">жирным</w:t></w:r>'
    )
  );
  check(
    "*курсив* отрендерен как w:i",
    documentXml.includes(
      '<w:r><w:rPr><w:i/><w:iCs/></w:rPr><w:t xml:space="preserve">курсивом</w:t></w:r>'
    )
  );
  check(
    "`код` отрендерен character-стилем CodeChar",
    documentXml.includes(
      '<w:r><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:t xml:space="preserve">inline_code</w:t></w:r>'
    )
  );

  check(
    "маркированный и вложенный списки на месте",
    documentText.includes("маркированный пункт с акцентом") &&
      documentText.includes("вложенный пункт") &&
      documentXml.includes('<w:numId w:val="1"/>') &&
      documentXml.includes('<w:ilvl w:val="1"/>')
  );

  const numIds = [...new Set([...documentXml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]))];
  check(
    "два нумерованных списка получили разные numId",
    numIds.includes("1") && numIds.includes("2") && numIds.includes("3"),
    `numId: ${numIds.join(", ")}`
  );
  check(
    "элементы нумерованного списка используют ListParagraph",
    documentXml.includes('<w:pStyle w:val="ListParagraph"/>') && documentText.includes("Первый шаг нового списка")
  );

  check(
    "блок ```code``` использует CodeBlock и сохраняет текст",
    documentXml.includes('<w:pStyle w:val="CodeBlock"/>') &&
      documentText.includes("function привет(имя) {") &&
      documentText.includes("const x = 42;")
  );
  check(
    "спецсимволы в коде экранированы",
    documentXml.includes("if (x &lt; 10 &amp;&amp; x &gt; 0) {}") && !documentXml.includes("<tag attr=")
  );
  check(
    "абзац с & < > \" экранирован",
    documentXml.includes("&amp; &lt; &gt; &quot;кавычки&quot;") &&
      documentXml.includes("&lt;tag attr=&quot;1&quot;&gt;")
  );
  check("горизонтальная линия --- отрендерена рамкой", documentXml.includes("<w:pBdr>"));
  check("документ заканчивается sectPr", documentXml.includes("<w:sectPr>") && documentXml.endsWith("</w:document>"));

  section("стили, нумерация, свойства");

  const requiredStyles = ["Normal", "Heading1", "Heading2", "Heading3", "ListParagraph", "CodeBlock", "CodeChar"];
  const missingStyles = requiredStyles.filter((id) => !stylesXml.includes(`w:styleId="${id}"`));
  check("styles.xml содержит Normal/Heading1..3/ListParagraph и стили кода", missingStyles.length === 0, missingStyles.join(", "));

  const abstractCount = (numberingXml.match(/<w:abstractNum /g) ?? []).length;
  const numCount = (numberingXml.match(/<w:num /g) ?? []).length;
  const startOverrides = (numberingXml.match(/<w:startOverride /g) ?? []).length;
  check(
    "numbering.xml: 2 abstractNum, 3 num и startOverride для перезапуска",
    abstractCount === 2 && numCount === 3 && startOverrides >= 3,
    `abstract=${abstractCount}, num=${numCount}, startOverride=${startOverrides}`
  );

  check(
    "docProps/core.xml: заголовок с кириллицей записан",
    coreXml.includes("<dc:title>Проверка DOCX — кириллица</dc:title>")
  );

  check(
    "Content_Types объявляет document/styles/numbering/core",
    contentTypesXml.includes('PartName="/word/document.xml"') &&
      contentTypesXml.includes('PartName="/word/styles.xml"') &&
      contentTypesXml.includes('PartName="/word/numbering.xml"') &&
      contentTypesXml.includes('PartName="/docProps/core.xml"')
  );
  check(
    "_rels/.rels ведёт на document.xml и core.xml",
    rootRelsXml.includes('Target="word/document.xml"') && rootRelsXml.includes('Target="docProps/core.xml"')
  );
  check(
    "word/_rels/document.xml.rels подключает styles.xml и numbering.xml",
    documentRelsXml.includes('Target="styles.xml"') && documentRelsXml.includes('Target="numbering.xml"')
  );
}

/* ------------------------------------------------------------------ итоги */

console.log(
  failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли"
);
console.log(`файл: tmp-docx-test.docx, ${buffer.length} байт (${(buffer.length / 1024).toFixed(1)} КБ)`);
process.exitCode = failed ? 1 : 0;
