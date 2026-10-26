/** Достать последние отчёты проверки по блокам прогона. */
const BASE = process.env.BASE || "http://127.0.0.1:7777";

const login = await fetch(BASE + "/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ login: "admin", password: process.env.PORTAL_PASS }),
});
const cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0] ?? "";
const api = async (p) => {
  const r = await fetch(BASE + p, { headers: { Cookie: cookie } });
  return r.json();
};

const state = await api("/api/state");
const project = state.projects.find((p) => /Блокнот/.test(p.name) && p.name.includes("4")) ?? state.projects.at(-1);
const run = (await api(`/api/runs/${project.runs[0].id}`)).run;
console.log(`проект ${project.name} · прогон ${run.id} · ${run.status} · $${run.usage.cost.toFixed(4)}`);

for (const b of run.blocks) {
  const tests = run.artifacts.filter((a) => a.path.startsWith(`blocks/${b.id}/test-`)).map((a) => a.path).sort();
  const last = tests.at(-1);
  if (!last) continue;
  const { content } = await api(`/api/runs/${run.id}/artifact?path=${encodeURIComponent(last)}`);
  const defects = (content.split("## Дефекты")[1] ?? "").split("\n").filter((l) => l.trim().startsWith("-")).slice(0, 2);
  console.log(`\n=== ${b.id} ${b.title} · ${b.status} · ${last} ===`);
  for (const d of defects) console.log(d.trim().slice(0, 300));
}
