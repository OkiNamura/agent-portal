import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { loadEnv } from "./lib/env.mjs";
import { Store, safeRel } from "./lib/store.mjs";
import { Projects } from "./lib/projects.mjs";
import { Engine } from "./lib/engine.mjs";
import { isMock, extractJson } from "./lib/llm.mjs";
import { listModels, chat } from "./lib/openrouter.mjs";
import { diffWorkspaces } from "./lib/diff.mjs";
import { agentMetrics, verdictSummary } from "./lib/metrics.mjs";
import { Mailbox } from "./lib/mailbox.mjs";
import { collectAlerts } from "./lib/watch.mjs";
import { Studio, generateImage, listImageModels } from "./lib/studio.mjs";
import { Keys, PRESETS } from "./lib/keys.mjs";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  loadUsers,
  verify,
  createSession,
  getSession,
  dropSession,
  requireUser,
  deny,
  listUsers,
  createUser,
  setUserPassword,
  setUserRole,
  removeUser,
} from "./lib/auth.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(ROOT);
if (process.argv.includes("--mock")) process.env.MOCK = "1";

const PORT = Number(process.env.PORT || 7777);
const PUBLIC = path.join(ROOT, "public");
const CONFIG_DIR = path.join(ROOT, "config");

/* Пользователи и сессии. Первый запуск создаёт админа и печатает его пароль один раз. */
try {
  loadUsers();
} catch (err) {
  console.error(`[auth] не удалось прочитать ${path.join(CONFIG_DIR, "users.json")}: ${String(err?.message || err)}`);
  process.exit(1);
}

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

/* ориентировочные цены за картинку — для подсказок в интерфейсе */
const IMAGE_PRICES = {
  "google/gemini-3.1-flash-image": 0.067,
  "google/gemini-3.1-flash-lite-image": 0.02,
  "google/gemini-3-pro-image": 0.12,
  "openai/gpt-image-2": 0.13,
  "openai/gpt-image-1-mini": 0.04,
  "black-forest-labs/flux-3-image": 0.05,
  "black-forest-labs/flux-3-image-klein": 0.02,
  "bytedance-seed/seedream-5-0-flash": 0.02,
  "bytedance-seed/seedream-5-0-pro": 0.06,
  "qwen/qwen-image-2.1-turbo": 0.01,
  "qwen/qwen-image-3": 0.03,
  "microsoft/mai-image-2.6": 0.04,
};

/* пресеты моделей: одна кнопка меняет модели у всех LLM-агентов */
const PRESET_MODELS = {
  price: {
    orchestrator: "qwen/qwen3.7-flash",
    architect: "qwen/qwen3.7-flash",
    analyst: "qwen/qwen3.7-flash",
    coder: "deepseek/deepseek-chat",
    tester: "qwen/qwen3.7-flash",
    critic: "google/gemini-2.5-flash-lite",
    artist: "qwen/qwen3.7-flash",
    assistant: "qwen/qwen3.7-flash",
    mockup: "qwen/qwen3.7-flash",
    scribe: "qwen/qwen3.7-flash",
    reviewer: "qwen/qwen3.7-flash",
  },
  speed: {
    orchestrator: "google/gemini-2.5-flash-lite",
    architect: "google/gemini-2.5-flash-lite",
    analyst: "google/gemini-2.5-flash-lite",
    coder: "deepseek/deepseek-v3.2",
    tester: "google/gemini-2.5-flash-lite",
    critic: "google/gemini-2.5-flash-lite",
    artist: "google/gemini-2.5-flash-lite",
    assistant: "google/gemini-2.5-flash-lite",
    mockup: "google/gemini-2.5-flash-lite",
    scribe: "google/gemini-2.5-flash-lite",
    reviewer: "google/gemini-2.5-flash-lite",
  },
  quality: {
    orchestrator: "deepseek/deepseek-v3.2",
    architect: "deepseek/deepseek-v3.2",
    analyst: "deepseek/deepseek-v3.2",
    coder: "deepseek/deepseek-v3.2",
    tester: "deepseek/deepseek-v3.2",
    critic: "deepseek/deepseek-v3.2",
    artist: "deepseek/deepseek-v3.2",
    assistant: "deepseek/deepseek-v3.2",
    mockup: "anthropic/claude-haiku-5.5",
    scribe: "deepseek/deepseek-v3.2",
    reviewer: "deepseek/deepseek-v3.2",
  },
};
const store = new Store(ROOT);
const projects = new Projects(ROOT);
const bus = new EventEmitter();
bus.setMaxListeners(200);
const keys = new Keys(ROOT);
const engine = new Engine({ store, config, bus, keys });
engine.spendProvider = keySpendFromLogs;

