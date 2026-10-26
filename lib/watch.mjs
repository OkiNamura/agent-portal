/** Фоновый наблюдатель: ищет проблемы по данным портала и формулирует их по-человечески. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN = 60_000;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const WATCH_STATE_FILE = "watch.state.json";
export const WATCH_DEFAULTS = Object.freeze({ running: false, everyMin: 10, lastRunAt: null });

/**
 * Каталог запусков: его передаёт сервер (store.runsDir), но можно положиться
 * на RUNS_DIR — так функция работает и без сервера, в проверках.
 */
function runsDirFrom(input) {
  if (typeof input === "string" && input.trim()) return path.resolve(input);
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const dir = input.runsDir ?? input.dir ?? input.stateDir;
    if (dir) return path.resolve(dir);
  }
  return process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.join(ROOT, "runs");
}

/** Путь к watch.state.json: { runsDir } | { dir } | строка-каталог | { file }. */
export function watchStatePath(options = {}) {
  if (options && typeof options === "object" && options.file) return path.resolve(options.file);
  return path.join(runsDirFrom(options), WATCH_STATE_FILE);
}

/** Привести состояние к известной форме: мусор из файла не должен ломать сервер. */
export function normalizeWatchState(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const everyRaw = Number(source.everyMin);
  const everyMin = Number.isFinite(everyRaw) ? Math.min(1440, Math.max(1, Math.floor(everyRaw))) : WATCH_DEFAULTS.everyMin;
  return {
    running: source.running === true,
    everyMin,
    lastRunAt: typeof source.lastRunAt === "string" && source.lastRunAt.trim() ? source.lastRunAt : null,
  };
}

export function loadWatchState(options = {}) {
  const file = watchStatePath(options);
  try {
    if (!fs.existsSync(file)) return { ...WATCH_DEFAULTS };
    return normalizeWatchState(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
  } catch {
    // битый/недочитанный файл не должен мешать старту портала
    return { ...WATCH_DEFAULTS };
  }
}

/** Сохранить состояние дежурного атомарно: running, everyMin, lastRunAt. */
export function saveWatchState(state = {}, options = {}) {
  const file = watchStatePath(options);
  const data = normalizeWatchState(state);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // диск/права — не повод валить дежурного; в памяти состояние всё равно есть
  }
  return data;
}

/**
 * Вызывается сервером при старте: возвращает сохранённое состояние дежурного.
 * Таймер не запускает — это делает server.mjs, чтобы не плодить интервалы.
 */
export function resumeWatch(options = {}) {
  return loadWatchState(options);
}

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

    // «зависло» — только если реально идёт работа; ожидание гейта это норма, а не проблема
    if (run.status === "running" && age > stuckMin * MIN) {
      out.push({
        level: "warn",
        text: `«${name}» стоит ${Math.round(age / MIN)} мин на стадии «${stage}» — похоже, зависло.`,
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
