/** API-проверка диффа: первая версия → 400, доработка → 200 со сводкой. */
const BASE = process.env.BASE || "http://127.0.0.1:7781";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, ok, d = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${n}${d ? " — " + d : ""}`);
};
const api = async (p, o = {}) => {
  const res = await fetch(BASE + p, { headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000), ...o });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const drive = async (id) => {
  for (let i = 0; i < 120; i++) {
    const r = (await api(`/api/runs/${id}`)).data.run;
    if (r.status === "awaiting") {
      await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    } else if (["done", "failed"].includes(r.status)) return r;
    await sleep(300);
  }
  return (await api(`/api/runs/${id}`)).data.run;
};

const { data: pj } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Дифф", task: "Проект для проверки сравнения версий" }) });
const { data: r1 } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: pj.project.task, projectId: pj.project.id }) });
const run1 = await drive(r1.run.id);
check("первая версия завершена", run1.status === "done", run1.status);

const first = await api(`/api/runs/${run1.id}/diff`);
check("у первой версии сравнивать не с чем", first.status === 400, first.data?.error?.slice(0, 40));

const { data: r2 } = await api("/api/runs", {
  method: "POST",
  body: JSON.stringify({ task: pj.project.task, projectId: pj.project.id, baseRunId: run1.id, change: "добавь кнопку сброса" }),
});
const run2 = await drive(r2.run.id);
check("доработка завершена", run2.status === "done", run2.status);

const diff = await api(`/api/runs/${run2.id}/diff`);
check("дифф доработки отдаётся", diff.status === 200, `статус ${diff.status}`);
check("в ответе есть база и текущая версия", Boolean(diff.data.base?.id && diff.data.current?.id), `${diff.data.base?.id} → ${diff.data.current?.id}`);
check("сводка на месте", typeof diff.data.summary?.added === "number" && Array.isArray(diff.data.files), `файлов ${diff.data.summary?.files}, +${diff.data.summary?.added}/−${diff.data.summary?.removed}`);

if (diff.data.files?.length) {
  const f = diff.data.files[0];
  check("у файла есть hunks", Array.isArray(f.hunks) && f.hunks.length > 0, `${f.path} (${f.status})`);
  check("в hunks есть типы add/del/ctx", f.hunks.every((h) => ["add", "del", "ctx", "meta"].includes(h.type)));
}

console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
