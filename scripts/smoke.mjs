/** End-to-end smoke test against a running portal (mock mode). */
const BASE = process.env.BASE || "http://127.0.0.1:7777";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${data.error ?? ""}`);
  return data;
};

async function waitFor(id, predicate, { timeout = 90_000, label = "" } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    const { run } = await api(`/api/runs/${id}`);
    last = run;
    if (predicate(run)) return run;
    await sleep(700);
  }
  throw new Error(`Таймаут ожидания ${label}: статус=${last?.status} стадия=${last?.stageIndex}`);
}

function check(cond, msg) {
  if (!cond) throw new Error("ПРОВАЛ: " + msg);
  console.log("  ok ·", msg);
}

(async () => {
  console.log("1) state");
  const st = await api("/api/state");
  console.log("   режим:", st.mode, "| агентов:", st.agents.agents.length, "| стадий:", st.pipeline.stages.length);
  check(st.agents.agents.length >= 5, "агенты загружены");
  check(st.pipeline.stages.some((s) => s.gate), "в пайплайне есть гейты");

  console.log("2) запуск прогона");
  const { run } = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ task: "Сделать локальную страницу-счётчик: одна кнопка, число, тёмная тема." }),
  });
  const id = run.id;
  console.log("   id:", id);

  console.log("3) ждём гейт декомпозиции");
  let r = await waitFor(id, (x) => x.status === "awaiting" && x.awaiting?.stageId === "plan");
  check(r.blocks.length === 3, `блоков в плане: ${r.blocks.length}`);
  check(r.artifacts.some((a) => a.path === "plan.md"), "артефакт plan.md создан");

  console.log("4) отклоняем план с замечанием");
  r = await api(`/api/runs/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ decision: "reject", comment: "Добавь блок про сохранение состояния" }),
  }).then((x) => x.run);
  check(r.status === "running" || r.status === "awaiting", "прогон вернулся в работу");
  r = await waitFor(id, (x) => x.status === "awaiting" && x.awaiting?.stageId === "plan", { label: "повторный гейт плана" });
  check(true, "план пересобран после замечания");

  console.log("5) принимаем план");
  r = await api(`/api/runs/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", comment: "" }),
  }).then((x) => x.run);
  check(true, "план принят");

  console.log("6) ждём гейт спек");
  r = await waitFor(id, (x) => x.status === "awaiting" && x.awaiting?.stageId === "spec");
  check(r.artifacts.filter((a) => a.path.endsWith("spec.md")).length === 3, "три спеки на диске");
  r = await api(`/api/runs/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ decision: "approve" }),
  }).then((x) => x.run);

  console.log("7) ждём финальный гейт (после кода, проверки и сводки)");
  r = await waitFor(id, (x) => x.status === "awaiting" && x.awaiting?.stageId === "report", { label: "гейт сводки", timeout: 120_000 });
  const paths = r.artifacts.map((a) => a.path);
  check(paths.some((p) => p.endsWith("test-1.md")), "отчёт теста первого круга есть");
  check(paths.some((p) => p.endsWith("fix-1.md")), "правки после дефектов есть");
  check(paths.some((p) => p.endsWith("test-2.md")), "повторный тест после правок есть");
  check(paths.some((p) => p.startsWith("work/")), "код записан в work/");
  check(r.blocks.every((b) => b.status === "verified"), "все блоки verified");

  console.log("8) принимаем сводку");
  r = await api(`/api/runs/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ decision: "approve" }),
  }).then((x) => x.run);
  r = await waitFor(id, (x) => ["done", "failed"].includes(x.status), { label: "завершение" });
  check(r.status === "done", `прогон завершён: ${r.status}`);
  check(r.usage.calls > 10, `вызовов модели: ${r.usage.calls}`);

  console.log("9) читаем артефакты");
  const summary = await api(`/api/runs/${id}/artifact?path=summary.md`);
  check(summary.content.includes("Сводка"), "summary.md читается");
  const code = await api(`/api/runs/${id}/artifact?path=work/src/b1/index.html`);
  check(code.content.includes("<button"), "код блока доступен по API");

  console.log("10) защита от выхода за пределы каталога");
  let blocked = false;
  try {
    await api(`/api/runs/${id}/artifact?path=../../../server.mjs`);
  } catch {
    blocked = true;
  }
  check(blocked, "path traversal заблокирован");

  console.log(`\nВСЁ ОК · прогон ${id} · $${r.usage.cost.toFixed(4)}\n`);
})().catch((err) => {
  console.error("\nОШИБКА:", err.message, "\n");
  process.exit(1);
});