/** Ключ из настроек должен включать LIVE, даже если в .env его нет. */
function syncKeyToEnv() {
  const k = keys.resolve(null);
  if (k?.key) process.env.OPENROUTER_API_KEY = k.key;
}
syncKeyToEnv();

const mailbox = new Mailbox(ROOT);
const studio = new Studio(ROOT);
let harness = readJson(path.join(CONFIG_DIR, "harness.json"));

/* ---------- что будит Харнесса: события портала → почтовый ящик ---------- */
bus.on("event", ({ runId, entry }) => {
  const t = harness.triggers ?? {};
  const project = projects.byRun(runId);
  const name = project?.name ?? runId;
  const push = (text, kind, level) => mailbox.add({ from: "system", text, kind, level, runId, projectId: project?.id ?? null });

  if (entry.kind === "gate" && t.gateAwaiting) push(`«${name}»: ждёт подтверждения — ${String(entry.message).replace(/^Нужно подтверждение: /, "")}`, "gate", "warn");
  if (entry.kind === "error" && t.agentError) push(`«${name}»: ошибка прогона — ${entry.message}`, "error", "bad");
  if (entry.kind === "call_failed" && t.agentError) push(`«${name}»: агент ${entry.agent} не ответил (${entry.callKind})`, "error", "bad");
  if (entry.kind === "done" && t.runFinished) push(`«${name}»: прогон завершён`, "done", "info");
  if (entry.kind === "stage_done" && t.stageDone) push(`«${name}»: ${String(entry.message).toLowerCase()}`, "stage", "info");
  if (entry.kind === "call_done" && t.slowCall && Number(entry.ms) > Number(harness.thresholds?.slowCallMs ?? 60_000)) {
    push(`«${name}»: ${entry.agent} думал ${(Number(entry.ms) / 1000).toFixed(0)} с — это долго`, "slow", "warn");
  }
});

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

/** Cookie сессии: httpOnly + SameSite=Strict, 12 часов (Max-Age 43200). */
function sessionCookie(token, maxAge = SESSION_MAX_AGE) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

const readBody = (req, limit = 2_000_000) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
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

function allRuns() {
  const out = [];
  for (const p of projects.list()) {
    for (const id of p.runIds) {
      try {
        out.push(store.load(id));
      } catch {
        /* прогон удалён */
      }
    }
  }
  return out;
}

