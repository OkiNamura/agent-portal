/** Проверка целостности данных после чистки: висячие ссылки, осиротевшие прогоны, файлы студии. */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (p, def) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return def;
  }
};
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const projects = read("projects.json", { projects: [] }).projects ?? [];
const runsOnDisk = fs.existsSync(path.join(ROOT, "runs")) ? fs.readdirSync(path.join(ROOT, "runs")) : [];
const runsInProjects = new Set();
const problems = [];

for (const p of projects) {
  for (const id of p.runIds ?? []) {
    runsInProjects.add(id);
    if (!runsOnDisk.includes(id)) problems.push(`проект «${p.name}» ссылается на отсутствующий прогон ${id}`);
  }
}
for (const id of runsOnDisk) {
  if (!runsInProjects.has(id)) problems.push(`прогон ${id} лежит на диске, но ни к одному проекту не привязан`);
}

const sessions = read("studio/sessions.json", { sessions: [] }).sessions ?? [];
const images = read("studio/index.json", { items: [] }).items ?? [];
const library = read("studio/library.json", { items: {} }).items ?? {};
const chatIds = new Set(sessions.map((s) => s.id));
const imageIds = new Set(images.map((i) => i.id));

for (const ref of Object.keys(library)) {
  const [kind, id] = ref.split(":");
  if (kind === "chat" && !chatIds.has(id)) problems.push(`библиотека: мёртвая ссылка на чат ${id}`);
  if (kind === "image" && !imageIds.has(id)) problems.push(`библиотека: мёртвая ссылка на картинку ${id}`);
}
for (const img of images) {
  if (!exists(path.join("studio", img.file))) problems.push(`картинка ${img.id}: файла ${img.file} нет`);
}
for (const s of sessions) {
  const f = path.join("studio", "threads", `${s.id}.json`);
  if (!exists(f)) problems.push(`чат «${s.name}» (${s.id}): нет файла переписки`);
}

const mailbox = read("mailbox.json", { items: [] }).items ?? [];
const runIdsInMail = new Set(mailbox.map((m) => m.runId).filter(Boolean));
for (const id of runIdsInMail) {
  if (!runsOnDisk.includes(id)) problems.push(`почта: уведомление ссылается на удалённый прогон ${id}`);
}

const watch = read("runs/watch.state.json", null);
if (watch) problems.push(`дежурный сохранён: running=${watch.running}, everyMin=${watch.everyMin}`);

console.log(`проектов: ${projects.length} | прогонов на диске: ${runsOnDisk.length} | чатов: ${sessions.length} | картинок: ${images.length} | записей библиотеки: ${Object.keys(library).length} | писем: ${mailbox.length}`);
console.log("\nпроблемы:");
if (!problems.length) console.log("  нет");
for (const p of problems) console.log("  · " + p);
