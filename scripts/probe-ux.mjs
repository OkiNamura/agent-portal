/**
 * Проверка UX-доработок портала:
 *   - три вкладки углового чата и их счётчики;
 *   - «прочитать всё» и «очистить» только в пределах вкладки;
 *   - пауза/продолжение проекта;
 *   - очистка несуществующих проектов;
 *   - снимки состояния (создание, список, restore, 403 для viewer, удаление).
 *
 * Поднимает свой server.mjs на 7801 с временными каталогами и MOCK=1,
 * логинится admin/viewer, гасит сервер и удаляет temp.
 *
 * Запуск: node scripts/probe-ux.mjs  (Exit 1 при любом провале)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../lib/auth.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;

/** Порт по умолчанию — 7801. Если он занят долгоживущим порталом, берём следующий свободный. */
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

const preferredPort = Number(process.env.PROBE_PORT || 7801);
let PORT = preferredPort;
if (!(await portFree(PORT))) {
  for (let candidate = preferredPort + 1; candidate <= preferredPort + 10; candidate++) {
    if (await portFree(candidate)) {
      PORT = candidate;
      console.log(`порт ${preferredPort} занят — проверка поднимется на ${PORT}`);
      break;
    }
  }
}
if (PORT === preferredPort && !(await portFree(PORT))) {
  console.error(`FAIL · порт ${preferredPort} и следующие 10 заняты — некуда поднять сервер`);
  process.exit(1);
}
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ADMIN_PASSWORD = "XvQ2xTvPrS7z";
const VIEWER_PASSWORD = "viewer-ux-pass";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};

