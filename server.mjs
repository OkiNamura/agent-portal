import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { loadEnv } from "./lib/env.mjs";
import { Store, safeRel } from "./lib/store.mjs";
import { Projects } from "./lib/projects.mjs";
import { Engine } from "./lib/engine.mjs";
import { isMock } from "./lib/llm.mjs";
import { listModels, chat } from "./lib/openrouter.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(ROOT);
if (process.argv.includes("--mock")) process.env.MOCK = "1";

const PORT = Number(process.env.PORT || 7777);
const PUBLIC = path.join(ROOT, "public");
const CONFIG_DIR = path.join(ROOT, "config");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function readConfig() {
  const agents = readJson(path.join(CONFIG_DIR, "agents.json"));
  const pipeline = readJson(path.join(CONFIG_DIR, "pipeline.json"));
  return { agents, pipeline };
}

let config = readConfig();
const store = new Store(ROOT);
const projects = new Projects(ROOT);
const bus = new EventEmitter();
bus.setMaxListeners(200);
const engine = new Engine({ store, config, bus });

/* ---------- recovery: runs left "running" by a restart ---------- */
for (const r of store.list()) {
  if (r.status === "running") {
    try {
      const run = store.load(r.id);
      run.status = "interrupted";
      run.error = "Прогон прерван перезапуском сервера. Можно продолжить.";
      store.save(run);
    } catch {
      /* ignore broken run */
    }
  }
}

/* ---------- проекты: старые прогоны раскладываем по задачам ---------- */
{
  const runs = store.list().map((r) => {
    try {
      return store.load(r.id);
    } catch {
      return null;
    }
  }).filter(Boolean);
  if (projects.migrate(runs)) {
    for (const run of runs) if (run.projectId) store.save(run);
  }
}

/* ---------------------------- helpers ---------------------------- */

const json = (res, code, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error("Тело запроса слишком большое"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Некорректный JSON в теле запроса"));
      }
    });
    req.on("error", reject);
  });

function snapshot(run) {
  return {
    id: run.id,
    task: run.task,
    change: run.change ?? null,
    baseId: run.baseId ?? null,
    projectId: run.projectId ?? null,
    hasMockup: Boolean(run.mockup),
    mockupAt: run.mockup?.at ?? null,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    stageIndex: run.stageIndex,
    awaiting: run.awaiting,
    plan: run.plan,
    blocks: (run.blocks ?? []).map((b) => ({
      id: b.id,
      title: b.title,
      goal: b.goal,
      status: b.status,
      acceptance: b.acceptance,
      deps: b.deps,
      test: b.test ? { verdict: b.test.verdict, summary: b.test.summary, defects: b.test.defects, round: b.test.round } : null,
      fixCount: b.fixes?.length ?? 0,
      files: (b.files ?? []).map((f) => f.path),
    })),
    usage: run.usage,
    error: run.error,
    summary: run.summary ?? null,
    artifacts: store.listArtifacts(run),
  };
}

function projectList() {
  return projects.list().map((p) => withRuns(p));
}

function buildStats() {
  let cost = 0,
    calls = 0,
    tokens = 0;
  const byStatus = {};
  const byModel = new Map();
  const byDay = new Map();
  const byProject = [];

  for (const p of projects.list()) {
    let pCost = 0,
      pRuns = 0,
      pDone = 0;
    for (const runId of p.runIds) {
      let r;
      try {
        r = store.load(runId);
      } catch {
        continue;
      }
      const c = r.usage?.cost ?? 0;
      pRuns++;
      pCost += c;
      cost += c;
      calls += r.usage?.calls ?? 0;
      tokens += (r.usage?.prompt ?? 0) + (r.usage?.completion ?? 0);
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (r.status === "done") pDone++;
      const day = (r.createdAt ?? "").slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + c);
      for (const e of r.events ?? []) {
        if (e.kind === "call_done" && e.model) {
          const m = byModel.get(e.model) ?? { model: e.model, calls: 0, cost: 0 };
          m.calls++;
          m.cost += e.usage?.cost ?? 0;
          byModel.set(e.model, m);
        }
      }
    }
    byProject.push({ id: p.id, name: p.name, runs: pRuns, done: pDone, cost: pCost });
  }

  return {
    cost,
    calls,
    tokens,
    byStatus,
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    byDay: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    projects: byProject.sort((a, b) => b.cost - a.cost),
    projectsCount: projects.list().length,
  };
}

