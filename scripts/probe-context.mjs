/**
 * probe-context.mjs — юнит-проверки умного отбора файлов для промтов. Без сервера.
 *
 * Что проверяет:
 *   1. проект из 30 файлов по 10k: промт ≤ 60k, файлы блока — первыми и целиком,
 *      остальные — сигнатуры (шапка + экспортируемые имена), а не полный код;
 *   2. fix с дефектом "app.js:120" для файла 50k: в промт попадает фрагмент
 *      ±60 строк (~120 строк), а не весь файл;
 *   3. обратная совместимость: renderFiles(files) без опций работает как раньше
 *      (файлы целиком, 80k на файл, 200k суммарно, без баннера отбора);
 *   4. renderFiles не теряет файлы из block.files даже при переполнении бюджета;
 *   5. событие call содержит promptChars — длину собранного промта.
 *
 * Запуск: node scripts/probe-context.mjs
 * Exit 1 при провале.
 */
import { Engine } from "../lib/engine.mjs";
import * as P from "../lib/prompts.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
}
function section(title) {
  console.log(`\n# ${title}`);
}

/* ------------------------- синтетические данные ------------------------- */

function makeSizedFile(path, size, { fnPrefix = "fn" } = {}) {
  const safe = path.replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || "file";
  const marker = `\n// TAIL_MARKER_${safe}`;
  const target = Math.max(1, size - marker.length);
  let content = `// ${path} — синтетический файл probe-context\n`;
  let i = 0;
  while (content.length < target) {
    i += 1;
    content += `export function ${fnPrefix}_${i}(value) {\n  return value + ${i};\n}\n`;
  }
  content = content.slice(0, target) + marker;
  return { path, content };
}

/** Файл, у которого каждая строка подписана LINE_0001 … LINE_1500. */
function makeLineFile(path, linesCount, lineLen) {
  const lines = [];
  for (let n = 1; n <= linesCount; n += 1) {
    const label = `LINE_${String(n).padStart(4, "0")}`;
    lines.push(`${label} ${"x".repeat(Math.max(0, lineLen - label.length - 1))}`);
  }
  const content = lines.join("\n");
  return { path, content, lines };
}

const bigProject = Array.from({ length: 30 }, (_, i) => {
  const id = String(i).padStart(2, "0");
  return makeSizedFile(`src/file${id}.js`, 10_000, { fnPrefix: `file${id}` });
});
const block = {
  id: "b1",
  title: "Основной блок",
  files: [bigProject[0], bigProject[1], bigProject[2]],
};
const spec = "Правь src/file05.js и list из file06.js: там основная логика блока.";

/* ------------------- 1. большой проект: отбор и лимит ------------------- */

section("1. Проект 30 × 10k: отбор, порядок, сигнатуры");

const rendered = P.renderFiles(bigProject, { block, spec, stage: "test" });
const testUser = P.testPrompt({
  task: "Большой проект",
  block,
  spec,
  files: bigProject,
  testOutput: "",
  fallbacks: 0,
}).user;

const rawChars = bigProject.reduce((sum, f) => sum + f.content.length, 0);
const legacyChars = P.renderFiles(bigProject).length;
console.log(`  сырой проект: ${rawChars} символов`);
console.log(`  было (renderFiles целиком, лимит 200k): ${legacyChars} символов`);
console.log(`  стало (отбор файлов, лимит 60k): ${rendered.length} символов`);
console.log(`  промт тестировщика: ${testUser.length} символов`);

check("раздел файлов ≤ 60k", rendered.length <= 60_000, `${rendered.length}`);
check("промт тестировщика ≤ 60k", testUser.length <= 60_000, `${testUser.length}`);
check("отбор заметно короче прежней выдачи", rendered.length < legacyChars / 2, `${rendered.length} < ${legacyChars}`);
check("есть явная пометка об отборе", /отобраны файлы для этого промта/i.test(rendered));

const pathIndex = (path) => rendered.indexOf(`--- ${path} ---`);
const blockIdx = block.files.map((f) => pathIndex(f.path));
const blockLast = Math.max(...blockIdx);
const restIdx = bigProject
  .filter((f) => !block.files.some((b) => b.path === f.path))
  .map((f) => pathIndex(f.path));
const restFirst = Math.min(...restIdx);
check("файлы блока на первом месте", blockIdx.every((i) => i >= 0) && blockLast < restFirst, `${blockLast} < ${restFirst}`);
check("порядок файлов блока сохранён", blockIdx[0] < blockIdx[1] && blockIdx[1] < blockIdx[2], blockIdx.join(","));
check(
  "все файлы блока переданы целиком",
  block.files.every((f) => rendered.includes(f.content)),
  block.files.map((f) => f.path).join(", ")
);
check("файл из блока не потерян", block.files.every((f) => pathIndex(f.path) >= 0));

const restFile = bigProject[10];
const restHead = restFile.content.split("\n").slice(0, 3).join("\n");
check("остальные файлы — не целиком", !rendered.includes(restFile.content), restFile.path);
check("остальные — шапка файла", rendered.includes(restHead));
check("остальные — список экспортируемых имён", rendered.includes("Экспортируемые имена:") && rendered.includes("file10_1"));
check("есть пометка «показан частично»", /показан частично/.test(rendered));
check("хвост остального файла не попал в промт", !rendered.includes("TAIL_MARKER_src_file10_js"));

const mentionedAt = pathIndex("src/file05.js");
const restAt = pathIndex("src/file20.js");
check("упомянутые в спеке идут после блока и раньше остальных", mentionedAt > blockLast && mentionedAt < restAt, `${blockLast} < ${mentionedAt} < ${restAt}`);

/* ------------------- 2. fix: фрагмент вместо файла 50k ------------------- */