/* ------------------------------ временные данные ------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ux-"));
const runsDir = path.join(tmp, "runs");
const projectsFile = path.join(tmp, "projects.json");
const mailboxFile = path.join(tmp, "mailbox.json");
const usersFile = path.join(tmp, "users.json");
const studioDir = path.join(tmp, "studio");
const configDir = path.join(tmp, "config");
const snapshotsDir = path.join(tmp, "snapshots");
const serverLogFile = path.join(tmp, "server.log");

const now = new Date().toISOString();
const runId = "20260101-000000-uxlive";
const projectId = "p-live";
const deadProjectId = "p-dead";
const emptyProjectId = "p-empty";
const task = "UX-проба: страница с заголовком и стилями";

const pipeline = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "pipeline.json"), "utf8").replace(/^\uFEFF/, ""));
const stages = (pipeline.stages ?? []).filter((s) => s.enabled !== false);
const gateIndex = stages.findIndex((s) => s.gate);
if (gateIndex < 0) {
  console.error("FAIL · в config/pipeline.json нет стадии с гейтом — пауза/продолжение не проверить");
  process.exit(1);
}
const gateStage = stages[gateIndex];

function seed() {
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(studioDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  for (const name of ["agents.json", "pipeline.json", "harness.json"]) {
    fs.copyFileSync(path.join(ROOT, "config", name), path.join(configDir, name));
  }

  fs.writeFileSync(
    usersFile,
    JSON.stringify(
      {
        users: [
          { id: "u-ux-admin", login: "admin", passHash: hashPassword(ADMIN_PASSWORD), role: "admin", createdAt: now },
          { id: "u-ux-viewer", login: "probe-viewer", passHash: hashPassword(VIEWER_PASSWORD), role: "viewer", createdAt: now },
        ],
        sessions: [],
      },
      null,
      2
    ),
    "utf8"
  );

  /* Старые письма без tab: сервер должен разложить их сам. */
  const msg = (id, fields) => ({ id, at: now, read: false, ...fields });
  const messages = [
    msg("m-err", { from: "system", text: "Прогон упал: ошибка агента", kind: "error", level: "bad" }),
    msg("m-stop", { from: "system", text: "Прогон остановлен", kind: "stop", level: "info" }),
    msg("m-gate", { from: "system", text: "Нужно подтверждение: проверка", kind: "gate", level: "warn" }),
    msg("m-done", { from: "system", text: "Прогон завершён", kind: "done", level: "info" }),
    msg("m-old", { from: "system", text: "Старое сообщение без tab", kind: "note", level: "info" }),
    msg("m-chat-u", { from: "user", text: "Привет, Харнесс", kind: "chat", level: "info" }),
    msg("m-chat-a", { from: "assistant", text: "Привет! Слушаю", kind: "chat", level: "info" }),
  ];
  fs.writeFileSync(mailboxFile, JSON.stringify({ items: messages }, null, 2), "utf8");

  fs.writeFileSync(
    projectsFile,
    JSON.stringify(
      {
        projects: [
          { id: projectId, name: "Живой проект", task, createdAt: now, updatedAt: now, runIds: [runId] },
          { id: deadProjectId, name: "Битый проект", task: "Прогон потерян", createdAt: now, updatedAt: now, runIds: ["20250101-000000-gone"] },
          { id: emptyProjectId, name: "Пустой проект", task: "Ни одного прогона", createdAt: now, updatedAt: now, runIds: [] },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(path.join(runDir, "artifacts", "work"), { recursive: true });
  const run = {
    id: runId,
    task,
    change: null,
    baseId: null,
    projectId,
    createdAt: now,
    updatedAt: now,
    status: "awaiting",
    stageIndex: gateIndex,
    awaiting: { stageId: gateStage.id, title: gateStage.title, question: "Проверь результат стадии", artifacts: [] },
    plan: { title: "План UX-пробы", blocks: [{ id: "b1", title: "Заголовок", goal: "Показать h1", acceptance: ["есть h1"], deps: [] }] },
    blocks: [
      {
        id: "b1",
        title: "Заголовок",
        goal: "Показать h1",
        status: "built",
        acceptance: ["есть h1"],
        deps: [],
        files: [{ path: "index.html", content: "<h1>UX</h1>\n" }],
        test: { verdict: "pass", summary: "ок", defects: [], criteria: [], round: 1 },
        fixes: [],
        history: [],
      },
    ],
    approvals: {},
    stageMeta: {},
    workspace: { "index.html": "<h1>UX</h1>\n" },
    usage: { prompt: 0, completion: 0, cost: 0.01, calls: 1 },
    error: null,
    eventSeq: 0,
  };
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(run, null, 2), "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "work", "index.html"), run.workspace["index.html"], "utf8");
  fs.writeFileSync(path.join(runDir, "events.jsonl"), "", "utf8");
}

seed();

/* ------------------------------- запуск сервера ------------------------------- */

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  MOCK: "1",
  RUNS_DIR: runsDir,
  PROJECTS_FILE: projectsFile,
  MAILBOX_FILE: mailboxFile,
  USERS_FILE: usersFile,
  STUDIO_DIR: studioDir,
  CONFIG_DIR: configDir,
  SNAPSHOTS_DIR: snapshotsDir,
};
delete serverEnv.AUTH_FILE;

const server = (() => {
  // В песочнице DSH пайпы stdio могут быть недоступны — пишем лог в файл.
  const fd = fs.openSync(serverLogFile, "a");
  const child = spawn(NODE, ["server.mjs"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", fd, fd], windowsHide: true });
  fs.closeSync(fd);
  return child;
})();

function readServerLog() {
  try {
    return fs.readFileSync(serverLogFile, "utf8");
  } catch {
    return "";
  }
}

async function waitReady(ms = 20_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (server.exitCode != null) throw new Error(`сервер завершился (код ${server.exitCode})\n${readServerLog().slice(-1500)}`);
    try {
      const res = await fetch(`${BASE}/api/login`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return;
    } catch {
      /* ещё не поднялся */
    }
    await sleep(150);
  }
  throw new Error(`сервер не ответил за ${ms} мс\n${readServerLog().slice(-1500)}`);
}

async function stopServer() {
  if (server.exitCode != null) return;
  server.kill();
  const started = Date.now();
  while (server.exitCode == null && Date.now() - started < 5000) await sleep(100);
  if (server.exitCode == null) server.kill("SIGKILL");
}

/* ------------------------------- HTTP-хелперы ------------------------------- */

async function request(pathname, { method = "GET", cookie, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, headers: res.headers, text };
}

function setCookies(res) {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function sessionCookie(res) {
  for (const raw of setCookies(res)) {
    const first = raw.split(";")[0];
    if (first.startsWith("portal_session=")) return first;
  }
  return null;
}

async function login(name, password) {
  const res = await request("/api/login", { method: "POST", body: { login: name, password } });
  return { res, cookie: sessionCookie(res) };
}

const tabsOf = (items) => Object.fromEntries(items.map((m) => [m.id, m.tab]));

/* ------------------------------- сценарии ------------------------------- */

let exception = null;
try {
  await waitReady();
  check(`сервер поднялся на ${PORT}`, true);

  const admin = await login("admin", ADMIN_PASSWORD);
  check("admin входит", admin.res.status === 200 && Boolean(admin.cookie), `статус ${admin.res.status}`);
  if (!admin.cookie) throw new Error("без cookie админа проверять нечего");

  const viewer = await login("probe-viewer", VIEWER_PASSWORD);
  check("viewer входит", viewer.res.status === 200 && Boolean(viewer.cookie), `статус ${viewer.res.status}`);
  if (!viewer.cookie) throw new Error("без cookie viewer нельзя проверить 403");

  const page = await request("/", { cookie: admin.cookie });
  check(
    "страница содержит вкладки чата и кнопки действий",
    page.status === 200 &&
      page.text.includes('id="cornerTabs"') &&
      page.text.includes('data-ctab="critical"') &&
      page.text.includes('data-ctab="notice"') &&
      page.text.includes('data-ctab="chat"') &&
      page.text.includes('id="cornerReadAll"') &&
      page.text.includes('id="cornerClear"') &&
      page.text.includes('id="runPause"'),
    `статус ${page.status}`
  );

  /* 1. три вкладки и классификация старых сообщений */
  const mb = await request("/api/mailbox?limit=200", { cookie: admin.cookie });
  const items = mb.data.items ?? [];
  const tabs = tabsOf(items);
  check("GET /api/mailbox отдаёт все сообщения", mb.status === 200 && items.length === 7, `статус ${mb.status}, сообщений ${items.length}`);
  check(
    "критичные: error и stop",
    tabs["m-err"] === "critical" && tabs["m-stop"] === "critical",
    JSON.stringify({ err: tabs["m-err"], stop: tabs["m-stop"] })
  );
  check(
    "оповещения: gate, done и старое сообщение без tab",
    tabs["m-gate"] === "notice" && tabs["m-done"] === "notice" && tabs["m-old"] === "notice",
    JSON.stringify({ gate: tabs["m-gate"], done: tabs["m-done"], old: tabs["m-old"] })
  );
  check(
    "чат: переписка user/assistant",
    tabs["m-chat-u"] === "chat" && tabs["m-chat-a"] === "chat",
    JSON.stringify({ user: tabs["m-chat-u"], assistant: tabs["m-chat-a"] })
  );
  check(
    "счётчики по вкладкам",
    mb.data.tabs?.critical?.total === 2 &&
      mb.data.tabs?.notice?.total === 3 &&
      mb.data.tabs?.chat?.total === 2 &&
      mb.data.tabs?.critical?.unread === 2 &&
      mb.data.tabs?.notice?.unread === 3 &&
      mb.data.tabs?.chat?.unread === 2,
    JSON.stringify(mb.data.tabs ?? {})
  );

  const filtered = await request("/api/mailbox?tab=critical&limit=200", { cookie: admin.cookie });
  check(
    "GET /api/mailbox?tab=critical отдаёт только критичное",
    filtered.status === 200 && filtered.data.items?.length === 2 && filtered.data.items.every((m) => m.tab === "critical"),
    `статус ${filtered.status}, сообщений ${filtered.data.items?.length}`
  );

  /* 2. прочитать всё — только своя вкладка */
  const readOne = await request("/api/mailbox/read", { method: "POST", cookie: admin.cookie, body: { ids: ["m-chat-u"] } });
  check("отдельное сообщение читается по id", readOne.status === 200 && readOne.data.tabs?.chat?.unread === 1, `чат unread ${readOne.data.tabs?.chat?.unread}`);

  const readCritical = await request("/api/mailbox/read", { method: "POST", cookie: admin.cookie, body: { tab: "critical" } });
  check(
    "«прочитать всё» на критичном не трогает другие вкладки",
    readCritical.status === 200 &&
      readCritical.data.tabs?.critical?.unread === 0 &&
      readCritical.data.tabs?.notice?.unread === 3 &&
      readCritical.data.tabs?.chat?.unread === 1,
    JSON.stringify(readCritical.data.tabs ?? {})
  );
  const afterRead = await request("/api/mailbox?limit=200", { cookie: admin.cookie });
  const byId = new Map((afterRead.data.items ?? []).map((m) => [m.id, m]));
  check(
    "прочитанными стали только критичные",
    byId.get("m-err")?.read === true && byId.get("m-stop")?.read === true && byId.get("m-gate")?.read === false && byId.get("m-chat-a")?.read === false,
    JSON.stringify({ err: byId.get("m-err")?.read, gate: byId.get("m-gate")?.read, chat: byId.get("m-chat-a")?.read })
  );

  /* 3. очистить — только своя вкладка */
  const cleared = await request("/api/mailbox/clear", { method: "POST", cookie: admin.cookie, body: { tab: "notice" } });
  check(
    "«очистить» удаляет только оповещения",
    cleared.status === 200 &&
      cleared.data.removed === 3 &&
      cleared.data.tabs?.notice?.total === 0 &&
      cleared.data.tabs?.critical?.total === 2 &&
      cleared.data.tabs?.chat?.total === 2,
    JSON.stringify({ removed: cleared.data.removed, tabs: cleared.data.tabs })
  );
  const afterClear = await request("/api/mailbox?limit=200", { cookie: admin.cookie });
  const remaining = afterClear.data.items ?? [];
  check(
    "после очистки остались критичное и чат",
    remaining.length === 4 && remaining.every((m) => m.tab === "critical" || m.tab === "chat"),
    JSON.stringify(remaining.map((m) => `${m.id}:${m.tab}`))
  );
  const clearCritical = await request("/api/mailbox/clear", { method: "POST", cookie: admin.cookie, body: { tab: "critical" } });
  check("критичное тоже очищается", clearCritical.status === 200 && clearCritical.data.removed === 2 && clearCritical.data.tabs?.critical?.total === 0);

  /* 4. пауза → paused, запуск нового прогона запрещён, продолжение → awaiting */
  const beforePause = await request(`/api/projects/${projectId}`, { cookie: admin.cookie });
  check("проект до паузы не на паузе", beforePause.status === 200 && beforePause.data.project?.paused !== true);

  const paused = await request(`/api/runs/${runId}/pause`, { method: "POST", cookie: admin.cookie });
  check(
    "пауза переводит прогон в paused",
    paused.status === 200 && paused.data.run?.status === "paused" && paused.data.run?.paused === true,
    `статус ${paused.data.run?.status}`
  );
  check(
    "в проекте запомнились pausedAt и pausedStage",
    paused.data.project?.paused === true && Boolean(paused.data.project?.pausedAt) && paused.data.project?.pausedStage === gateStage.id,
    JSON.stringify({ paused: paused.data.project?.paused, at: paused.data.project?.pausedAt, stage: paused.data.project?.pausedStage })
  );
  const projectPaused = await request(`/api/projects/${projectId}`, { cookie: admin.cookie });
  check("пауза сохранилась в projects.json", projectPaused.data.project?.paused === true && projectPaused.data.project?.pausedStage === gateStage.id);

  const blocked = await request("/api/runs", {
    method: "POST",
    cookie: admin.cookie,
    body: { task: "Новый прогон в приостановленном проекте", projectId },
  });
  check("новый прогон в проекте на паузе запрещён", blocked.status === 409, `статус ${blocked.status} · ${blocked.data.error ?? ""}`);

  const resumed = await request(`/api/runs/${runId}/resume`, { method: "POST", cookie: admin.cookie });
  check(
    "продолжение снимает паузу и возвращает awaiting",
    [200, 202].includes(resumed.status) && ["running", "awaiting"].includes(resumed.data.run?.status) && resumed.data.run?.status === "awaiting",
    `статус ${resumed.data.run?.status}`
  );
  const projectResumed = await request(`/api/projects/${projectId}`, { cookie: admin.cookie });
  check(
    "после продолжения проект не на паузе",
    projectResumed.data.project?.paused !== true && projectResumed.data.project?.pausedAt == null && projectResumed.data.project?.pausedStage == null,
    JSON.stringify({ paused: projectResumed.data.project?.paused, at: projectResumed.data.project?.pausedAt, stage: projectResumed.data.project?.pausedStage })
  );

  /* 5. очистка несуществующих проектов */
  const beforeCleanupProjects = await request("/api/projects", { cookie: admin.cookie });
  const cleanup = await request("/api/projects/cleanup", { method: "POST", cookie: admin.cookie, body: {} });
  check(
    "очистка удаляет только битые проекты",
    cleanup.status === 200 && cleanup.data.removed === 2 && cleanup.data.kept === 1,
    JSON.stringify({ status: cleanup.status, removed: cleanup.data.removed, kept: cleanup.data.kept, names: cleanup.data.projects })
  );
  const cleanedIds = (cleanup.data.projects ?? []).map((p) => p.id);
  check("удалены dead и empty", cleanedIds.includes(deadProjectId) && cleanedIds.includes(emptyProjectId), JSON.stringify(cleanedIds));
  const afterCleanup = await request("/api/projects", { cookie: admin.cookie });
  check(
    "живой проект с прогоном остался",
    afterCleanup.data.projects?.length === 1 && afterCleanup.data.projects?.[0]?.id === projectId,
    JSON.stringify((afterCleanup.data.projects ?? []).map((p) => p.id))
  );
  check(
    "у живой записи до сих пор живые прогоны",
    beforeCleanupProjects.data.projects?.find((p) => p.id === projectId)?.runIds?.length === 1 &&
      fs.existsSync(path.join(runsDir, runId, "state.json"))
  );

  /* 6. снимки: создание, список, restore, 403 viewer, удаление */
  const emptyList = await request("/api/snapshots", { cookie: admin.cookie });
  check("сначала список снимков пуст", emptyList.status === 200 && emptyList.data.snapshots?.length === 0);

  const originalProjects = fs.readFileSync(projectsFile, "utf8");
  const originalAgents = fs.readFileSync(path.join(configDir, "agents.json"), "utf8");
  const created = await request("/api/snapshots", { method: "POST", cookie: admin.cookie, body: { name: "ux test" } });
  const snap = created.data.snapshot;
  check("снимок создаётся", created.status === 201 && Boolean(snap?.id), `статус ${created.status} · ${JSON.stringify(created.data).slice(0, 200)}`);
  check("id снимка — timestamp-slug", /^\d{8}-\d{6}-ux-test$/.test(snap?.id ?? ""), snap?.id);
  check("в снимке есть дата, размер и число прогонов", Boolean(snap?.createdAt) && snap?.size > 0 && snap?.runs === 1, JSON.stringify({ at: snap?.createdAt, size: snap?.size, runs: snap?.runs }));

  const snapDir = path.join(snapshotsDir, snap.id);
  check(
    "структура снимка повторяет исходную",
    ["projects.json", "config/agents.json", "config/pipeline.json", "config/harness.json", "studio/sessions.json", `runs/${runId}/state.json`].every((rel) =>
      fs.existsSync(path.join(snapDir, rel))
    ),
    snapDir
  );

  const list = await request("/api/snapshots", { cookie: admin.cookie });
  const listed = list.data.snapshots?.find((s) => s.id === snap.id);
  check(
    "GET /api/snapshots отдаёт имя, дату, размер, прогоны",
    list.status === 200 && Boolean(listed) && listed.name === "ux test" && Boolean(listed.createdAt) && listed.size > 0 && listed.runs === 1,
    JSON.stringify(listed)
  );

  // Ломаем текущее состояние: файлы должны вернуться к содержимому снимка.
  fs.writeFileSync(projectsFile, JSON.stringify({ projects: [] }, null, 2), "utf8");
  fs.writeFileSync(path.join(configDir, "agents.json"), JSON.stringify({ agents: { agents: [] } }, null, 2), "utf8");

  const restored = await request(`/api/snapshots/${encodeURIComponent(snap.id)}/restore`, { method: "POST", cookie: admin.cookie, body: {} });
  check("restore отвечает 200 и восстанавливает файлы", restored.status === 200 && restored.data.restored > 0, `статус ${restored.status} · ${JSON.stringify(restored.data).slice(0, 200)}`);
  check("restore вернул projects.json к старому содержимому", fs.readFileSync(projectsFile, "utf8") === originalProjects);
  check("restore вернул config/agents.json к старому содержимому", fs.readFileSync(path.join(configDir, "agents.json"), "utf8") === originalAgents);
  check("restore сделал авто-снимок before-restore", /before-restore/.test(restored.data.before?.name ?? "") && Boolean(restored.data.before?.id), JSON.stringify(restored.data.before));
  const afterRestoreProjects = await request("/api/projects", { cookie: admin.cookie });
  check(
    "сервер перечитал projects.json после restore",
    afterRestoreProjects.data.projects?.length === 1 && afterRestoreProjects.data.projects?.[0]?.id === projectId,
    JSON.stringify((afterRestoreProjects.data.projects ?? []).map((p) => p.id))
  );

  const listAfterRestore = await request("/api/snapshots", { cookie: admin.cookie });
  check("после restore в списке два снимка", listAfterRestore.data.snapshots?.length >= 2, `снимков ${listAfterRestore.data.snapshots?.length}`);

  const viewerRestore = await request(`/api/snapshots/${encodeURIComponent(snap.id)}/restore`, { method: "POST", cookie: viewer.cookie, body: {} });
  check("viewer получает 403 на restore", viewerRestore.status === 403, `статус ${viewerRestore.status}`);

  const deleted = await request(`/api/snapshots/${encodeURIComponent(snap.id)}`, { method: "DELETE", cookie: admin.cookie });
  check("снимок удаляется", deleted.status === 200 && deleted.data.ok === true, `статус ${deleted.status}`);
  const afterDelete = await request("/api/snapshots", { cookie: admin.cookie });
  check("удалённого снимка нет в списке", !(afterDelete.data.snapshots ?? []).some((s) => s.id === snap.id));
} catch (err) {
  exception = err;
  console.error("EXCEPTION ·", err?.stack || String(err));
} finally {
  await stopServer();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  } catch (err) {
    console.error("не удалось удалить temp:", String(err?.message || err));
  }
}

if (exception) failed++;
console.log(failed ? `\nПРОВАЛ · ${failed} проверок` : "\nВСЁ ЗЕЛЁНО");
process.exit(failed ? 1 : 0);
