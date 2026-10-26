/**
 * Генератор .pptx на чистом Node (без внешних зависимостей).
 *
 * Собирает минимальный, но валидный пакет OOXML и упаковывает его через
 * lib/zip.mjs (zipStore). Структура:
 *   [Content_Types].xml, _rels/.rels, docProps/*,
 *   ppt/presentation.xml (+rels), ppt/slideMasters/slideMaster1.xml (+rels),
 *   ppt/slideLayouts/slideLayout1.xml (+rels), ppt/theme/theme1.xml,
 *   ppt/slides/slideN.xml (+rels) — по одному на каждый слайд.
 *
 * Текст пишется обычными text box'ами: заголовок крупным шрифтом, пункты —
 * маркированным списком. Русский текст сохраняется как UTF-8.
 *
 * Проверено python-pptx 1.0.2 (см. scripts/probe-decks.mjs и отчёт).
 */

import { zipStore } from "./zip.mjs";

/* ---------- размеры слайда 16:9 (EMU) и отступы ---------- */
const SLIDE_CX = 12_192_000;
const SLIDE_CY = 6_858_000;
const MARGIN_X = 838_200;
const TITLE_Y = 365_125;
const TITLE_CY = 1_325_563;
const BODY_Y = 1_825_625;
const BODY_CX = SLIDE_CX - MARGIN_X * 2;
const BODY_CY = SLIDE_CY - BODY_Y - 365_125;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** XML-экранирование и текста, и атрибутов. */
export function xmlEscape(value) {
  return String(value ?? "")
    // XML 1.0 не допускает управляющие символы — вычищаем, иначе PowerPoint не откроет файл.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attr(value) {
  return xmlEscape(value);
}

function text(value) {
  return xmlEscape(value);
}

/** Общие объявления пространств имён для частей PresentationML. */
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/** Стандартный минимальный набор частей, которые ждёт PowerPoint/python-pptx. */
function contentTypesXml(slideCount) {
  const slides = Array.from({ length: slideCount }, (_, i) =>
    `  <Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  ).join("\r\n");
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\r
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\r
  <Default Extension="xml" ContentType="application/xml"/>\r
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>\r
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>\r
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>\r
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>\r
${slides}\r
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>\r
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>\r
</Types>`;
}

function rootRels() {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\r
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>\r
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>\r
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>\r
</Relationships>`;
}

function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\r
  <dc:title>${text(title)}</dc:title>\r
  <dc:creator>Agent Portal</dc:creator>\r
  <cp:lastModifiedBy>Agent Portal</cp:lastModifiedBy>\r
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>\r
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>\r
</cp:coreProperties>`;
}

function appXml(slideCount, title) {
  return `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">\r
  <Application>Agent Portal</Application>\r
  <PresentationFormat>Widescreen</PresentationFormat>\r
  <Slides>${slideCount}</Slides>\r
  <TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${text(title)}</vt:lpstr></vt:vector></TitlesOfParts>\r
</Properties>`;
}

function presentationXml(slides) {
  const ids = slides.map((_, i) => `    <p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("\r\n");
  return `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1">\r
  <p:sldMasterIdLst>\r
    <p:sldMasterId id="2147483648" r:id="rId1"/>\r
  </p:sldMasterIdLst>\r
  <p:sldIdLst>\r
${ids}\r
  </p:sldIdLst>\r
  <p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}" type="screen16x9"/>\r
  <p:notesSz cx="6858000" cy="9144000"/>\r
  <p:defaultTextStyle>\r
    <a:defPPr><a:defRPr lang="ru-RU"/></a:defPPr>\r
    <a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">\r
      <a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>\r
    </a:lvl1pPr>\r
  </p:defaultTextStyle>\r
</p:presentation>`;
}

function presentationRels(slides) {
  const slideRels = slides.map((_, i) =>
    `  <Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
  ).join("\r\n");
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\r
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>\r
${slideRels}\r
</Relationships>`;
}

function slideMasterXml() {
  return `${XML_HEAD}<p:sldMaster ${NS}>\r
  <p:cSld>\r
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\r
    <p:spTree>\r
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\r
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>\r
    </p:spTree>\r
  </p:cSld>\r
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>\r
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>\r
  <p:txStyles>\r
    <p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"/></a:lvl1pPr></p:titleStyle>\r
    <p:bodyStyle><a:lvl1pPr marL="285750" indent="-285750"><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>\r
    <p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>\r
  </p:txStyles>\r
</p:sldMaster>`;
}

function slideMasterRels() {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\r
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>\r
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>\r
</Relationships>`;
}

function slideLayoutXml() {
  return `${XML_HEAD}<p:sldLayout ${NS} type="blank" preserve="1">\r
  <p:cSld name="Blank">\r
    <p:spTree>\r
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\r
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>\r
    </p:spTree>\r
  </p:cSld>\r
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>\r
</p:sldLayout>`;
}

