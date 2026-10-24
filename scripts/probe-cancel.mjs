/** Отмена и продолжение прогона: статус, флаг, повторный запуск. */
const BASE = process.env.BASE || "http://127.0.0.1:7780";
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
const waitFor = async (id, pred, ms = 15000) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = (await api(`/api/runs/${id}`)).data.run;
    if (pred(last)) return last;
    await sleep(200);
  }
  return last;
};

const { data: pj } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Отмена", task: "Прогон для проверки отмены и продолжения" }) });
const { data: rn } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: pj.project.task, projectId: pj.project.id }) });
const id = rn.run.id;

await sleep(400);
const c = await api(`/api/runs/${id}/cancel`, { method: "POST" });
check("отмена отвечает сразу", c.status === 200, `статус в ответе: ${c.data.run?.status}`);

const stopped = await waitFor(id, (r) => r.status === "cancelled", 12000);
check("прогон действительно остановился", stopped.status === "cancelled", `статус ${stopped.status}`);

const approveAfter = await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
check("подтверждение отменённого отклонено", approveAfter.status === 400, approveAfter.data?.error?.slice(0, 40));

const res = await api(`/api/runs/${id}/resume`, { method: "POST" });
await sleep(300);
check("продолжение запускает прогон заново", res.status === 202, `статус ${res.status}`);

const alive = await waitFor(id, (r) => ["done", "failed", "awaiting", "awaiting_plan"].includes(r.status), 40000);
check("после продолжения прогон идёт, а не стоит отменённым", alive.status !== "cancelled", `статус ${alive.status}`);

console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
