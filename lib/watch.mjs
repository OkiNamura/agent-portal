/** Фоновый наблюдатель: ищет проблемы по данным портала и формулирует их по-человечески. */

const MIN = 60_000;

export function collectAlerts({ runs, metrics, harness, projects, stages }) {
  const out = [];
  const th = harness?.thresholds ?? {};
  const slowMs = Number(th.slowCallMs ?? 60_000);
  const stuckMin = Number(th.stuckMinutes ?? 15);
  const budget = Number(th.dailyBudget ?? 2);
  const now = Date.now();

  for (const a of metrics?.agents ?? []) {
    if (a.failed > 0) {
      out.push({
        level: "bad",
        text: `Агент «${a.id}» ошибается: ${a.failed} из ${a.attempts} вызовов. Стоит сменить модель или промт.`,
      });
    }
    if (a.avgMs && a.avgMs > slowMs && a.attempts >= 2) {
      out.push({
        level: "warn",
        text: `Агент «${a.id}» думает в среднем ${(a.avgMs / 1000).toFixed(0)} с — медленнее порога ${(slowMs / 1000).toFixed(0)} с.`,
      });
    }
    if (a.verdicts && a.verdicts.fail > a.verdicts.pass && a.verdicts.fail >= 2) {
      out.push({
        level: "warn",
        text: `Проверки у «${a.id}»: провалов ${a.verdicts.fail}, успехов ${a.verdicts.pass}. Либо критерии слишком строгие, либо код слабый.`,
      });
    }
  }

  for (const run of runs ?? []) {
    const project = projects?.find((p) => p.runIds?.includes(run.id));
    const name = project?.name ?? run.id;
    const age = now - new Date(run.updatedAt ?? run.createdAt ?? now).getTime();
    const stage = stages?.[run.stageIndex]?.title ?? "—";

    if (["running", "awaiting", "awaiting_plan"].includes(run.status) && age > stuckMin * MIN) {
      out.push({
        level: "warn",
        text: `«${name}» стоит ${Math.round(age / MIN)} мин на стадии «${stage}» (${run.status}) — похоже, зависло.`,
        runId: run.id,
        projectId: project?.id,
      });
    }

    const failedBlocks = (run.blocks ?? []).filter((b) => b.status === "failed");
    if (failedBlocks.length && run.status !== "running") {
      out.push({
        level: "warn",
        text: `«${name}»: блоки не прошли проверку — ${failedBlocks.map((b) => b.id).join(", ")}.`,
        runId: run.id,
        projectId: project?.id,
      });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const spentToday = (runs ?? [])
    .filter((r) => (r.createdAt ?? "").startsWith(today))
    .reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0);
  if (spentToday > budget) {
    out.push({ level: "bad", text: `Сегодня потрачено $${spentToday.toFixed(2)} — больше лимита $${budget}.` });
  }

  const order = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
