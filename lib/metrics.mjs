/**
 * Метрики по агентам: считаются из журналов прогонов (events).
 * Никакого хранения отдельно — источник правды это события.
 */

export function agentMetrics(runs) {
  const map = new Map();

  const get = (id, model) => {
    let s = map.get(id);
    if (!s) {
      s = {
        id,
        model: model ?? null,
        attempts: 0,
        ok: 0,
        failed: 0,
        cost: 0,
        tokens: 0,
        msTotal: 0,
        msCount: 0,
        fixes: 0,
        verdicts: { pass: 0, fail: 0 },
        runs: new Set(),
      };
      map.set(id, s);
    }
    if (model) s.model = model;
    return s;
  };

  for (const run of runs) {
    const open = new Map();
    for (const e of run.events ?? []) {
      const at = Date.parse(e.at) || 0;

      if (e.kind === "call") {
        open.set(e.agent, { at, kind: e.callKind });
        const s = get(e.agent, e.model);
        s.attempts++;
        s.runs.add(run.id);
        continue;
      }

      if (e.kind === "call_done") {
        const s = get(e.agent, e.model);
        const started = open.get(e.agent);
        s.ok++;
        s.cost += e.usage?.cost ?? 0;
        s.tokens += (e.usage?.prompt ?? 0) + (e.usage?.completion ?? 0);
        const ms = Number.isFinite(e.ms) ? e.ms : started ? at - started.at : null;
        if (ms != null && ms >= 0) {
          s.msTotal += ms;
          s.msCount++;
        }
        const kind = e.callKind ?? started?.kind;
        if (kind === "fix") s.fixes++;
        open.delete(e.agent);
        continue;
      }

      if (e.kind === "call_failed") {
        const s = get(e.agent, e.model);
        s.failed++;
        open.delete(e.agent);
        continue;
      }

      if (e.kind === "verdict") {
        const s = get(e.agent);
        if (e.verdict === "pass") s.verdicts.pass++;
        else s.verdicts.fail++;
      }
    }
  }

  return [...map.values()]
    .map((s) => ({
      id: s.id,
      model: s.model,
      attempts: s.attempts,
      ok: s.ok,
      failed: s.failed,
      cost: s.cost,
      tokens: s.tokens,
      avgMs: s.msCount ? Math.round(s.msTotal / s.msCount) : null,
      fixes: s.fixes,
      verdicts: s.verdicts,
      failRate: s.attempts ? s.failed / s.attempts : 0,
      runs: s.runs.size,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/** Сводка по вердиктам тестировщика: сколько проверок пройдено с первого раза. */
export function verdictSummary(runs) {
  let total = 0;
  let pass = 0;
  let fail = 0;
  let blocksVerified = 0;
  let blocksFailed = 0;

  for (const run of runs) {
    for (const e of run.events ?? []) {
      if (e.kind !== "verdict") continue;
      total++;
      if (e.verdict === "pass") pass++;
      else fail++;
    }
    for (const b of run.blocks ?? []) {
      if (b.status === "verified") blocksVerified++;
      else if (b.status === "failed") blocksFailed++;
    }
  }

  return { total, pass, fail, blocksVerified, blocksFailed, passRate: total ? pass / total : 0 };
}
