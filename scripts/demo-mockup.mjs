/** Живой прогон нового проекта до гейта «Макет и дизайн» — и остановка там. */
const BASE = process.env.BASE || "http://127.0.0.1:7777";
const TASK = process.argv[2] ?? "Страница заметок: список заметок, добавление новой, удаление, счётчик, тёмная тема. Локально, без сервера.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, o = {}) => {
  const res = await fetch(BASE + p, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    ...o,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} -> ${res.status}: ${data.error ?? ""}`);
  return data;
};

const t0 = Date.now();
const stamp = () => String(Math.round((Date.now() - t0) / 1000)).padStart(4) + "s";

const { project } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Заметки", task: TASK }) });
const { run } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: TASK, projectId: project.id }) });
const id = run.id;
console.log(`[${stamp()}] проект ${project.id} · прогон ${id}`);

let lastStage = -1;
for (;;) {
  const { run: r } = await api(`/api/runs/${id}`);
  if (r.stageIndex !== lastStage && r.status === "running") {
    lastStage = r.stageIndex;
    console.log(`[${stamp()}] стадия ${r.stageIndex} · ${r.blocks.map((b) => b.id + ":" + b.status).join(" ")} · $${r.usage.cost.toFixed(4)}`);
  }
  if (r.status === "failed") {
    console.log("ПРОВАЛ:", r.error);
    break;
  }
  if (r.status === "awaiting") {
    console.log(`[${stamp()}] гейт: ${r.awaiting.title}`);
    if (r.awaiting.stageId === "mockup") {
      const bytes = r.artifacts.find((a) => a.path === "mockup.html")?.size ?? 0;
      console.log(`[${stamp()}] макет готов: ${(bytes / 1024).toFixed(1)} КБ · $${r.usage.cost.toFixed(4)}`);
      const res = await fetch(`${BASE}/preview/${id}/mockup`);
      const html = await res.text();
      console.log(`[${stamp()}] превью: ${res.status} · ${html.length} симв. · внешних ссылок: ${(html.match(/https?:\/\/(?!www\.w3\.org)/g) ?? []).length}`);
      console.log(`\nОСТАНОВИЛСЯ НА ГЕЙТЕ МАКЕТА. Прогон ${id}`);
      break;
    }
    await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    continue;
  }
  if (r.status === "done") {
    console.log("готово без остановки");
    break;
  }
  await sleep(1500);
}
