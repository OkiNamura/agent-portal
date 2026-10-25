/**
 * Markdown → DOCX на чистом Node (без внешних пакетов).
 *
 * Собирает минимальный, но полноценный OOXML-пакет:
 *   [Content_Types].xml, _rels/.rels, docProps/core.xml,
 *   word/document.xml, word/_rels/document.xml.rels,
 *   word/styles.xml, word/numbering.xml
 *
 * Поддерживаются: заголовки #..###, абзацы, маркированные и нумерованные
 * списки (с вложенностью до 3 уровней), **жирный**, *курсив*, `код`,
 * блоки ```code``` и горизонтальные линии ---.
 */

import { zipStore } from "./zip.mjs";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/* ---------------------------------------------------------------- XML utils */

/** Экранирование текста и атрибутов + вычистка символов, недопустимых в XML 1.0. */
function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* ----------------------------------------------------------- inline parsing */

/** Ищет закрывающий маркер, пропуская экранированные символы. */
function findMarker(text, from, marker) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text.startsWith(marker, i)) return i;
  }
  return -1;
}

/** Ищет одиночную звёздочку (не часть **), чтобы закрыть курсив. */
function findItalicEnd(text, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "*" && text[i - 1] !== "*" && text[i + 1] !== "*") return i;
  }
  return -1;
}

function pushRun(runs, text, style) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.bold === style.bold && last.italic === style.italic && last.code === style.code) {
    last.text += text;
  } else {
    runs.push({ text, bold: !!style.bold, italic: !!style.italic, code: !!style.code });
  }
}

/**
 * Разбирает инлайн-разметку в плоский список runs.
 * Код имеет приоритет: внутри `...` звёздочки не форматируются.
 */
function parseInline(input, inherited = {}) {
  const chars = String(input);
  const style = { bold: !!inherited.bold, italic: !!inherited.italic, code: false };
  const runs = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) {
      pushRun(runs, buf, style);
      buf = "";
    }
  };

  while (i < chars.length) {
    const ch = chars[i];

    // Обратный слэш экранирует разметку.
    if (ch === "\\" && i + 1 < chars.length && /[\\`*_[\]{}()#+\-.!>~]/.test(chars[i + 1])) {
      buf += chars[i + 1];
      i += 2;
      continue;
    }

    // `inline code`
    if (ch === "`") {
      const end = chars.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        pushRun(runs, chars.slice(i + 1, end), { ...style, code: true });
        i = end + 1;
        continue;
      }
    }

    // **жирный**
    if (ch === "*" && chars[i + 1] === "*") {
      const end = findMarker(chars, i + 2, "**");
      if (end > i + 2) {
        flush();
        for (const run of parseInline(chars.slice(i + 2, end), { ...style, bold: true })) {
          pushRun(runs, run.text, run);
        }
        i = end + 2;
        continue;
      }
    }

    // *курсив* (одиночная звёздочка, не примыкающая к пробелам)
    if (ch === "*" && chars[i + 1] !== "*" && chars[i + 1] !== undefined && !/\s/.test(chars[i + 1])) {
      const end = findItalicEnd(chars, i + 1);
      if (end > i + 1 && !/\s/.test(chars[end - 1])) {
        flush();
        for (const run of parseInline(chars.slice(i + 1, end), { ...style, italic: true })) {
          pushRun(runs, run.text, run);
        }
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return runs;
}

/* ----------------------------------------------------------- block parsing */

const FENCE_RE = /^\s{0,3}```(.*)$/;
const FENCE_CLOSE_RE = /^\s{0,3}```\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s{0,6})[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s{0,6})(\d{1,9})[.)]\s+(.*)$/;
const HR_RE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

function indentLevel(spaces) {
  return Math.min(2, Math.floor(spaces.replace(/\t/g, "  ").length / 2));
}

/**
 * Разбирает markdown в блоки. Нумерованные списки получают собственный numId,
 * чтобы каждый следующий список начинался заново с 1.
 */
function parseMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  const orderedNumIds = [];
  let nextNumId = 2; // numId 1 зарезервирован под маркированные списки
  let currentOrderedNumId = null;
  let paragraphLines = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const text = paragraphLines.map((line) => line.trim()).join(" ").replace(/\s+/g, " ").trim();
    paragraphLines = [];
    if (text) blocks.push({ type: "paragraph", text });
  };
  const endOrderedList = () => {
    currentOrderedNumId = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ```code```
    const fence = line.match(FENCE_RE);
    if (fence) {
      flushParagraph();
      endOrderedList();
      const lang = fence[1].trim();
      const code = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // закрывающий забор
      blocks.push({ type: "code", lang, text: code.join("\n") });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue; // пустая строка не разрывает нумерованный список
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flushParagraph();
      endOrderedList();
      const text = heading[2].trim().replace(/\s+#+\s*$/, "");
      blocks.push({ type: "heading", level: Math.min(3, heading[1].length), text });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      flushParagraph();
      endOrderedList();
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (bullet) {
      flushParagraph();
      endOrderedList();
      blocks.push({ type: "bullet", level: indentLevel(bullet[1]), text: bullet[2].trim() });
      i++;
      continue;
    }

    const ordered = line.match(ORDERED_RE);
    if (ordered) {
      flushParagraph();
      if (currentOrderedNumId === null) {
        currentOrderedNumId = nextNumId++;
        orderedNumIds.push(currentOrderedNumId);
      }
      blocks.push({
        type: "ordered",
        level: indentLevel(ordered[1]),
        text: ordered[3].trim(),
        numId: currentOrderedNumId,
      });
      i++;
      continue;
    }

    // Обычный текст: строки подряд склеиваются в один абзац.
    endOrderedList();
    paragraphLines.push(line);
    i++;
  }

  flushParagraph();
  if (!blocks.length) blocks.push({ type: "paragraph", text: "" });
  return { blocks, orderedNumIds };
}

/* -------------------------------------------------------------- rendering */

function renderRun(run) {
  const props = [];
  if (run.code) props.push('<w:rStyle w:val="CodeChar"/>');
  if (run.bold) props.push("<w:b/>", "<w:bCs/>");
  if (run.italic) props.push("<w:i/>", "<w:iCs/>");
  const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
}

function renderInline(text) {
  const runs = parseInline(text);
  return runs.length ? runs.map(renderRun).join("") : "";
}

function renderCodeLine(line) {
  return (
    `<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>` +
    `<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`
  );
}

function renderBlock(block) {
  switch (block.type) {
    case "heading":
      return (
        `<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>` +
        `${renderInline(block.text)}</w:p>`
      );
    case "paragraph":
      return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${renderInline(block.text)}</w:p>`;
    case "bullet":
      return (
        `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/>` +
        `<w:numPr><w:ilvl w:val="${block.level}"/><w:numId w:val="1"/></w:numPr></w:pPr>` +
        `${renderInline(block.text)}</w:p>`
      );
    case "ordered":
      return (
        `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/>` +
        `<w:numPr><w:ilvl w:val="${block.level}"/><w:numId w:val="${block.numId}"/></w:numPr></w:pPr>` +
        `${renderInline(block.text)}</w:p>`
      );
    case "code": {
      const lines = String(block.text).replace(/\t/g, "    ").split("\n");
      return lines.map(renderCodeLine).join("");
    }
    case "hr":
      return (
        `<w:p><w:pPr><w:pBdr>` +
        `<w:bottom w:val="single" w:sz="6" w:space="1" w:color="A6A6A6"/>` +
        `</w:pBdr></w:pPr></w:p>`
      );
    default:
      return "";
  }
}

function renderDocumentXml(blocks) {
  const body = blocks.map(renderBlock).join("");
  return (
    XML_DECL +
    `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>` +
    body +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`
  );
}

function buildCoreXml(title) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    XML_DECL +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dc:creator>agent-portal</dc:creator>` +
    `<cp:lastModifiedBy>agent-portal</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    `</cp:coreProperties>`
  );
}

/* --------------------------------------------------------------- numbering */

function numberingLevel(ilvl, format, text, font) {
  const rPr = font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>` : "";
  return (
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/>` +
    `<w:numFmt w:val="${format}"/><w:lvlText w:val="${escapeXml(text)}"/>` +
    `<w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr>${rPr}</w:lvl>`
  );
}

