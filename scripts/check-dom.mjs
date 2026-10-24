import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const used = [...js.matchAll(/\$\("#([\w-]+)"\)/g)].map((m) => m[1]);
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const missing = [...new Set(used)].filter((id) => !ids.has(id));

console.log("ids used:", new Set(used).size, "| ids in html:", ids.size);
console.log("missing in html:", missing.length ? missing.join(", ") : "none");

const sel = [...js.matchAll(/(?:querySelector|el)\(["'`]?(#[\w-]+)/g)].map((m) => m[1]);
console.log("extra selectors:", sel.length ? sel.join(", ") : "none");
