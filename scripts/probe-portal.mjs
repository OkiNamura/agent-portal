/** Проверка нового контура: проекты, макет, превью, гейты. */
const BASE = process.env.BASE || "http://127.0.0.1:7779";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000), ...opts });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitFor(id, pred, ms = 60_000, label = "") {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    const { data } = await api(`/api/runs/${id}`);
    last = data.run;
    if (pred(last)) return last;
    await sleep(250);
  }
  throw new Error(`таймаут ${label}: ${last?.status}`);
}

const st = await api("/api/state");
check("в состоянии есть проекты", Array.isArray(st.data.projects), `проектов: ${st.data.projects?.length}`);

const { data: proj } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Тестовый проект", task: "Страница с формой и списком задач" }) });
check("проект создаётся", Boolean(proj.project?.id), proj.project?.id);

const { data: r1 } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: proj.project.task, projectId: proj.project.id }) });
const id = r1.run.id;
check("прогон привязан к проекту", r1.run.projectId === proj.project.id);

let run = await waitFor(id, (r) => r.status === "awaiting");
check("первый гейт — декомпозиция", run.awaiting?.stageId === "plan");
await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });

run = await waitFor(id, (r) => r.status === "awaiting");
check("второй гейт — спеки", run.awaiting?.stageId === "spec");
await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });

run = await waitFor(id, (r) => r.status === "awaiting");
check("третий гейт — макет и дизайн", run.awaiting?.stageId === "mockup");
check("макет отмечен в прогоне", run.hasMockup === true);

const preview = await fetch(`${BASE}/preview/${id}/mockup`);
const html = await preview.text();
check("превью макета отдаётся", preview.status === 200 && html.includes("<!doctype html"), `${html.length} байт`);
check("макет без внешних ресурсов", !/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org[^"]*/g, "")));

await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
run = await waitFor(id, (r) => r.status === "awaiting" || r.status === "done");
if (run.status === "awaiting") {
  check("финальный гейт — сводка", run.awaiting?.stageId === "report");
  await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  run = await waitFor(id, (r) => r.status === "done");
}

check("прогон завершён", run.status === "done", `$${run.usage.cost.toFixed(4)}`);
const appPreview = await fetch(`${BASE}/preview/${id}/app/`);
check("превью результата отдаётся", appPreview.status === 200, `статус ${appPreview.status}`);

const { data: p2 } = await api(`/api/projects/${proj.project.id}`);
check("проект знает свои прогоны", p2.project.runs.length === 1, `прогонов: ${p2.project.runs.length}`);

const cfg = (await api("/api/state")).data;
check("в конфиге есть внешний оркестратор", cfg.agents.agents.some((a) => a.kind === "external" && a.id === "harness"));
check("в пайплайне есть стадия макета", cfg.pipeline.stages.some((s) => s.kind === "mockup"));

const bad = await fetch(`${BASE}/preview/${id}/app/..%2f..%2fstate.json`);
check("превью не отдаёт файлы вне work", bad.status !== 200, `статус ${bad.status}`);

console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