/** Сколько потратил конкретный ключ за сегодня — считаем по журналам, а не по памяти. */
let keySpendCache = { at: 0, byKey: {} };
function keySpendFromLogs(keyId) {
  if (Date.now() - keySpendCache.at > 15_000) {
    const day = new Date().toISOString().slice(0, 10);
    const byKey = {};
    for (const r of allRuns()) {
      for (const e of r.events ?? []) {
        if (e.kind !== "call_done" || !e.keyId) continue;
        if (!String(e.at ?? "").startsWith(day)) continue;
        byKey[e.keyId] = (byKey[e.keyId] ?? 0) + (e.usage?.cost ?? 0);
      }
    }
    // картинки и документы студии тоже считаются — они самая дорогая часть
    for (const img of studio.items ?? []) {
      if (!img.keyId) continue;
      if (!String(img.at ?? "").startsWith(day)) continue;
      byKey[img.keyId] = (byKey[img.keyId] ?? 0) + (img.cost ?? 0);
    }
    keySpendCache = { at: Date.now(), byKey };
  }
  return keySpendCache.byKey[keyId] ?? 0;
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
    if (pathname.startsWith("/studio/")) {
      const file = pathname.slice("/studio/".length);
      const item = studio.items.find((i) => i.file === file);
      if (!item) return json(res, 404, { error: "not found" });
      return serveFile(res, studio.filePath(item), 3600);
    }
    if (pathname.startsWith("/preview/")) return servePreview(res, pathname);
    if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname);

    /* ------------------------------ авторизация ------------------------------ */

    const method = req.method ?? "GET";

    // публичные маршруты входа/выхода
    if (pathname === "/api/login") {
      if (method === "GET") return json(res, 200, { ok: true, login: "/api/login (POST)" });
      if (method === "POST") {
        const body = await readBody(req);
        const user = verify(body.login, body.password);
        if (!user) return json(res, 401, { error: "неверный логин или пароль" });
        const token = createSession(user.id);
        res.setHeader("Set-Cookie", sessionCookie(token));
        return json(res, 200, { ok: true, user: { login: user.login, role: user.role } });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (pathname === "/api/logout" && method === "POST") {
      const token = url.searchParams.get("token");
      const session = requireUser(req) ?? (token ? getSession(token) : null);
      if (session) dropSession(session.token);
      res.setHeader("Set-Cookie", sessionCookie("", 0));
      return json(res, 200, { ok: true });
    }

    // всё остальное /api/* требует сессию; для SSE токен можно передать в ?token=
    const isEvents = /^\/api\/runs\/[\w.-]+\/events$/.test(pathname);
    const queryToken = isEvents && method === "GET" ? url.searchParams.get("token") : null;
    const user = requireUser(req) ?? (queryToken ? getSession(queryToken) : null);
    if (!user) return json(res, 401, { error: "нужен вход" });

    if (pathname === "/api/me" && method === "GET") {
      return json(res, 200, { login: user.login, role: user.role });
    }

    if (deny(res, user.role, method, pathname)) return;

    /* --------------------------- пользователи (admin) --------------------------- */

    if (pathname === "/api/users" && method === "GET") {
      return json(res, 200, { users: listUsers() });
    }

    if (pathname === "/api/users" && method === "POST") {
      const body = await readBody(req);
      try {
        const created = createUser({ login: body.login, password: body.password, role: body.role });
        return json(res, 201, { user: created, users: listUsers() });
      } catch (err) {
        return json(res, 400, { error: String(err?.message || err) });
      }
    }

    const um = pathname.match(/^\/api\/users\/([\w-]+)(?:\/(password|role))?$/);
    if (um) {
      const [, userId, action] = um;
      try {
        if (action === "password" && method === "POST") {
          const body = await readBody(req);
          setUserPassword(userId, body.password);
          return json(res, 200, { ok: true });
        }
        if (action === "role" && method === "POST") {
          const body = await readBody(req);
          return json(res, 200, { user: setUserRole(userId, body.role), users: listUsers() });
        }
        if (!action && method === "DELETE") {
          removeUser(userId);
          return json(res, 200, { ok: true, users: listUsers() });
        }
      } catch (err) {
        return json(res, 400, { error: String(err?.message || err) });
      }
      return json(res, 404, { error: "not found" });
    }

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
      if (harness.triggers?.projectStart) {
        const proj = projects.get(projectId);
        mailbox.add({
          from: "system",
          text: change
            ? `«${proj?.name ?? projectId}»: доработка — ${change}`
            : `«${proj?.name ?? projectId}»: старт проекта — ${task.slice(0, 120)}`,
          kind: "start",
          level: "info",
          runId: run.id,
          projectId,
        });
      }
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

    if (pathname === "/api/search" && req.method === "GET") {
      const q = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
      if (q.length < 2) return json(res, 400, { error: "Слишком короткий запрос" });
      const runs = allRuns();
      const byId = new Map(runs.map((r) => [r.id, r]));

      const projectsHit = projects
        .list()
        .filter((p) => `${p.name} ${p.task}`.toLowerCase().includes(q))
        .slice(0, 10)
        .map((p) => ({ id: p.id, name: p.name, task: p.task.slice(0, 120) }));

      const runsHit = [];
      for (const r of runs) {
        const hay = `${r.id} ${r.task ?? ""} ${r.change ?? ""} ${r.plan?.title ?? ""}`.toLowerCase();
        if (hay.includes(q)) runsHit.push({ id: r.id, projectId: r.projectId, status: r.status, task: (r.plan?.title ?? r.task ?? "").slice(0, 120), change: r.change ?? null });
        if (runsHit.length >= 10) break;
      }

      const artifactsHit = [];
      for (const r of runs) {
        let list = [];
        try {
          list = store.listArtifacts(r);
        } catch {
          list = [];
        }
        for (const a of list) {
          if (a.path.toLowerCase().includes(q)) {
            artifactsHit.push({ runId: r.id, projectId: r.projectId, path: a.path });
            if (artifactsHit.length >= 15) break;
          }
        }
        if (artifactsHit.length >= 15) break;
      }

      const imagesHit = studio
        .list(300)
        .filter((i) => (i.prompt ?? "").toLowerCase().includes(q))
        .slice(0, 12)
        .map((i) => ({ id: i.id, file: i.file, prompt: i.prompt.slice(0, 140), cost: i.cost }));

      const agentsHit = (config.agents.agents ?? [])
        .filter((a) => `${a.name} ${a.role} ${a.id}`.toLowerCase().includes(q))
        .map((a) => ({ id: a.id, name: a.name, role: a.role }));

      void byId;
      return json(res, 200, { q, projects: projectsHit, runs: runsHit, artifacts: artifactsHit, images: imagesHit, agents: agentsHit });
    }

    if (pathname === "/api/metrics" && req.method === "GET") {
      const runs = allRuns();
      return json(res, 200, {
        agents: agentMetrics(runs),
        verdicts: verdictSummary(runs),
        runs: runs.length,
      });
    }

    if (pathname === "/api/alerts" && req.method === "GET") {
      const runs = allRuns();
      return json(res, 200, {
        alerts: collectAlerts({
          runs,
          metrics: { agents: agentMetrics(runs) },
          harness,
          projects: projects.list(),
          stages: config.pipeline.stages,
        }),
      });
    }

    if (pathname === "/api/mailbox" && req.method === "GET") {
      return json(res, 200, { items: mailbox.list(100), unread: mailbox.unread() });
    }

    if (pathname === "/api/mailbox" && req.method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "Пустое сообщение" });
      const from = body.from === "harness" ? "harness" : body.from === "system" ? "system" : "user";
      const item = mailbox.add({ from, text, kind: "chat" });
      return json(res, 200, { item, unread: mailbox.unread() });
    }

    if (pathname === "/api/mailbox/read" && req.method === "POST") {
      const body = await readBody(req);
      mailbox.markRead(Array.isArray(body.ids) ? body.ids : []);
      return json(res, 200, { ok: true, unread: mailbox.unread() });
    }

    if (pathname === "/api/harness" && req.method === "GET") {
      return json(res, 200, { harness });
    }
    if (pathname === "/api/keys" && req.method === "GET") {
      return json(res, 200, { ...keys.list(), presets: PRESETS, spend: Object.fromEntries((keys.list().keys ?? []).map((k) => [k.id, keySpendFromLogs(k.id)])) });
    }

    if (pathname === "/api/keys" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const out = keys.add({ label: body.label, key: body.key, limitDaily: body.limitDaily });
        syncKeyToEnv();
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    const km = pathname.match(/^\/api\/keys\/([\w-]+)$/);
    const KEYS_RESERVED = new Set(["preset", "assign", "default"]);
    if (km && !KEYS_RESERVED.has(km[1]) && req.method === "POST") {
      const body = await readBody(req);
      try {
        const out = keys.patch(km[1], body);
        syncKeyToEnv();
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }
    if (km && !KEYS_RESERVED.has(km[1]) && req.method === "DELETE") {
      try {
        const out = keys.remove(km[1]);
        syncKeyToEnv();
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (pathname === "/api/keys/assign" && req.method === "POST") {
      const body = await readBody(req);
      try {
        return json(res, 200, keys.assign(String(body.agentId ?? ""), body.keyId ?? null));
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (pathname === "/api/keys/default" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const out = keys.setDefault(body.id ?? null);
        syncKeyToEnv();
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (pathname === "/api/keys/preset" && req.method === "POST") {
      const body = await readBody(req);
      const preset = String(body.preset ?? "");
      const map = PRESET_MODELS[preset];
      if (!map) return json(res, 400, { error: "Неизвестный пресет" });
      const list = config.agents.agents ?? [];
      for (const a of list) {
        if (a.kind === "external") continue;
        if (map[a.id]) a.model = map[a.id];
      }
      fs.writeFileSync(path.join(CONFIG_DIR, "agents.json"), JSON.stringify(config.agents, null, 2), "utf8");
      return json(res, 200, { agents: config.agents, preset });
    }

    if (pathname === "/api/prices" && req.method === "GET") {
      return json(res, 200, { image: IMAGE_PRICES, note: "оценка по данным OpenRouter, точная цена — в чеке после генерации" });
    }

    if (pathname === "/api/harness" && req.method === "POST") {
      const body = await readBody(req);
      harness = {
        ...harness,
        ...body,
        triggers: { ...(harness.triggers ?? {}), ...(body.triggers ?? {}) },
        thresholds: { ...(harness.thresholds ?? {}), ...(body.thresholds ?? {}) },
      };
      fs.writeFileSync(path.join(CONFIG_DIR, "harness.json"), JSON.stringify(harness, null, 2), "utf8");
      return json(res, 200, { harness });
    }

    if (pathname === "/api/studio/sessions" && req.method === "GET") {
      return json(res, 200, { sessions: studio.listSessions(), activeId: studio.activeId });
    }

    if (pathname === "/api/studio/sessions" && req.method === "POST") {
      const body = await readBody(req);
      const session = studio.createSession({ name: body.name, kind: body.kind });
      return json(res, 200, { session, sessions: studio.listSessions(), activeId: studio.activeId });
    }

    if (pathname === "/api/studio/thread" && req.method === "GET") {
      const sid = url.searchParams.get("session") ?? undefined;
      try {
        const thread = studio.threadList(sid, 80); // внутри проверяется существование чата
        if (sid) studio.activeId = sid;
        return json(res, 200, { thread, activeId: studio.activeId });
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
      }
    }

    const sm = pathname.match(/^\/api\/studio\/sessions\/([\w-]+)$/);
    if (sm && req.method === "POST") {
      const body = await readBody(req);
      try {
        const session = studio.renameSession(sm[1], body.name);
        return json(res, 200, { session, sessions: studio.listSessions() });
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
      }
    }
    if (sm && req.method === "DELETE") {
      try {
        const out = studio.deleteSession(sm[1]);
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (pathname === "/api/studio/doc" && req.method === "POST") {
      const body = await readBody(req, 2_000_000);
      const sid = body.sessionId ?? undefined;
      const text = String(body.text ?? "").trim();
      if (text.length < 2) return json(res, 400, { error: "Пустой текст" });
      if (isMock()) return json(res, 502, { error: "MOCK-режим: редактор не работает без ключа" });

      // «грань»: большой документ правим только по орфографии, короткий запрос — можно переписать
      const mode = ["help", "correct"].includes(body.mode) ? body.mode : text.length > 1200 ? "correct" : "help";
      studio.threadAdd({ role: "user", text, docMode: mode }, sid);

      const agent = engine.agent("scribe");
      const started = Date.now();
      try {
        const out = await chat({
          model: agent.model,
          temperature: Number(agent.temperature ?? 0.3),
          maxTokens: 4000,
          apiKey: keys.resolve(agent.id)?.key ?? null,
          system: agent.prompt,
          user: `Режим: ${mode}. ${mode === "correct" ? "Только орфография и пунктуация, смысл и формулировки не менять." : "Можно переписать и структурировать."}\n\nТекст заказчика:\n"""\n${text}\n"""`,
        });
        const data = extractJson(out.text);
        const msg = studio.threadAdd(
          {
            role: "doc",
            title: String(data.title ?? "Документ"),
            markdown: String(data.markdown ?? ""),
            mode: String(data.mode ?? mode),
            reasoning: String(data.reasoning ?? ""),
            cost: out.usage.cost,
            ms: Date.now() - started,
          },
          sid
        );
        return json(res, 200, { message: msg, thread: studio.threadList(sid, 80) });
      } catch (err) {
        return json(res, 502, { error: String(err?.message || err) });
      }
    }

    const dm = pathname.match(/^\/api\/studio\/doc\/([\w-]+)\.(md|docx)$/);
    if (dm && req.method === "GET") {
      const found = studio.findMessage(dm[1]);
      if (!found || found.message.role !== "doc") return json(res, 404, { error: "Документ не найден" });
      const doc = found.message;
      const name = String(doc.title ?? "document").replace(/[^\wа-яА-Я\d _-]+/gi, "").trim().slice(0, 60) || "document";

      if (dm[2] === "md") {
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.md`,
        });
        return res.end(String(doc.markdown ?? ""));
      }

      try {
        const { markdownToDocx } = await import("./lib/docx.mjs");
        const buf = markdownToDocx(String(doc.markdown ?? ""), { title: doc.title });
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.docx`,
          "Content-Length": buf.length,
        });
        return res.end(buf);
      } catch (err) {
        return json(res, 501, { error: `DOCX пока недоступен: ${err.message}` });
      }
    }

    if (pathname === "/api/studio/say" && req.method === "POST") {
      const body = await readBody(req, 14_000_000);
      const sid = body.sessionId ?? undefined;
      const text = String(body.text ?? "").trim();
      if (text.length < 2) return json(res, 400, { error: "Пустой запрос" });
      const sess = studio.sessions.find((s) => s.id === (sid ?? studio.activeId));
      if (sess && sess.kind !== "images") return json(res, 501, { error: `Чат типа «${sess.kind}» ещё в разработке — сейчас работает только «картинки»` });
      studio.threadAdd({ role: "user", text, ref: body.referenceId ?? null }, sid);
      const result = await makeProposal(text, body.referenceId ?? null, sid);
      if (result.error) return json(res, 502, { error: result.error, thread: studio.threadList(sid, 80) });
      return json(res, 200, { proposal: result.proposal, thread: studio.threadList(sid, 80) });
    }

    if (pathname === "/api/studio/upload" && req.method === "POST") {
      const body = await readBody(req, 14_000_000);
      const data = String(body.data ?? "");
      const m = data.match(/^data:(image\/[\w.+-]+);base64,(.+)$/i);
      if (!m) return json(res, 400, { error: "Нужна картинка в формате data URL" });
      const item = studio.add({
        prompt: "загруженный референс",
        model: "upload",
        aspectRatio: null,
        quality: null,
        mediaType: m[1],
        b64: m[2],
        cost: 0,
        ms: 0,
        refId: null,
      });
      item.uploaded = true;
      studio.save();
      return json(res, 200, { item });
    }

    if (pathname === "/api/studio/propose" && req.method === "POST") {
      const body = await readBody(req);
      const sid = body.sessionId ?? undefined;
      const text = String(body.text ?? "").trim();
      if (text.length < 2) return json(res, 400, { error: "Пустой запрос" });
      const result = await makeProposal(text, body.referenceId ?? null, sid);
      if (result.error) return json(res, 502, { error: result.error, thread: studio.threadList(sid, 80) });
      return json(res, 200, { proposal: result.proposal, thread: studio.threadList(sid, 80) });
    }

    if (pathname === "/api/studio/edit" && req.method === "POST") {
      const body = await readBody(req);
      const id = String(body.id ?? "");
      const text = String(body.text ?? "").trim();
      if (!id) return json(res, 400, { error: "Не указано сообщение" });
      if (text.length < 2) return json(res, 400, { error: "Пустой текст" });
      try {
        const out = studio.editMessage(id, { text }, body.sessionId ?? undefined);
        return json(res, 200, { ...out, thread: studio.threadList(body.sessionId ?? undefined, 80) });
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
      }
    }

    if (pathname === "/api/studio/truncate" && req.method === "POST") {
      const body = await readBody(req);
      const id = String(body.id ?? "");
      if (!id) return json(res, 400, { error: "Не указано сообщение" });
      try {
        const out = studio.truncateFrom(id, body.sessionId ?? undefined);
        return json(res, 200, { ...out, thread: studio.threadList(body.sessionId ?? undefined, 80) });
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
      }
    }

    if (pathname === "/api/studio/clear" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, { ...studio.clearThread(body.sessionId ?? undefined), thread: [] });
    }

    if (pathname === "/api/studio/generate" && req.method === "POST") {
      const body = await readBody(req, 14_000_000);
      const prompt = String(body.prompt ?? "").trim();
      if (prompt.length < 2) return json(res, 400, { error: "Пустой промт" });
      if (isMock()) return json(res, 502, { error: "MOCK-режим: картинки не генерируются без ключа" });

      const references = [];
      let refId = null;
      if (body.referenceId) {
        const item = studio.get(String(body.referenceId));
        if (!item) return json(res, 404, { error: "Референс не найден" });
        references.push(studio.dataUrl(item));
        refId = item.id;
      }

      const imgKey = keys.resolve("studio");
      const requested = String(body.model ?? "google/gemini-3.1-flash-image");
      try {
        let out;
        let usedModel = requested;
        try {
          out = await generateImage({
            model: requested,
            prompt,
            apiKey: imgKey?.key,
            aspectRatio: body.aspectRatio ? String(body.aspectRatio) : undefined,
            quality: body.quality ? String(body.quality) : undefined,
            references,
          });
        } catch (err) {
          // повторяем только когда модель не приняла параметры; 401/402/таймаут не ретраим — это деньги
          if (requested === "google/gemini-3.1-flash-image") throw err;
          if (!/\((400|422)\)/.test(String(err?.message || ""))) throw err;
          usedModel = "google/gemini-3.1-flash-image";
          out = await generateImage({
            model: usedModel,
            prompt,
            apiKey: imgKey?.key,
            aspectRatio: body.aspectRatio ? String(body.aspectRatio) : undefined,
            references,
          });
        }
        // «ещё вариант»: сначала рисуем, и только потом убираем старое — при ошибке картинка остаётся
        if (body.replaceId) {
          try {
            studio.truncateFrom(String(body.replaceId), body.sessionId ?? undefined);
          } catch {
            /* сообщение уже удалено */
          }
        }
        const item = studio.add({
          prompt,
          model: usedModel,
          aspectRatio: body.aspectRatio ?? null,
          quality: body.quality ?? null,
          mediaType: out.mediaType,
          b64: out.b64,
          cost: out.cost,
          ms: out.ms,
          refId,
          keyId: imgKey?.id ?? null,
        });
        const msg = studio.threadAdd({ role: "result", text: prompt, imageId: item.id, file: item.file, cost: item.cost, ms: item.ms, model: item.model, ref: refId }, body.sessionId ?? undefined);
        return json(res, 200, { item, message: msg, url: `/studio/${item.file}`, thread: studio.threadList(body.sessionId ?? undefined, 80) });
      } catch (err) {
        return json(res, 502, { error: String(err?.message || err) });
      }
    }

    if (pathname === "/api/images/models" && req.method === "GET") {
      try {
        return json(res, 200, { models: await imageModels() });
      } catch (err) {
        return json(res, 200, { models: [], error: err.message });
      }
    }

    if (pathname === "/api/images" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 60), 200);
      return json(res, 200, { items: studio.list(limit) });
    }

    if (pathname === "/api/images" && req.method === "POST") {
      const body = await readBody(req, 14_000_000);
      const prompt = String(body.prompt ?? "").trim();
      if (prompt.length < 2) return json(res, 400, { error: "Пустой промт" });
      if (isMock()) return json(res, 502, { error: "MOCK-режим: картинки не генерируются без ключа" });

      const model = String(body.model ?? "google/gemini-3.1-flash-image");
      const references = [];
      let refId = null;
      if (body.referenceId) {
        const item = studio.get(String(body.referenceId));
        if (!item) return json(res, 404, { error: "Референс не найден" });
        references.push(studio.dataUrl(item));
        refId = item.id;
      } else if (typeof body.reference === "string" && body.reference.startsWith("data:image/")) {
        references.push(body.reference);
      }

      try {
        const out = await generateImage({
          model,
          prompt,
          aspectRatio: body.aspectRatio ? String(body.aspectRatio) : undefined,
          quality: body.quality ? String(body.quality) : undefined,
          resolution: body.resolution ? String(body.resolution) : undefined,
          references,
        });
        const item = studio.add({
          prompt,
          model,
          aspectRatio: body.aspectRatio ?? null,
          quality: body.quality ?? null,
          mediaType: out.mediaType,
          b64: out.b64,
          cost: out.cost,
          ms: out.ms,
          refId,
        });
        return json(res, 200, { item, url: `/studio/${item.file}` });
      } catch (err) {
        return json(res, 502, { error: String(err?.message || err) });
      }
    }

    if (pathname === "/api/assistant" && req.method === "POST") {
      const body = await readBody(req);
      const question = String(body.question ?? "").trim();
      if (!question) return json(res, 400, { error: "Пустой вопрос" });
      const answer = await assistantAnswer(question, Array.isArray(body.history) ? body.history : []);
      return json(res, 200, answer);
    }

    const m = pathname.match(/^\/api\/runs\/([\w.-]+)(?:\/(events|approve|cancel|resume|artifact|plan|diff))?$/);
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

      if (action === "diff" && req.method === "GET") {
        const baseId = url.searchParams.get("base") || run.baseId;
        if (!baseId) return json(res, 400, { error: "У этой версии нет базовой — сравнивать не с чем" });
        let base;
        try {
          base = store.load(baseId);
        } catch {
          return json(res, 404, { error: "Базовая версия не найдена" });
        }
        const before = engine.workspaceFiles(base).reduce((acc, f) => ({ ...acc, [f.path]: f.content }), {});
        const after = engine.workspaceFiles(run).reduce((acc, f) => ({ ...acc, [f.path]: f.content }), {});
        const result = diffWorkspaces(before, after);
        return json(res, 200, {
          base: { id: base.id, createdAt: base.createdAt, change: base.change ?? null, planTitle: base.plan?.title ?? null },
          current: { id: run.id, createdAt: run.createdAt, change: run.change ?? null, planTitle: run.plan?.title ?? null },
          ...result,
        });
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

/** Художник: переписывает человеческий запрос в промт и объясняет, как понял задачу. */
async function makeProposal(text, referenceId = null, sessionId = undefined) {
  if (isMock()) return { error: "MOCK-режим: художник не работает без ключа" };
  const refItem = referenceId ? studio.get(String(referenceId)) : null;
  const refNote = refItem ? `\n\nЗаказчик приложил картинку-референс (${refItem.id}). Это запрос на правку: опиши в промте, что менять, а что оставить, и используй формулировки вроде "keep the composition".` : "";
  const models = await imageModels().catch(() => []);
  const blocked = /(vector|krea|edit|upscal|inpaint)/i;
  const list = models
    .map((m) => m.id)
    .filter((id) => !blocked.test(id))
    .slice(0, 40)
    .join(", ");

  const agent = engine.agent("artist");
  const started = Date.now();
  try {
    const out = await chat({
      model: agent.model,
      apiKey: keys.resolve("artist")?.key ?? null,
      temperature: Number(agent.temperature ?? 0.4),
      maxTokens: 1200,
      system: agent.prompt,
      user: `Запрос заказчика: "${text}"${refNote}\n\nДоступные модели картинок: ${list}\n\nВерни СТРОГО JSON: {"reasoning":"2–4 предложения по-русски: как понял задачу, что важно, что исключил, почему такая модель","prompt":"подробный промт для модели","model":"id из списка","aspectRatio":"1:1|16:9|9:16|4:3|3:4|3:2","quality":"auto|low|medium|high","why":"одной фразой по-русски"}`,
    });
    const data = extractJson(out.text);
    const proposal = studio.threadAdd({
      role: "proposal",
      prompt: String(data.prompt ?? text),
      model: String(data.model ?? "google/gemini-3.1-flash-image"),
      aspectRatio: String(data.aspectRatio ?? "1:1"),
      quality: String(data.quality ?? "auto"),
      why: String(data.why ?? ""),
      reasoning: String(data.reasoning ?? ""),
      ref: referenceId,
      cost: out.usage.cost,
      ms: Date.now() - started,
    }, sessionId);
    return { proposal };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}


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
    apiKey: keys.resolve("assistant")?.key ?? null,
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

let imgModelsCache = { at: 0, models: [] };
async function imageModels() {
  const fresh = Date.now() - imgModelsCache.at < 3600_000;
  if (fresh && imgModelsCache.models.length) return imgModelsCache.models;
  const models = await listImageModels();
  imgModelsCache = { at: Date.now(), models };
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
  console.log(`  Вход: /api/login · роли viewer / editor / admin`);
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
