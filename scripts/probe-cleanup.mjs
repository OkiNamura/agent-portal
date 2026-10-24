/** Проверка: удаление проекта не оставляет каталогов, уборка мусора работает. */
const BASE = process.env.BASE || "http://127.0.0.1:7780";
const fs = await import("node:fs");
const path = await import("node:path");
const RUNS = process.env.RUNS_DIR ?? path.join(process.cwd(), "runs");

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
const exists = (id) => fs.existsSync(path.join(RUNS, id));

// 1. создать проект и довести прогон до конца
const { data: pj } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Удаляемый", task: "Проект, который мы удалим и проверим диск" }) });
const { data: rn } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: pj.project.task, projectId: pj.project.id }) });
const id = rn.run.id;

for (let i = 0; i < 60; i++) {
  const r = (await api(`/api/runs/${id}`)).data.run;
  if (r.status === "awaiting") {
    await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  } else if (["done", "failed"].includes(r.status)) break;
  await sleep(400);
}
check("прогон создал каталог", exists(id));

// 2. удалить проект
const del = await api(`/api/projects/${pj.project.id}`, { method: "DELETE" });
check("удаление прошло", del.status === 200, `leftover: ${JSON.stringify(del.data.leftover ?? [])}`);
await sleep(300);
check("каталог прогона удалён с диска", !exists(id));

// 3. мусор: создаём «сироту» руками и убираем
const orphan = path.join(RUNS, "orphan-test-dir");
fs.mkdirSync(orphan, { recursive: true });
fs.writeFileSync(path.join(orphan, "junk.txt"), "x");
const clean = await api("/api/maintenance/cleanup", { method: "POST" });
check("уборка мусора сработала", clean.status === 200 && clean.data.removed.includes("orphan-test-dir"), `удалено: ${clean.data.removed?.length}`);
check("сирота удалена", !fs.existsSync(orphan));

// 4. гейты: остались только план и макет
const st = (await api("/api/state")).data;
const gates = st.pipeline.stages.filter((s) => s.gate).map((s) => s.id);
check("гейтов ровно два: plan и mockup", gates.length === 2 && gates.includes("plan") && gates.includes("mockup"), gates.join(", "));

console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
