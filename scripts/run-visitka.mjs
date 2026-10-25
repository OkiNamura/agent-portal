/** Прогон «сайт-визитка об ИИ» с автоподтверждением гейтов и сбором проблем. */
const BASE = process.env.BASE || "http://127.0.0.1:7777";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TASK = `Сделай одностраничный сайт-визитку об ИИ-ассистенте (DeepSeek Harness).
Содержание: кто это, что умеет, чем отличается от обычного чата, как начать работу, честные ограничения.
Оформление: тёмная тема, аккуратная типографика, блоки: герой с заголовком, возможности (4–6 карточек), как это работает (3–4 шага),
ограничения (честно, без маркетинга), контакты/призыв. Статический HTML/CSS/JS, без сервера и внешних библиотек.`;

const errors = [];
const notes = [];

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000), ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${data.error ?? ""}`);
  return data;
};

const t0 = Date.now();
const stamp = () => String(Math.round((Date.now() - t0) / 1000)).padStart(4) + "с";

const { project } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Визитка ИИ", task: TASK }) });
const { run } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: TASK, projectId: project.id }) });
const id = run.id;
console.log(`[${stamp()}] проект ${project.id} · прогон ${id}`);

let seenEvent = 0;
let lastKey = "";
for (;;) {
  const { run: r } = await api(`/api/runs/${id}`);
  const { logs } = await api("/api/logs?limit=120");
  const mine = logs.filter((l) => l.runId === id).reverse();
  for (const l of mine.slice(seenEvent)) {
    seenEvent++;
    if (["error", "call_failed", "verdict", "gate", "done", "stage_start", "plan_needed"].includes(l.kind)) {
      console.log(`  [${stamp()}] ${l.kind.padEnd(11)} ${l.message.slice(0, 130)}`);
      if (l.kind === "error" || l.kind === "call_failed") errors.push(l.message);
    }
  }

  const key = `${r.stageIndex}|${r.status}|${r.blocks.map((b) => b.status).join(",")}`;
  if (key !== lastKey) {
    lastKey = key;
    console.log(`[${stamp()}] стадия ${r.stageIndex} · ${r.status} · ${r.blocks.map((b) => b.id + ":" + b.status).join(" ")} · $${r.usage.cost.toFixed(4)}`);
  }

  if (r.status === "failed") {
    errors.push(`прогон упал: ${r.error}`);
    console.log("ПРОВАЛ:", r.error);
    break;
  }

  if (r.status === "awaiting") {
    console.log(`[${stamp()}] гейт «${r.awaiting?.title}» — принимаю`);
    if (r.awaiting?.stageId === "plan" && r.plan) {
      for (const b of r.plan.blocks) console.log(`    ${b.id}. ${b.title}`);
      const behavioural = r.plan.blocks.some((b) => b.acceptance?.some((a) => /нажм|оты|увид|провер|работ/i.test(a)));
      if (!behavioural) notes.push("в плане нет поведенческих критериев приёмки");
    }
    if (r.awaiting?.stageId === "mockup") {
      notes.push(`макет: ${r.artifacts.find((a) => a.path === "mockup.html")?.size ?? 0} байт`);
    }
    await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    continue;
  }

  if (r.status === "done") {
    console.log(`\n[${stamp()}] ГОТОВО · ${r.usage.calls} вызовов · $${r.usage.cost.toFixed(4)}`);
    for (const b of r.blocks) {
      console.log(`  ${b.id} ${b.title}: ${b.status} · тест ${b.test?.verdict ?? "—"} · правок ${b.fixCount}`);
      if (b.status === "failed") errors.push(`блок ${b.id} не прошёл проверку`);
    }
    console.log("\nФайлы:");
    for (const a of r.artifacts.filter((x) => x.path.startsWith("work/") || x.path === "mockup.html")) console.log("  " + a.path);
    console.log("\nСводка:\n" + (r.summary ?? "").split("\n").slice(0, 18).map((l) => "  " + l).join("\n"));
    break;
  }

  await sleep(2500);
}

console.log("\n=== проблемы ===");
if (!errors.length) console.log("ошибок нет");
for (const e of errors) console.log("  ✖ " + e.slice(0, 200));
if (notes.length) {
  console.log("=== заметки ===");
  for (const n of notes) console.log("  · " + n);
}
console.log(`\nпрогон: ${id}`);