function withRuns(project) {
  const runs = [];
  for (const id of project.runIds) {
    try {
      const r = store.load(id);
      runs.push({
        id: r.id,
        status: r.status,
        change: r.change ?? null,
        createdAt: r.createdAt,
        cost: r.usage?.cost ?? 0,
        blocks: (r.blocks ?? []).length,
        hasMockup: Boolean(r.mockup),
      });
    } catch {
      /* прогон мог быть удалён */
    }
  }
  runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { ...project, runs };
}

function serveFile(res, file, cacheSeconds = 0) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: "not found" });
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
  });
  res.end(body);
}

/** Ищет главную страницу собранного проекта: сначала index.html в корне, потом первый html. */
function findEntry(run) {
  const base = path.join(store.runDir(run.id), "artifacts", "work");
  if (!fs.existsSync(base)) return null;
  const htmls = [];
  const walk = (dir, prefix = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (/\.html?$/i.test(e.name)) htmls.push(rel);
    }
  };
  walk(base);
  if (!htmls.length) return null;
  return htmls.includes("index.html") ? "index.html" : htmls.sort((a, b) => a.length - b.length)[0];
}

/** /preview/<runId>/mockup — макет, /preview/<runId>/app/<path> — собранный проект. */
function servePreview(res, pathname) {
  const parts = pathname.split("/").filter(Boolean); // ["preview", runId, ...]
  const [, runId, kind, ...rest] = parts;
  if (!runId) return json(res, 404, { error: "not found" });
  let run;
  try {
    run = store.load(runId);
  } catch {
    return json(res, 404, { error: "run not found" });
  }
  const base = store.runDir(run.id);

  if (kind === "mockup") return serveFile(res, path.join(base, "artifacts", "mockup.html"));

  if (kind === "app") {
    if (!rest.length) {
      const entry = findEntry(run);
      if (!entry) return json(res, 404, { error: "в проекте нет html-файлов" });
      res.writeHead(302, { Location: `/preview/${run.id}/app/${entry}` });
      return res.end();
    }
    const rel = rest.join("/");
    let clean;
    try {
      clean = safeRel(rel);
    } catch {
      return json(res, 403, { error: "forbidden" });
    }
    const root = path.join(base, "artifacts", "work");
    const file = path.join(root, clean);
    if (!file.startsWith(root)) return json(res, 403, { error: "forbidden" });
    return serveFile(res, file);
  }

  return json(res, 404, { error: "not found" });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC)) return json(res, 403, { error: "forbidden" });
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return json(res, 404, { error: "not found" });
  const body = fs.readFileSync(full);
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

/* ----------------------------- routes ----------------------------- */