section("2. fix: дефект app.js:120, файл 50k — фрагмент ±60 строк");

const bigFix = makeLineFile("app.js", 1_500, 34); // ~52.5k символов
const fixBlock = { id: "b2", title: "Правка", files: [{ path: "app.js", content: bigFix.content }] };
const defects = [{ severity: "major", where: "app.js:120", what: "кнопка не реагирует на клик" }];
const fixUser = P.fixPrompt({
  task: "Починить кнопку",
  block: fixBlock,
  spec: "# Правка\n- Кнопка реагирует на клик",
  files: fixBlock.files,
  projectFiles: [bigFix, makeSizedFile("style.css", 4_000, { fnPrefix: "css" })],
  defects,
  round: 1,
}).user;

const fragmentLines = (fixUser.match(/^\s*\d+\| LINE_/gm) ?? []).length;
console.log(`  файл app.js: ${bigFix.content.length} символов, ${bigFix.lines.length} строк`);
console.log(`  строк во фрагменте: ${fragmentLines}; промт fix: ${fixUser.length} символов`);

check("fix: весь файл 50k не передан", !fixUser.includes(bigFix.content));
check("fix: есть фрагмент ±60 строк", /±60 строк/.test(fixUser));
check("fix: фрагмент ~120 строк", fragmentLines >= 118 && fragmentLines <= 124, `${fragmentLines}`);
check("fix: начало фрагмента около строки 60", fixUser.includes("LINE_0060"));
check("fix: конец фрагмента около строки 180", fixUser.includes("LINE_0180"));
check("fix: строки вне окна не попали", !fixUser.includes("LINE_0001 ") && !fixUser.includes("LINE_0500 "));
check("fix: промт ≤ 60k", fixUser.length <= 60_000, `${fixUser.length}`);
check("fix: сказано, что в ответе нужен весь файл", /ВЕСЬ файл целиком/.test(fixUser));

/* ------------------- 3. обратная совместимость без опций ------------------- */

section("3. renderFiles без опций — прежнее поведение");

const small = [
  { path: "a.js", content: "const a = 1;\n" },
  { path: "b.js", content: "const b = 2;\n" },
];
const legacyText = P.renderFiles(small);
// старый формат: файл + "\n\n" между блоками; content уже заканчивается переводом строки
const expected = "--- a.js ---\nconst a = 1;\n\n\n--- b.js ---\nconst b = 2;\n";
check("без опций: файлы целиком в прежнем формате", legacyText === expected, JSON.stringify(legacyText.slice(0, 80)));
check("без опций: нет баннера отбора", !/отобраны файлы|показан частично|сигнатур/i.test(legacyText));

const hugeLegacy = P.renderFiles([{ path: "big.js", content: "x".repeat(90_000) }]);
check(
  "без опций: прежний лимит 80k на файл",
  hugeLegacy.includes("показаны первые 80000 из 90000"),
  hugeLegacy.slice(-80)
);

const listOnly = P.renderFiles(small, { withContent: false });
check("с withContent:false — как раньше, только пути", listOnly === "a.js\n\nb.js", JSON.stringify(listOnly));

/* ------------------- 4. block.files не теряются при переполнении ------------------- */

section("4. Переполнение: файлы блока не теряются");

const overloadedBlock = { id: "b3", files: bigProject.slice(0, 7) }; // 70k > 60k
const overloaded = P.renderFiles(bigProject, { block: overloadedBlock, spec: "", stage: "build" });
console.log(`  блок из 7 × 10k, промт: ${overloaded.length} символов`);
check("переполнение: промт всё равно ≤ 60k", overloaded.length <= 60_000, `${overloaded.length}`);
check(
  "переполнение: все файлы из block.files упомянуты",
  overloadedBlock.files.every((f) => overloaded.includes(`--- ${f.path} ---`)),
  overloadedBlock.files.map((f) => f.path).join(", ")
);
check("переполнение: есть пометка «не показан»/«показан частично»", /не показан|показан частично/.test(overloaded));

/* ------------------- 5. promptChars в событии call ------------------- */

section("5. promptChars в событии call");

const events = [];
const store = {
  save: (run) => run,
  event: (run, entry) => {
    events.push(entry);
    return entry;
  },
};
const bus = { emit: () => {} };
const config = {
  pipeline: { stages: [], maxCostUsd: 10 },
  agents: { agents: [{ id: "coder", name: "Coder", model: "mock/model", kind: "coder", prompt: "" }] },
};
const engine = new Engine({ store, bus, config });
const mockResult = {
  text: '{"ok":true}',
  data: { ok: true },
  model: "mock/model",
  usage: { prompt: 10, completion: 5, cost: 0 },
  finishReason: "stop",
};
engine.llm = {
  askJson: async () => mockResult,
  complete: async () => mockResult,
  isMock: () => true,
};
const run = { id: "probe-run", usage: { calls: 0, prompt: 0, completion: 0, cost: 0 }, blocks: [] };
const system = "SYS";
await engine.call(run, engine.agent("coder"), {
  kind: "fix",
  system,
  user: fixUser,
  json: false,
});
const callEvent = events.find((e) => e.kind === "call");
check("call.promptChars = длина system + user", callEvent?.promptChars === system.length + fixUser.length, String(callEvent?.promptChars));
check("call.promptChars показывает реальный размер промта", Number(callEvent?.promptChars) > 5_000, String(callEvent?.promptChars));

/* --------------------------------- итог --------------------------------- */

console.log(
  failed === 0
    ? "\nВсе проверки пройдены."
    : `\nПРОВАЛОВ: ${failed} — проверки выше с пометкой FAIL.`
);
process.exit(failed === 0 ? 0 : 1);
