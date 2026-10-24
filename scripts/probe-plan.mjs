/** Проверка внешнего оркестратора: план приходит извне, а не от модели. */
const BASE = process.env.BASE || "http://127.0.0.1:7779";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, o = {}) => {
  const res = await fetch(BASE + p, { headers: { "Content-Type": "application/json" }, ...o, signal: AbortSignal.timeout(20000) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const state = (await api("/api/state")).data;
const original = JSON.parse(JSON.stringify(state.agents));
const patched = JSON.parse(JSON.stringify(state.agents));
patched.agents.find((a) => a.id === "orchestrator").kind = "external";
await api("/api/config", { method: "POST", body: JSON.stringify({ agents: patched, pipeline: state.pipeline }) });

const { data: p } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Внешний оркестратор", task: "Проверка ручного плана" }) });
const { data: r } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: p.project.task, projectId: p.project.id }) });
const id = r.run.id;

let run;
for (let i = 0; i < 40; i++) {
  run = (await api(`/api/runs/${id}`)).data.run;
  if (run.status === "awaiting_plan") break;
  await sleep(250);
}
console.log("ждал план:", run.status === "awaiting_plan" ? "да" : "НЕТ (" + run.status + ")");

const plan = {
  title: "Ручной план",
  blocks: [{ id: "b1", title: "Один блок", goal: "Проверить ручной план", acceptance: ["блок появился"], deps: [] }],
};
const applied = await api(`/api/runs/${id}/plan`, { method: "POST", body: JSON.stringify(plan) });
console.log("план применён:", applied.status === 200 ? "да" : "НЕТ (" + applied.status + " " + (applied.data?.error ?? "") + ")");
console.log("блоки:", applied.data?.run?.blocks?.map((b) => b.id + ":" + b.title).join(", ") ?? "—");

await sleep(600);
const after = (await api(`/api/runs/${id}`)).data.run;
console.log("прогон пошёл дальше:", after.status !== "awaiting_plan", `статус ${after.status}`);

await api("/api/config", { method: "POST", body: JSON.stringify({ agents: original, pipeline: state.pipeline }) });