const server = http.createServer(async (req, res) => {
  let pathname = "/";
  let url;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
    pathname = url.pathname;
  } catch {
    return json(res, 400, { error: "bad request" });
  }

  try {
    if (pathname.startsWith("/preview/")) return servePreview(res, pathname);
    if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname);

    if (pathname === "/api/state" && req.method === "GET") {
      return json(res, 200, {
        mode: isMock() ? "mock" : "live",
        port: PORT,
        agents: config.agents,
        pipeline: config.pipeline,
        runs: store.list(),
        projects: projectList(),
      });
    }

    if (pathname === "/api/projects" && req.method === "GET") {
      return json(res, 200, { projects: projectList() });
    }

    if (pathname === "/api/projects" && req.method === "POST") {
      const body = await readBody(req);
      const task = String(body.task ?? "").trim();
      const name = String(body.name ?? "").trim() || task.slice(0, 80);
      if (!name) return json(res, 400, { error: "Нужно название или задача" });
      const project = projects.create({ name, task });
      return json(res, 201, { project: withRuns(project) });
    }

    if (pathname === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      const next = {
        agents: body.agents ?? config.agents,
        pipeline: body.pipeline ?? config.pipeline,
      };
      if (!Array.isArray(next.agents?.agents)) return json(res, 400, { error: "agents.agents должен быть массивом" });
      if (!Array.isArray(next.pipeline?.stages)) return json(res, 400, { error: "pipeline.stages должен быть массивом" });
      fs.writeFileSync(path.join(CONFIG_DIR, "agents.json"), JSON.stringify(next.agents, null, 2), "utf8");
      fs.writeFileSync(path.join(CONFIG_DIR, "pipeline.json"), JSON.stringify(next.pipeline, null, 2), "utf8");
      config = next;
      engine.config = next;
      return json(res, 200, { ok: true, agents: config.agents, pipeline: config.pipeline });
    }

    if (pathname === "/api/models" && req.method === "GET") {
      try {
        const models = await getModels();
        return json(res, 200, { models });
      } catch (err) {
        return json(res, 200, { models: [], error: String(err?.message || err) });
      }
    }

    if (pathname === "/api/runs" && req.method === "POST") {
      const body = await readBody(req);
      const base = body.baseRunId ? store.load(String(body.baseRunId)) : null;
      const task = String(body.task ?? base?.task ?? "").trim();
      const change = String(body.change ?? "").trim();
      if (task.length < 10) return json(res, 400, { error: "Задача слишком короткая — опиши, что нужно сделать (минимум 10 символов)" });
      if (change && change.length < 5) return json(res, 400, { error: "Слишком короткое изменение — опиши, что поменять (минимум 5 символов)" });

      let projectId = body.projectId ? String(body.projectId) : base?.projectId ?? null;
      if (projectId && !projects.get(projectId)) projectId = null;
      if (!projectId) projectId = projects.create({ name: task.slice(0, 80), task }).id;

      const run = store.create(task, { base, change, projectId });
      projects.attach(projectId, run.id);
      json(res, 201, { run: snapshot(run) });
      engine.start(run).catch((err) => console.error("[engine]", err));
      return;
    }

    const pm = pathname.match(/^\/api\/projects\/([\w.-]+)$/);
    if (pm && req.method === "GET") {
      const project = projects.get(pm[1]);
      if (!project) return json(res, 404, { error: "Проект не найден" });
      return json(res, 200, { project: withRuns(project) });
    }

    if (pm && req.method === "DELETE") {
      const project = projects.get(pm[1]);
      if (!project) return json(res, 404, { error: "Проект не найден" });
      const active = project.runIds.filter((id) => {
        try {
          return ["running", "awaiting", "awaiting_plan"].includes(store.load(id).status);
        } catch {
          return false;
        }
      });
      if (active.length) return json(res, 409, { error: `В проекте есть активные прогоны (${active.join(", ")}) — сначала останови их` });

      // 1. убираем проект из индекса — дальше он не должен всплывать даже если файлы не удалятся
      projects.items = projects.items.filter((p) => p.id !== project.id);
      projects.save();

      // 2. останавливаем прогоны, чтобы движок не пересоздал каталоги после удаления
      for (const id of project.runIds) {
        try {
          engine.cancel(store.load(id));
        } catch {
          /* нет такого */
        }
      }
      await new Promise((r) => setTimeout(r, 400));

      // 3. удаляем каталоги с ретраями (Windows любит EBUSY на только что закрытых файлах)
      const leftover = [];
      for (const id of project.runIds) {
        try {
          fs.rmSync(store.runDir(id), { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
          store.cache.delete(id);
        } catch {
          leftover.push(id);
        }
      }
      if (leftover.length) {
        // вторая попытка чуть позже — модель могла дописывать файл
        await new Promise((r) => setTimeout(r, 700));
        for (const id of leftover.slice()) {
          try {
            fs.rmSync(store.runDir(id), { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
            store.cache.delete(id);
            leftover.splice(leftover.indexOf(id), 1);
          } catch {
            /* осталось — вернём в ответе */
          }
        }
      }
      return json(res, 200, { ok: true, deletedRuns: project.runIds.length - leftover.length, leftover });
    }

    if (pathname === "/api/maintenance/cleanup" && req.method === "POST") {
      const known = new Set(projects.list().flatMap((p) => p.runIds));
      const removed = [];
      for (const name of fs.readdirSync(store.runsDir)) {
        const dir = path.join(store.runsDir, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        const hasState = fs.existsSync(path.join(dir, "state.json"));
        if (known.has(name) && hasState) continue;
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
          store.cache.delete(name);
          removed.push(name);
        } catch {
          /* занято — попробуем в следующий раз */
        }
      }
      return json(res, 200, { ok: true, removed, freed: removed.length });
    }

    const am = pathname.match(/^\/api\/agents\/([\w.-]+)$/);
    if (am && req.method === "DELETE") {
      const id = am[1];
      const used = (config.pipeline.stages ?? []).filter((s) => s.agent === id).map((s) => s.title);
      if (used.length) return json(res, 409, { error: `Агент занят стадиями: ${used.join(", ")}` });
      const list = config.agents.agents ?? [];
      if (!list.some((a) => a.id === id)) return json(res, 404, { error: "Агент не найден" });
      const next = { ...config.agents, agents: list.filter((a) => a.id !== id) };
      fs.writeFileSync(path.join(CONFIG_DIR, "agents.json"), JSON.stringify(next, null, 2), "utf8");
      config = { ...config, agents: next };
      engine.config = config;
      return json(res, 200, { ok: true, agents: next });
    }

    if (pathname === "/api/tasks" && req.method === "GET") {
      const tasks = [];
      for (const p of projects.list()) {
        for (const id of p.runIds) {
          let r;
          try {
            r = store.load(id);
          } catch {
            continue;
          }
          if (!["running", "awaiting", "awaiting_plan", "interrupted"].includes(r.status)) continue;
          const stage = config.pipeline.stages[r.stageIndex];
          tasks.push({
            runId: r.id,
            projectId: p.id,
            project: p.name,
            status: r.status,
            stage: stage?.title ?? "—",
            awaiting: r.awaiting?.title ?? null,
            change: r.change,
            updatedAt: r.updatedAt,
          });
        }
      }
      tasks.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return json(res, 200, { tasks });
    }

    if (pathname === "/api/logs" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 120), 500);
      const lines = [];
      for (const p of projects.list()) {
        for (const id of p.runIds) {
          const file = path.join(store.runDir(id), "events.jsonl");
          if (!fs.existsSync(file)) continue;
          const text = fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
          for (const line of text.slice(-40)) {
            try {
              const e = JSON.parse(line);
              lines.push({ ...e, runId: id, project: p.name });
            } catch {
              /* битая строка */
            }
          }
        }
      }
      lines.sort((a, b) => (a.at < b.at ? 1 : -1));
      return json(res, 200, { logs: lines.slice(0, limit) });
    }

    if (pathname === "/api/stats" && req.method === "GET") {
      return json(res, 200, { stats: buildStats() });
    }

    if (pathname === "/api/assistant" && req.method === "POST") {
      const body = await readBody(req);
      const question = String(body.question ?? "").trim();
      if (!question) return json(res, 400, { error: "Пустой вопрос" });
      const answer = await assistantAnswer(question, Array.isArray(body.history) ? body.history : []);
      return json(res, 200, answer);
    }

    const m = pathname.match(/^\/api\/runs\/([\w.-]+)(?:\/(events|approve|cancel|resume|artifact|plan))?$/);
    if (m) {
      const [, id, action] = m;
      const run = store.load(id);

      if (!action && req.method === "GET") return json(res, 200, { run: snapshot(run) });

      if (action === "events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ runId: id, status: run.status })}\n\n`);
        for (const entry of run.events.slice(-400)) {
          res.write(`data: ${JSON.stringify(entry)}\n\n`);
        }
        const onEvent = (payload) => {
          if (payload.runId !== id) return;
          res.write(`data: ${JSON.stringify(payload.entry)}\n\n`);
        };
        const onState = (payload) => {
          if (payload.runId !== id) return;
          res.write(`event: state\ndata: ${JSON.stringify(snapshot(payload.run))}\n\n`);
        };
        bus.on("event", onEvent);
        bus.on("state", onState);
        const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
        req.on("close", () => {
          clearInterval(ping);
          bus.off("event", onEvent);
          bus.off("state", onState);
        });
        return;
      }

      if (action === "approve" && req.method === "POST") {
        const body = await readBody(req);
        const updated = engine.approve(run, { decision: body.decision, comment: body.comment ?? "" });
        bus.emit("state", { runId: id, run: updated });
        return json(res, 200, { run: snapshot(updated) });
      }

      if (action === "plan" && req.method === "POST") {
        const body = await readBody(req);
        const updated = engine.applyManualPlan(run, body);
        bus.emit("state", { runId: id, run: updated });
        return json(res, 200, { run: snapshot(updated) });
      }

      if (action === "cancel" && req.method === "POST") {
        engine.cancel(run);
        bus.emit("state", { runId: id, run });
        return json(res, 200, { run: snapshot(run) });
      }

      if (action === "resume" && req.method === "POST") {
        json(res, 202, { run: snapshot(run) });
        engine.resume(run).catch((err) => console.error("[engine]", err));
        return;
      }

      if (action === "artifact" && req.method === "GET") {
        const rel = url.searchParams.get("path") ?? "";
        return json(res, 200, { path: rel, content: store.readArtifact(run, rel) });
      }
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    const message = String(err?.message || err);
    console.error("[http]", message);
    return json(res, 400, { error: message });
  }
});

/* --------------------------- ассистент портала --------------------------- */

function assistantContext() {
  const stats = buildStats();
  const lines = [
    `Всего: проектов ${stats.projectsCount}, прогонов ${Object.values(stats.byStatus).reduce((a, b) => a + b, 0)}, потрачено $${stats.cost.toFixed(4)}, вызовов модели ${stats.calls}.`,
  ];

  for (const p of projects.list()) {
    const runs = [];
    for (const id of p.runIds) {
      try {
        runs.push(store.load(id));
      } catch {
        /* нет прогона */
      }
    }
    if (!runs.length) continue;
    runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const last = runs[0];
    const stage = config.pipeline.stages[last.stageIndex]?.title ?? "—";
    lines.push(
      `ПРОЕКТ «${p.name}»: версий ${runs.length}, последняя ${last.id} — ${last.status}, стадия «${stage}», $${(last.usage?.cost ?? 0).toFixed(4)}` +
        (last.change ? `, доработка: ${last.change}` : "")
    );
    const blocks = (last.blocks ?? []).map((b) => `${b.id}:${b.status}${b.test?.verdict ? "(" + b.test.verdict + ")" : ""}`).join(" ");
    if (blocks) lines.push(`  блоки: ${blocks}`);
    if (last.awaiting) lines.push(`  ждёт подтверждения: «${last.awaiting.title}»`);
    if (last.error) lines.push(`  ошибка: ${last.error}`);
    if (last.summary) lines.push(`  сводка: ${last.summary.replace(/\s+/g, " ").slice(0, 400)}`);
  }

  const errors = [];
  for (const p of projects.list()) {
    for (const id of p.runIds) {
      try {
        const r = store.load(id);
        if (r.error) errors.push(`${p.name}/${r.id}: ${r.error}`);
      } catch {
        /* нет */
      }
    }
  }
  if (errors.length) lines.push(`Ошибки за всё время: ${errors.slice(0, 5).join(" | ")}`);

  return lines.join("\n").slice(0, 7000);
}

async function assistantAnswer(question, history) {
  const ctx = assistantContext();
  if (isMock()) {
    return { answer: `MOCK-режим: модель не вызывается, показываю данные портала.\n\n${ctx.slice(0, 1600)}`, model: "mock/assistant", cost: 0 };
  }
  const agent = (config.agents.agents ?? []).find((a) => a.id === "assistant") ?? {
    model: "deepseek/deepseek-v3.2",
    temperature: 0.2,
    prompt: "Ты — ассистент портала. Отвечай по данным, которые дали. Не выдумывай.",
  };
  const hist = (history ?? [])
    .filter((m) => m && m.text && m.role !== "error")
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Заказчик" : "Ассистент"}: ${m.text}`)
    .join("\n");

  const res = await chat({
    model: agent.model,
    temperature: Number(agent.temperature ?? 0.2),
    maxTokens: 1200,
    system: agent.prompt,
    user: `Данные портала (единственный источник правды, не выдумывай фактов вне их):\n${ctx}\n\n${hist ? `Диалог до этого:\n${hist}\n\n` : ""}Вопрос заказчика: ${question}`,
  });
  return { answer: res.text.trim(), model: res.model, cost: res.usage.cost };
}

/* --------------------------- models cache --------------------------- */

let modelsCache = { at: 0, models: [] };
async function getModels() {
  if (isMock()) return [];
  const fresh = Date.now() - modelsCache.at < 3600_000;
  if (fresh && modelsCache.models.length) return modelsCache.models;
  const models = await listModels();
  modelsCache = { at: Date.now(), models };
  return models;
}

/* ----------------------------- broadcast ----------------------------- */

const broadcast = setInterval(() => {
  for (const r of store.list()) {
    if (["running", "awaiting"].includes(r.status)) {
      try {
        bus.emit("state", { runId: r.id, run: store.load(r.id) });
      } catch {
        /* ignore */
      }
    }
  }
}, 2000);
broadcast.unref?.();

server.listen(PORT, "127.0.0.1", () => {
  const mode = isMock() ? "MOCK (без ключа, без трат)" : "LIVE (OpenRouter)";
  console.log(`\n  Agent Portal  ·  http://127.0.0.1:${PORT}`);
  console.log(`  Режим: ${mode}`);
  console.log(`  Конфиг: config/agents.json, config/pipeline.json`);
  console.log(`  Прогоны: runs/\n`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\nОстановка сервера…");
    server.close(() => process.exit(0));
  });
}

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", String(err?.message || err));
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", String(err?.message || err));
});
