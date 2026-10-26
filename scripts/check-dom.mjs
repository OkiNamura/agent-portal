#!/usr/bin/env node
/**
 * Сверяет id, которые ищет JS, с id в HTML.
 *
 * Без аргумента проверяет сам портал (public/index.html + public/app.js) —
 * так старые пробы и ручные запуски работают как раньше.
 * С аргументом — переданный каталог: index.html и app.js/script.js в нём.
 *
 * Exit 1 только если в проверяемом каталоге нет index.html (проверять нечего).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
const target = arg ? path.resolve(arg) : path.join(ROOT, "public");
const htmlFile = path.join(target, "index.html");

if (!fs.existsSync(htmlFile)) {
  console.log(`check-dom: index.html не найден в ${target}`);
  process.exit(1);
}

let jsFile = null;
for (const name of ["app.js", "script.js"]) {
  const file = path.join(target, name);
  if (fs.existsSync(file)) {
    jsFile = file;
    break;
  }
}

const html = fs.readFileSync(htmlFile, "utf8");
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));

console.log("target:", target);
if (!jsFile) {
  console.log("ids in html:", ids.size);
  console.log("js: none (app.js / script.js не найдены)");
  console.log("missing in html: none");
  process.exit(0);
}

const js = fs.readFileSync(jsFile, "utf8");
const used = [...js.matchAll(/\$\("#([\w-]+)"\)/g)].map((m) => m[1]);
const missing = [...new Set(used)].filter((id) => !ids.has(id));

console.log("js:", path.basename(jsFile));
console.log("ids used:", new Set(used).size, "| ids in html:", ids.size);
console.log("missing in html:", missing.length ? missing.join(", ") : "none");

const sel = [...js.matchAll(/(?:querySelector|el)\(["'`]?(#[\w-]+)/g)].map((m) => m[1]);
console.log("extra selectors:", sel.length ? sel.join(", ") : "none");
