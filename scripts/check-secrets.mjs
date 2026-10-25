/** Проверка перед пушем: не попали ли в файлы реальные ключи. */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git", ".tools", "runs", "studio", "output"]);
const PATTERNS = [
  { name: "OpenRouter", re: /sk-or-v1-[A-Za-z0-9]{20,}/ },
  { name: "OpenAI", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "Anthropic", re: /sk-ant-[A-Za-z0-9-]{20,}/ },
  { name: "Telegram bot", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/ },
];

const problems = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }
    const file = path.join(dir, entry.name);
    if (entry.name === ".env" || entry.name === "keys.json") continue; // локальные секреты — не в репозитории
    if (/\.(png|jpe?g|webp|gif|ico|woff2?|zip|docx|xlsx)$/i.test(entry.name)) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const p of PATTERNS) {
      const m = text.match(p.re);
      if (m) problems.push({ file: path.relative(ROOT, file), kind: p.name, sample: m[0].slice(0, 12) + "…" });
    }
  }
}

walk(ROOT);

if (problems.length) {
  console.log("НАЙДЕНЫ ПОХОЖИЕ НА СЕКРЕТЫ СТРОКИ:\n");
  for (const p of problems) console.log(`  ${p.file} — ${p.kind} (${p.sample})`);
  console.log("\nУбери их из файлов перед коммитом.");
  process.exit(1);
}

console.log("секретов в файлах не найдено — можно коммитить и пушить");
