/** Real end-to-end run in LIVE mode: auto-approves gates, prints everything. */
const BASE = process.env.BASE || "http://127.0.0.1:7777";
const TASK = process.argv[2] ?? "Сделать простой калькулятор: одна страница, два числа, операции + − × ÷, история вычислений, тёмная тема. Локально, без сервера.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, opts = {}) => {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(20_000),
        ...opts,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${path} -> ${res.status}: ${data.error ?? ""}`);
      return data;
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
};

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(3) + "s";

const { run } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task: TASK }) });
const id = run.id;
console.log(`[${stamp()}] прогон ${id}\n[${stamp()}] задача: ${TASK}\n`);

let seen = 0;
let lastBlockKey = "";

for (;;) {
  const { run: r } = await api(`/api/runs/${id}`);

  const { events } = await api(`/api/runs/${id}`).catch(() => ({ events: [] }));
  void events;

  const key = `${r.blocks.map((b) => b.status).join(",")}|${r.stageIndex}|${r.status}`;
  if (key !== lastBlockKey) {
    lastBlockKey = key;
    const blocks = r.blocks.map((b) => `${b.id}:${b.status}`).join(" ");
    console.log(`[${stamp()}] стадия ${r.stageIndex} · ${r.status} · ${blocks} · $${r.usage.cost.toFixed(4)}`);
  }
  seen += 1;

  if (r.status === "failed" || r.status === "cancelled") {
    console.log(`\n[${stamp()}] ПРОВАЛ: ${r.error ?? r.status}`);
    const ev = await api(`/api/runs/${id}/events`).catch(() => null);
    void ev;
    break;
  }

  if (r.status === "awaiting") {
    const s = r.awaiting;
    console.log(`\n[${stamp()}] ГЕЙТ: ${s.title}`);
    if (s.stageId === "plan") {
      console.log(`  план: ${r.plan.title}`);
      for (const b of r.plan.blocks) console.log(`   ${b.id}. ${b.title} — ${b.goal}`);
    }
    if (s.stageId === "spec") {
      const spec = await api(`/api/runs/${id}/artifact?path=blocks/b1/spec.md`).catch(() => null);
      if (spec) console.log("  спека b1 (первые строки):\n" + spec.content.split("\n").slice(0, 14).map((l) => "   " + l).join("\n"));
    }
    console.log(`  → принимаю автоматически\n`);
    await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    await sleep(400);
    continue;
  }

  if (r.status === "done") {
    console.log(`\n[${stamp()}] ГОТОВО · вызовов ${r.usage.calls} · токенов ${r.usage.prompt + r.usage.completion} · $${r.usage.cost.toFixed(4)}`);
    console.log("\nБлоки:");
    for (const b of r.blocks) {
      console.log(`  ${b.id} ${b.title}: ${b.status} · тест ${b.test?.verdict ?? "—"} · дефектов ${b.test?.defects?.length ?? 0} · правок ${b.fixCount}`);
    }
    console.log("\nФайлы кода:");
    for (const a of r.artifacts.filter((x) => x.path.startsWith("work/"))) console.log("  " + a.path);
    console.log("\nСводка:\n" + (r.summary ?? "(нет)").split("\n").slice(0, 30).map((l) => "  " + l).join("\n"));
    break;
  }

  await sleep(1500);
}

console.log(`\nвсего времени: ${((Date.now() - t0) / 1000).toFixed(0)}с`);
