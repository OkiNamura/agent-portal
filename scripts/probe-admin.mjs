/** Проверка новых разделов: задачи, логи, статистика, удаление проекта и агента. */
const BASE = process.env.BASE || "http://127.0.0.1:7779";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, d = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${n}${d ? " — " + d : ""}`);
};
const api = async (p, o = {}) => {
  const res = await fetch(BASE + p, { headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000), ...o });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const st = (await api("/api/state")).data;
const original = JSON.parse(JSON.stringify(st.agents));

// проект + прогон
const { data: pj } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Проект для удаления", task: "Проверка удаления проекта и прогонов" }) });
const { data: rn } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: pj.project.task, projectId: pj.project.id }) });
await sleep(1200);

const tasks = (await api("/api/tasks")).data.tasks;
check("текущие задачи отдаются", Array.isArray(tasks) && tasks.some((t) => t.projectId === pj.project.id), `задач: ${tasks.length}`);

const logs = (await api("/api/logs?limit=50")).data.logs;
check("общий лог отдаётся", Array.isArray(logs) && logs.length > 0, `строк: ${logs.length}`);
check("в логе есть проект и вид события", logs.every((l) => "kind" in l && "project" in l));

const stats = (await api("/api/stats")).data.stats;
check("статистика считается", typeof stats.cost === "number" && Array.isArray(stats.projects), `$${stats.cost.toFixed(4)}`);

const ask = await api("/api/assistant", { method: "POST", body: JSON.stringify({ question: "где остановился проект?" }) });
check("ассистент отвечает", ask.status === 200 && (ask.data.answer ?? "").length > 20, `модель ${ask.data.model ?? "—"}`);

const emptyAsk = await api("/api/assistant", { method: "POST", body: JSON.stringify({ question: "  " }) });
check("пустой вопрос ассистенту отклонён", emptyAsk.status === 400);

// удаление агента, который занят в пайплайне
const busy = await api("/api/agents/orchestrator", { method: "DELETE" });
check("занятого агента удалить нельзя", busy.status === 409, busy.data?.error?.slice(0, 60));

// создание и удаление свободного агента
const created = JSON.parse(JSON.stringify(original));
created.agents.push({ id: "temp-agent", name: "Временный", role: "тест", kind: "llm", model: "deepseek/deepseek-v3.2", temperature: 0.2, prompt: "тест" });
await api("/api/config", { method: "POST", body: JSON.stringify({ agents: created, pipeline: st.pipeline }) });
const del = await api("/api/agents/temp-agent", { method: "DELETE" });
check("свободный агент удаляется", del.status === 200 && !del.data.agents.agents.some((a) => a.id === "temp-agent"));

// удаление активного проекта
const delActive = await api(`/api/projects/${pj.project.id}`, { method: "DELETE" });
check("активный проект удалить нельзя", delActive.status === 409, delActive.data?.error?.slice(0, 50));

// отменяем и удаляем
await api(`/api/runs/${rn.run.id}/cancel`, { method: "POST" });
await sleep(800);
const delOk = await api(`/api/projects/${pj.project.id}`, { method: "DELETE" });
check("проект с прогонами удаляется", delOk.status === 200, `удалено прогонов: ${delOk.data?.deletedRuns}`);
const after = (await api("/api/state")).data.projects;
check("проект исчез из списка", !after.some((p) => p.id === pj.project.id));

await api("/api/config", { method: "POST", body: JSON.stringify({ agents: original, pipeline: st.pipeline }) });
console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
