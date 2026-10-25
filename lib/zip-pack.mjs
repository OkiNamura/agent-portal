/**
 * Экспорт прогона в ZIP: файлы проекта + README.md + отчёты (artifacts/*.md).
 *
 * Сам архив собирает lib/zip.mjs (zipStore), здесь только раскладка файлов:
 *   <корень>            — файлы проекта из artifacts/work/**
 *   README.md           — задача, план блоков и как открыть проект
 *   artifacts/**        — спеки, проверки, правки и сводка
 *
 * Если в проекте уже есть свой README.md, он попадает в архив как
 * README.project.md — так README.md всегда описывает сам архив.
 */
import fs from "node:fs";
import path from "node:path";

import { zipStore } from "./zip.mjs";

const REPORT_RE = /\.md$/i;

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
 * Собирает архив прогона.
 * @param {{ run: object, store: object, project?: object|null }} args
 * @returns {{ buffer: Buffer, name: string, ascii: string }}
 */
export function buildProjectZip({ run, store, project = null }) {
  if (!run?.id) throw new Error("buildProjectZip: нет прогона");
  const entries = [];
  const added = new Set();

  const add = (name, data, { unique = false } = {}) => {
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
    entries.push({ name: final, data });
    return true;
  };

  /* 1. файлы проекта: artifacts/work/** (на диске — правда), плюс workspace как запасной вариант */
  const workDir = path.join(store.runDir(run.id), "artifacts", "work");
  const workFiles = walkFiles(workDir);
  const onDisk = new Set();
  for (const f of workFiles) {
    onDisk.add(f.rel);
    const data = fs.readFileSync(f.full);
    if (f.rel === "README.md") add("README.project.md", data);
    else add(f.rel, data);
  }
  for (const [rel, content] of Object.entries(run.workspace ?? {})) {
    const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!clean || clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.split("/").includes("..") || onDisk.has(clean)) continue;
    if (clean === "README.md") add("README.project.md", String(content ?? ""));
    else add(clean, String(content ?? ""));
  }

  /* 2. отчёты: только md, без work/** (это уже файлы проекта) */
  const reports = [];
  for (const a of store.listArtifacts(run)) {
    if (!REPORT_RE.test(a.path) || a.path.startsWith("work/")) continue;
    const full = path.join(store.runDir(run.id), "artifacts", a.path);
    if (!fs.existsSync(full)) continue;
    const name = `artifacts/${a.path}`;
    if (add(name, fs.readFileSync(full), { unique: true })) reports.push(name);
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
    add("README_PORTAL.md", readme);
  } else {
    add("README.md", readme);
  }

  const base = cleanBase(project?.name || run.plan?.title || "Проект", "project");
  return {
    buffer: zipStore(entries),
    name: `${base}.zip`,
    ascii: `${asciiBase(base) || "project"}-${run.id}.zip`,
  };
}
