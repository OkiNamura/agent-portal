/** Static sanity check of the generated page: ids wired, files referenced, JS parses. */
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const files = fs.readdirSync(dir);
console.log("файлы:", files.join(", "));

const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const js = fs.readFileSync(path.join(dir, "script.js"), "utf8");

const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const jsIds = [...js.matchAll(/getElementById\(["']([\w-]+)["']\)/g)].map((m) => m[1]);
const missing = [...new Set(jsIds)].filter((id) => !htmlIds.has(id));

console.log("id в html:", [...htmlIds].join(", "));
console.log("id из js :", [...new Set(jsIds)].join(", "));
console.log("js ищет, но в html нет:", missing.length ? missing.join(", ") : "— нет");

for (const ref of ["script.js", "style.css"]) {
  console.log(`ссылка на ${ref}:`, html.includes(ref) ? "есть" : "НЕТ");
}

// classic script (no import/export) — компилируем в процессе, без запуска node
try {
  new Function(js);
  console.log("синтаксис script.js: ок");
} catch (e) {
  console.log("синтаксис script.js: ОШИБКА —", e.message);
}

for (const op of ["+", "−", "×", "÷"]) {
  console.log(`операция ${op}:`, js.includes(op) ? "есть" : "нет");
}
console.log("деление на ноль обработано:", /0\s*===?\s*|divide|делен/i.test(js) ? "похоже, да" : "не видно");