function buildNumberingXml(orderedNumIds) {
  const bullets = [
    numberingLevel(0, "bullet", "•", "Arial"),
    numberingLevel(1, "bullet", "◦", "Arial"),
    numberingLevel(2, "bullet", "▪", "Arial"),
  ].join("");
  const decimals = [
    numberingLevel(0, "decimal", "%1.", null),
    numberingLevel(1, "decimal", "%2.", null),
    numberingLevel(2, "decimal", "%3.", null),
  ].join("");

  const nums = ['<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'];
  for (const numId of orderedNumIds) {
    const overrides = [0, 1, 2]
      .map((ilvl) => `<w:lvlOverride w:ilvl="${ilvl}"><w:startOverride w:val="1"/></w:lvlOverride>`)
      .join("");
    nums.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="1"/>${overrides}</w:num>`);
  }

  return (
    XML_DECL +
    `<w:numbering xmlns:w="${W_NS}">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bullets}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${decimals}</w:abstractNum>` +
    nums.join("") +
    `</w:numbering>`
  );
}

/* ------------------------------------------------------------- static parts */

const CONTENT_TYPES_XML =
  XML_DECL +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
  `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
  `</Types>`;

const ROOT_RELS_XML =
  XML_DECL +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `</Relationships>`;

const DOCUMENT_RELS_XML =
  XML_DECL +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
  `</Relationships>`;

const STYLES_XML =
  XML_DECL +
  `<w:styles xmlns:w="${W_NS}">` +
  `<w:docDefaults>` +
  `<w:rPrDefault><w:rPr>` +
  `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>` +
  `<w:sz w:val="22"/><w:szCs w:val="22"/>` +
  `<w:lang w:val="ru-RU" w:eastAsia="ru-RU" w:bidi="ar-SA"/>` +
  `</w:rPr></w:rPrDefault>` +
  `<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>` +
  `</w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal">` +
  `<w:name w:val="Normal"/><w:qFormat/>` +
  `<w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr>` +
  `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>` +
  `<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>` +
  `</w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading1">` +
  `<w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
  `<w:uiPriority w:val="9"/><w:qFormat/>` +
  `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="400" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr>` +
  `<w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:eastAsia="Calibri Light" w:cs="Calibri Light"/>` +
  `<w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>` +
  `</w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading2">` +
  `<w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
  `<w:uiPriority w:val="9"/><w:qFormat/>` +
  `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>` +
  `<w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:eastAsia="Calibri Light" w:cs="Calibri Light"/>` +
  `<w:b/><w:color w:val="2E5395"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>` +
  `</w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading3">` +
  `<w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
  `<w:uiPriority w:val="9"/><w:qFormat/>` +
  `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="260" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr>` +
  `<w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light" w:eastAsia="Calibri Light" w:cs="Calibri Light"/>` +
  `<w:b/><w:color w:val="1F3864"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>` +
  `</w:style>` +
  `<w:style w:type="paragraph" w:styleId="ListParagraph">` +
  `<w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>` +
  `<w:uiPriority w:val="34"/><w:qFormat/>` +
  `<w:pPr><w:spacing w:before="0" w:after="80" w:line="276" w:lineRule="auto"/><w:contextualSpacing/></w:pPr>` +
  `</w:style>` +
  `<w:style w:type="paragraph" w:customStyle="1" w:styleId="CodeBlock">` +
  `<w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
  `<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/>` +
  `<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>` +
  `<w:ind w:left="240" w:right="240"/></w:pPr>` +
  `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/>` +
  `<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>` +
  `</w:style>` +
  `<w:style w:type="character" w:customStyle="1" w:styleId="CodeChar">` +
  `<w:name w:val="Inline Code"/><w:qFormat/>` +
  `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/>` +
  `<w:sz w:val="19"/><w:szCs w:val="19"/>` +
  `<w:shd w:val="clear" w:color="auto" w:fill="F0F0F0"/></w:rPr>` +
  `</w:style>` +
  `</w:styles>`;

/**
 * Конвертирует Markdown в DOCX.
 * @param {string} markdown
 * @param {{ title?: string }} [options] — title попадает в свойства документа (docProps/core.xml)
 * @returns {Buffer}
 */
export function markdownToDocx(markdown, options = {}) {
  const title = String(options.title ?? "Документ");
  const { blocks, orderedNumIds } = parseMarkdown(markdown);

  const parts = [
    { name: "[Content_Types].xml", data: CONTENT_TYPES_XML },
    { name: "_rels/.rels", data: ROOT_RELS_XML },
    { name: "docProps/core.xml", data: buildCoreXml(title) },
    { name: "word/document.xml", data: renderDocumentXml(blocks) },
    { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS_XML },
    { name: "word/styles.xml", data: STYLES_XML },
    { name: "word/numbering.xml", data: buildNumberingXml(orderedNumIds) },
  ];

  return zipStore(parts);
}
