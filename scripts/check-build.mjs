/** Быстрая проверка собранного проекта: ссылки, id, последние дефекты. */
import fs from "node:fs";
import path from "node:path";

const id = process.argv[2];
const base = path.join("runs", id, "artifacts");
const work = path.join(base, "work");
const html = fs.readFileSync(path.join(work, "index.html"), "utf8");

const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((r) => !/^#|^https?:|^data:/.test(r));
const broken = refs.filter((r) => !fs.existsSync(path.join(work, r)));
const ids = [...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]);

console.log("файлы:", fs.readdirSync(work).join(", "));
console.log("ссылки:", refs.join(", ") || "—");
console.log("битые ссылки:", broken.join(", ") || "нет");
console.log("id в html:", ids.join(", ") || "—");

const jsFiles = fs.readdirSync(work).filter((f) => f.endsWith(".js"));
for (const f of jsFiles) {
  const code = fs.readFileSync(path.join(work, f), "utf8");
  try {
    new Function(code);
  } catch (e) {
    console.log(`синтаксис ${f}: ОШИБКА — ${e.message}`);
  }
  const wanted = [...code.matchAll(/getElementById\(["']([\w-]+)["']\)/g)].map((m) => m[1]);
  const missing = [...new Set(wanted)].filter((x) => !ids.includes(x));
  if (missing.length) console.log(`${f} ищет элементы, которых нет в html: ${missing.join(", ")}`);
}
console.log("синтаксис js: проверен");

for (const b of ["b1", "b2", "b3", "b4"]) {
  const dir = path.join(base, "blocks", b);
  if (!fs.existsSync(dir)) continue;
  const tests = fs.readdirSync(dir).filter((f) => /^test-\d+\.md$/.test(f)).sort();
  if (!tests.length) continue;
  const text = fs.readFileSync(path.join(dir, tests[tests.length - 1]), "utf8");
  const block = text.split("## Дефекты")[1] ?? "";
  const lines = block.split("\n").filter((l) => l.trim().startsWith("-")).slice(0, 4);
  console.log(`\n=== ${b} (${tests[tests.length - 1]}) ===`);
  for (const l of lines) console.log("  " + l.trim().slice(0, 220));
}
