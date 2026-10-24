/** Юнит-проверка диффа: считает добавленные/удалённые строки и не падает на больших файлах. */
import { diffLines, diffWorkspaces } from "../lib/diff.mjs";

let failed = 0;
const check = (n, ok, d = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${n}${d ? " — " + d : ""}`);
};

const a = "один\nдва\nтри\nчетыре";
const b = "один\nдва изменён\nтри\nчетыре\nпять";
const ops = diffLines(a, b);
const add = ops.filter((o) => o.type === "add").length;
const del = ops.filter((o) => o.type === "del").length;
const ctx = ops.filter((o) => o.type === "ctx").length;

check("дифф нашёл добавление", add === 2, `add=${add}`);
check("дифф нашёл удаление", del === 1, `del=${del}`);
check("контекст сохранён", ctx === 3, `ctx=${ctx}`);

const same = diffLines("x\ny", "x\ny");
check("одинаковые файлы не дают изменений", same.every((o) => o.type === "ctx"));

const res = diffWorkspaces(
  { "a.js": "1\n2\n3", "gone.txt": "старое" },
  { "a.js": "1\n2 изменено\n3", "new.txt": "новое\nещё" }
);
check("изменённый файл на месте", res.files.some((f) => f.path === "a.js" && f.status === "changed"));
check("удалённый файл помечен", res.files.some((f) => f.path === "gone.txt" && f.status === "deleted"));
check("новый файл помечен", res.files.some((f) => f.path === "new.txt" && f.status === "added"));
check("сводка непротиворечива", res.summary.files === res.files.length && res.summary.added > 0);

const big = Array.from({ length: 3000 }, (_, i) => `строка ${i}`).join("\n");
const bigOps = diffLines(big, big + "\nещё");
check("большой файл не падает", bigOps.length > 0);

console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
