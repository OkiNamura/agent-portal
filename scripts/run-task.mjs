/** Универсальный прогон: задача из argv, автоподтверждение гейтов, сбор проблем. */
const BASE = process.env.BASE || "http://127.0.0.1:7777";
const TASK = process.argv[2];
const NAME = process.argv[3] || "Проект";
if (!TASK) {
  console.error("нужна задача: node scripts/run-task.mjs \"текст задачи\" \"Имя\"");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000), ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${data.error ?? ""}`);
  return data;
};

const t0 = Date.now();
const stamp = () => String(Math.round((Date.now() - t0) / 1000)).padStart(4) + "с";
const errors = [];

const { project } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: NAME, task: TASK }) });
const { run } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: TASK, projectId: project.id }) });
console.log(`[${stamp()}] проект ${project.id} · прогон ${run.id}`);

let seen = 0;
let last = "";
for (;;) {
  const { run: r } = await api(`/api/runs/${run.id}`);
  const { logs } = await api("/api/logs?limit=150");
  const mine = logs.filter((l) => l.runId === run.id).reverse();
  for (const l of mine.slice(seen)) {
    seen++;
    if (["error", "call_failed", "verdict", "gate", "done", "stage_start"].includes(l.kind)) {
      console.log(`  [${stamp()}] ${l.kind.padEnd(11)} ${l.message.slice(0, 130)}`);
      if (l.kind === "error" || l.kind === "call_failed") errors.push(l.message);
    }
  }
  const key = `${r.stageIndex}|${r.status}|${r.blocks.map((b) => b.status).join(",")}`;
  if (key !== last) {
    last = key;
    console.log(`[${stamp()}] стадия ${r.stageIndex} · ${r.status} · ${r.blocks.map((b) => b.id + ":" + b.status).join(" ")} · $${r.usage.cost.toFixed(4)}`);
  }
  if (r.status === "failed") {
    errors.push(`прогон упал: ${r.error}`);
    console.log("ПРОВАЛ:", r.error);
    break;
  }
  if (r.status === "awaiting") {
    console.log(`[${stamp()}] гейт «${r.awaiting?.title}» — принимаю`);
    await api(`/api/runs/${run.id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    continue;
  }
  if (r.status === "done") {
    console.log(`\n[${stamp()}] ГОТОВО · ${r.usage.calls} вызовов · $${r.usage.cost.toFixed(4)}`);
    for (const b of r.blocks) console.log(`  ${b.id} ${b.title}: ${b.status} · тест ${b.test?.verdict ?? "—"} · правок ${b.fixCount}`);
    console.log("\nФайлы:");
    for (const a of r.artifacts.filter((x) => x.path.startsWith("work/"))) console.log("  " + a.path + " (" + Math.round(a.size / 1024) + "КБ)");
    console.log("\nСводка:\n" + (r.summary ?? "").split("\n").slice(0, 16).map((l) => "  " + l).join("\n"));
    break;
  }
  await sleep(2500);
}

console.log("\n=== проблемы ===");
if (!errors.length) console.log("ошибок нет");
for (const e of errors) console.log("  ✖ " + e.slice(0, 180));
console.log(`\nпрогон: ${run.id}`);
