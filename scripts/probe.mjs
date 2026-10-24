/**
 * Process probes: не качество кода, а поведение портала.
 * Гоняется по MOCK-серверу на отдельном порту и отдельном каталоге прогонов.
 */
const BASE = process.env.BASE || "http://127.0.0.1:7778";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitFor(id, pred, ms = 90_000, label = "") {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    const { data } = await api(`/api/runs/${id}`);
    last = data.run;
    if (pred(last)) return last;
    await sleep(300);
  }
  throw new Error(`таймаут ${label} (${id}) статус=${last?.status}`);
}

const approve = (id, comment = "") =>
  api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve", comment }) });
const reject = (id, comment) =>
  api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "reject", comment }) });

/** пройти все гейты до done */
async function drive(id) {
  for (let i = 0; i < 10; i++) {
    const r = await waitFor(id, (x) => ["awaiting", "done", "failed", "cancelled"].includes(x.status), 90_000, "гейт");
    if (r.status !== "awaiting") return r;
    await approve(id);
    await sleep(150);
  }
  throw new Error("слишком много гейтов");
}

/* ---------- 1. старт ---------- */
const { status: s1, data: d1 } = await api("/api/runs", {
  method: "POST",
  body: JSON.stringify({ task: "Проверка процесса: страница с кнопкой и счётчиком" }),
});
check("прогон стартует", s1 === 201 && Boolean(d1.run?.id), `id=${d1.run?.id}`);
const id = d1.run.id;

/* ---------- 2. гейт и валидация отказов ---------- */
await waitFor(id, (r) => r.status === "awaiting");
const r2 = await reject(id, "");
check("отказ без комментария отклонён", r2.status === 400, r2.data?.error ?? "нет ошибки");

const r2b = await reject(id, "слишком крупные блоки, раздели на части");
check("отказ с комментарием принят", r2b.status === 200, `статус прогона: ${r2b.data?.run?.status}`);

await waitFor(id, (r) => r.status === "awaiting", 60_000, "повторный гейт");
const r3 = await approve(id);
check("подтверждение принято", r3.status === 200, r3.data?.run?.status ?? "");
const r3b = await approve(id);
check("повторное подтверждение отклонено", r3b.status === 400, r3b.data?.error ?? "");

/* ---------- 3. параллельный прогон ---------- */
const { data: d4 } = await api("/api/runs", {
  method: "POST",
  body: JSON.stringify({ task: "Второй параллельный прогон для проверки одновременной работы" }),
});
check("второй прогон создаётся при активном первом", Boolean(d4.run?.id), d4.run?.id ?? "");

/* ---------- 4. отмена ---------- */
const { data: d5 } = await api("/api/runs", {
  method: "POST",
  body: JSON.stringify({ task: "Прогон, который мы отменим посередине работы" }),
});
const cancelId = d5.run.id;
await sleep(900);
const c = await api(`/api/runs/${cancelId}/cancel`, { method: "POST" });
void c;
const cancelled = await waitFor(cancelId, (r) => r.status === "cancelled", 40_000, "отмена").catch(() => null);
check("отмена доходит до cancelled", Boolean(cancelled), cancelled ? "да" : "нет");

/* ---------- 5. доработка ---------- */
const base = await drive(id);
check("прогон доходит до done", base.status === "done", `статус ${base.status}, $${base.usage?.cost?.toFixed?.(4) ?? 0}`);

const { status: s6, data: d6 } = await api("/api/runs", {
  method: "POST",
  body: JSON.stringify({ task: base.task, baseRunId: base.id, change: "добавь кнопку «=», чтобы результат считался по нажатию" }),
});
const iter = d6.run;
check("доработка создаётся", s6 === 201 && Boolean(iter?.id), iter?.id ?? "");
check(
  "код базового прогона перенесён в доработку",
  (iter?.artifacts ?? []).some((a) => a.path.startsWith("work/")),
  `файлов: ${(iter?.artifacts ?? []).filter((a) => a.path.startsWith("work/")).length}`
);
check("доработка помнит baseId", iter?.baseId === base.id, iter?.baseId ?? "нет");

/* ---------- 6. SSE ---------- */
let sseText = "";
try {
  const res = await fetch(`${BASE}/api/runs/${id}/events`, { signal: AbortSignal.timeout(2500) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    sseText += dec.decode(value, { stream: true });
    if (sseText.length > 20000) break;
  }
} catch {
  /* стрим остаётся открытым — это нормально, читаем что успели */
}
const seqs = [...sseText.matchAll(/"seq":(\d+)/g)].map((m) => Number(m[1]));
check("события пронумерованы без дублей", seqs.length > 3 && new Set(seqs).size === seqs.length, `событий: ${seqs.length}`);
check("seq возрастает", seqs.every((v, i) => i === 0 || v > seqs[i - 1]));

/* ---------- 7. битая модель ---------- */
const state = (await api("/api/state")).data;
if (state.mode === "mock") {
  check("битая модель (в mock не проверяется — модели не вызываются)", true, "пропущено");
} else {
  const broken = JSON.parse(JSON.stringify(state.agents));
  broken.agents[0].model = "nope/nope-model";
  await api("/api/config", { method: "POST", body: JSON.stringify({ agents: broken, pipeline: state.pipeline }) });
  const { data: d8 } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: "Прогон с несуществующей моделью оркестратора" }) });
  const bad = await waitFor(d8.run.id, (r) => r.status === "failed", 60_000, "падение с битой моделью").catch(() => null);
  check("битая модель даёт failed с текстом ошибки", Boolean(bad?.error), bad?.error?.slice(0, 110) ?? "не упал вовсе");
  await api("/api/config", { method: "POST", body: JSON.stringify({ agents: state.agents, pipeline: state.pipeline }) });
}

/* ---------- итог ---------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} проверок прошло`);
if (failed.length) {
  console.log("провалились: " + failed.map((f) => f.name).join("; "));
  process.exitCode = 1;
}
