/** Доработка готового прогона: base + изменение. Печатает тайминги и результат. */
const BASE = process.env.BASE || "http://127.0.0.1:7777";
const baseId = process.argv[2];
const change = process.argv[3] ?? "добавь кнопку «=», чтобы результат считался по нажатию";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  for (let i = 0; i < 4; i++) {
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
      if (i === 3) throw err;
      await sleep(1000);
    }
  }
}

const t0 = Date.now();
const stamp = () => String(Math.round((Date.now() - t0) / 1000)).padStart(4) + "s";

const { run: baseRun } = await api(`/api/runs/${baseId}`);
console.log(`[${stamp()}] база: ${baseId} · «${baseRun.plan?.title ?? baseRun.task}»`);
console.log(`[${stamp()}] изменение: ${change}\n`);

const { run } = await api("/api/runs", {
  method: "POST",
  body: JSON.stringify({ task: baseRun.task, baseRunId: baseId, change }),
});
const id = run.id;
console.log(`[${stamp()}] доработка ${id} · файлов из базы: ${run.artifacts.filter((a) => a.path.startsWith("work/")).length}\n`);

let last = "";
for (;;) {
  const { run: r } = await api(`/api/runs/${id}`);
  const key = `${r.stageIndex}|${r.status}|${r.blocks.map((b) => b.status).join(",")}`;
  if (key !== last) {
    last = key;
    console.log(`[${stamp()}] стадия ${r.stageIndex} · ${r.status} · ${r.blocks.map((b) => b.id + ":" + b.status).join(" ")} · $${r.usage.cost.toFixed(4)}`);
  }

  if (r.status === "failed") {
    console.log(`\n[${stamp()}] ПРОВАЛ: ${r.error}`);
    break;
  }
  if (r.status === "done") {
    console.log(`\n[${stamp()}] ГОТОВО · вызовов ${r.usage.calls} · $${r.usage.cost.toFixed(4)}`);
    for (const b of r.blocks) console.log(`  ${b.id} ${b.title}: ${b.status} · тест ${b.test?.verdict} · правок ${b.fixCount}`);
    console.log("\nфайлы:");
    for (const a of r.artifacts.filter((x) => x.path.startsWith("work/"))) console.log("  " + a.path);
    console.log("\nсводка:\n" + (r.summary ?? "").split("\n").slice(0, 16).map((l) => "  " + l).join("\n"));
    break;
  }
  if (r.status === "awaiting") {
    console.log(`\n[${stamp()}] ГЕЙТ: ${r.awaiting.title}`);
    if (r.awaiting.stageId === "plan" && r.plan) {
      for (const b of r.plan.blocks) console.log(`   ${b.id}. ${b.title} — ${b.goal}`);
    }
    console.log("  → принимаю автоматически\n");
    await api(`/api/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    continue;
  }
  await sleep(1500);
}

console.log(`\nитого: ${((Date.now() - t0) / 1000).toFixed(0)}с · прогон ${id}`);