function slideLayoutRels() {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\r
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>\r
</Relationships>`;
}

function themeXml() {
  return `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">\r
  <a:themeElements>\r
    <a:clrScheme name="Office">\r
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>\r
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>\r
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>\r
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>\r
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>\r
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>\r
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>\r
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>\r
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>\r
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>\r
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>\r
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>\r
    </a:clrScheme>\r
    <a:fontScheme name="Office">\r
      <a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>\r
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>\r
    </a:fontScheme>\r
    <a:fmtScheme name="Office">\r
      <a:fillStyleLst>\r
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\r
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\r
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\r
      </a:fillStyleLst>\r
      <a:lnStyleLst>\r
        <a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>\r
        <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>\r
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>\r
      </a:lnStyleLst>\r
      <a:effectStyleLst>\r
        <a:effectStyle><a:effectLst/></a:effectStyle>\r
        <a:effectStyle><a:effectLst/></a:effectStyle>\r
        <a:effectStyle><a:effectLst/></a:effectStyle>\r
      </a:effectStyleLst>\r
      <a:bgFillStyleLst>\r
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\r
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\r
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>\r
      </a:bgFillStyleLst>\r
    </a:fmtScheme>\r
  </a:themeElements>\r
</a:theme>`;
}

/** Один текст-бокс: заголовок или маркированный список. */
function titleShapeXml(title) {
  return `      <p:sp>\r
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>\r
        <p:spPr>\r
          <a:xfrm><a:off x="${MARGIN_X}" y="${TITLE_Y}"/><a:ext cx="${BODY_CX}" cy="${TITLE_CY}"/></a:xfrm>\r
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>\r
        </p:spPr>\r
        <p:txBody>\r
          <a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:normAutofit/></a:bodyPr>\r
          <a:lstStyle/>\r
          <a:p><a:pPr algn="l"/><a:r><a:rPr lang="ru-RU" sz="3200" b="1" dirty="0"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${text(title)}</a:t></a:r></a:p>\r
        </p:txBody>\r
      </p:sp>`;
}

function bodyShapeXml(bullets) {
  const paragraphs = bullets.map((line) => `          <a:p>\r
            <a:pPr marL="342900" indent="-342900" lvl="0"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>\r
            <a:r><a:rPr lang="ru-RU" sz="1800" dirty="0"><a:solidFill><a:srgbClr val="262626"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${text(line)}</a:t></a:r>\r
          </a:p>`).join("\r\n");
  return `      <p:sp>\r
        <p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>\r
        <p:spPr>\r
          <a:xfrm><a:off x="${MARGIN_X}" y="${BODY_Y}"/><a:ext cx="${BODY_CX}" cy="${BODY_CY}"/></a:xfrm>\r
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>\r
        </p:spPr>\r
        <p:txBody>\r
          <a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:normAutofit/></a:bodyPr>\r
          <a:lstStyle/>\r
${paragraphs}\r
        </p:txBody>\r
      </p:sp>`;
}

function slideXml(slide) {
  const bullets = Array.isArray(slide?.bullets) ? slide.bullets.map((b) => String(b ?? "").trim()).filter(Boolean) : [];
  const safeBullets = bullets.length ? bullets : ["—"];
  return `${XML_HEAD}<p:sld ${NS}>\r
  <p:cSld>\r
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\r
    <p:spTree>\r
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\r
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>\r
${titleShapeXml(String(slide?.title ?? "").trim() || "Слайд")}\r
${bodyShapeXml(safeBullets)}\r
    </p:spTree>\r
  </p:cSld>\r
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>\r
</p:sld>`;
}

function slideRels() {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\r
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>\r
</Relationships>`;
}

/** Приводим вход к безопасному виду: строго непустой список слайдов. */
function normalizeDeck({ title, slides } = {}) {
  const deckTitle = String(title ?? "").trim() || "Презентация";
  const list = Array.isArray(slides) ? slides : [];
  const normalized = list
    .slice(0, 100)
    .map((s, i) => {
      const bullets = (Array.isArray(s?.bullets) ? s.bullets : [])
        .map((b) => String(b ?? "").replace(/\s*\r?\n\s*/g, " ").trim())
        .filter(Boolean)
        .slice(0, 20);
      return {
        title: String(s?.title ?? "").trim() || `Слайд ${i + 1}`,
        bullets,
        ...(s?.notes ? { notes: String(s.notes).slice(0, 4000) } : {}),
      };
    });
  if (!normalized.length) normalized.push({ title: deckTitle, bullets: [] });
  return { title: deckTitle, slides: normalized };
}

/**
 * Собирает .pptx.
 * @param {{ title?: string, slides?: { title?: string, bullets?: string[], notes?: string }[] }} deck
 * @returns {Buffer}
 */
export function buildPptx(deck = {}) {
  const { title, slides } = normalizeDeck(deck);

  const entries = [
    { name: "[Content_Types].xml", data: contentTypesXml(slides.length) },
    { name: "_rels/.rels", data: rootRels() },
    { name: "docProps/core.xml", data: coreXml(title) },
    { name: "docProps/app.xml", data: appXml(slides.length, title) },
    { name: "ppt/presentation.xml", data: presentationXml(slides) },
    { name: "ppt/_rels/presentation.xml.rels", data: presentationRels(slides) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: slideMasterXml() },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: slideMasterRels() },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: slideLayoutXml() },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: slideLayoutRels() },
    { name: "ppt/theme/theme1.xml", data: themeXml() },
  ];

  slides.forEach((slide, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(slide) });
    entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: slideRels() });
  });

  return zipStore(entries);
}

export default buildPptx;
