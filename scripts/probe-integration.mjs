/**
 * probe-integration.mjs — проверка четырёх связок портала на своём сервере.
 *
 *   1) дежурный с сохранением: start → рестарт сервера → GET /api/watch показывает
 *      running и тот же интервал; stop тоже переживает рестарт;
 *   2) /api/state отдаёт новые поля блоков (fallbacks/needsRecheck/autoAccepted/
 *      integrityWarnings/rechecks) и fallbacks прогона; их же отдаёт snapshot();
 *   3) check-dom.mjs <dir> проверяет переданный каталог, а не портал;
 *   4) check-notepad.mjs <dir> проверяет переданный каталог (и не ломается на портале).
 *
 * Сервер: 127.0.0.1:7797, MOCK=1, временные RUNS_DIR/PROJECTS_FILE/MAILBOX_FILE/
 * USERS_FILE/STUDIO_DIR. Exit 1 при провале; сервер гасится, temp удаляется.
 *
 * Запуск: node scripts/probe-integration.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../lib/auth.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const PORT = 7797;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = "XvQ2xTvPrS7z";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};

/* ------------------------------ временные данные ------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-integration-"));
const runsDir = path.join(tmp, "runs");
const projectsFile = path.join(tmp, "projects.json");
const mailboxFile = path.join(tmp, "mailbox.json");
const usersFile = path.join(tmp, "users.json");
const studioDir = path.join(tmp, "studio");
const serverLogFile = path.join(tmp, "server.log");
const watchStateFile = path.join(runsDir, "watch.state.json");

fs.mkdirSync(runsDir, { recursive: true });
fs.mkdirSync(studioDir, { recursive: true });
fs.writeFileSync(
  usersFile,
  JSON.stringify(
    {
      users: [
        {
          id: "u-probe-admin",
          login: "admin",
          passHash: hashPassword(ADMIN_PASSWORD),
          role: "admin",
          createdAt: new Date().toISOString(),
        },
      ],
      sessions: [],
    },
    null,
    2
  ),
  "utf8"
);

/* Фикстурный прогон: проверяем, что новые поля не теряются по пути state.json → snapshot. */
const FIXTURE_ID = "20260101-000000-integration";
const FIXTURE_WARNING = "Файл app.js: пропала функция undo() — перепроверить";
{
  const now = new Date().toISOString();
  const fixture = {
    id: FIXTURE_ID,
    task: "Фикстур: блок с пометками целостности",
    change: null,
    baseId: null,
    projectId: null,
    createdAt: now,
    updatedAt: now,
    status: "awaiting",
    stageIndex: 4,
    awaiting: { stageId: "verify", title: "Проверка и правки", question: "Проверь результат стадии" },
    plan: { title: "Фикстурный план", blocks: [{ id: "b1", title: "Фикстурный блок", goal: "g", acceptance: ["a"], deps: [] }] },
    fallbacks: 3,
    blocks: [
      {
        id: "b1",
        title: "Фикстурный блок",
        goal: "Показать все пометки",
        status: "verified",
        acceptance: ["есть index.html"],
        deps: [],
        spec: "# Фикстур\n",
        design: null,
        files: [{ path: "index.html", content: "<!doctype html><html><body></body></html>" }],
        test: { verdict: "pass", summary: "ок", defects: [], criteria: [], round: 1 },
        fixes: [],
        history: [],
        fallbacks: 2,
        needsRecheck: true,
        autoAccepted: true,
        integrityWarnings: [FIXTURE_WARNING],
        rechecks: 1,
        manual: { decision: "accept", at: now, by: "engine", auto: true, comment: "авто: тест и безопасность пройдены" },
      },
    ],
    approvals: {},
    stageMeta: {},
    workspace: { "index.html": "<!doctype html><html><body></body></html>" },
    usage: { prompt: 0, completion: 0, cost: 0, calls: 0 },
    error: null,
    eventSeq: 0,
    events: [],
  };
  const runDir = path.join(runsDir, FIXTURE_ID);
  fs.mkdirSync(path.join(runDir, "artifacts", "work"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(fixture, null, 2), "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "work", "index.html"), fixture.workspace["index.html"], "utf8");
}

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
};
delete serverEnv.AUTH_FILE;

let server = null;

function startServer() {
  const fd = fs.openSync(serverLogFile, "a");
  server = spawn(NODE, ["server.mjs"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", fd, fd], windowsHide: true });
  fs.closeSync(fd);
}

function readServerLog() {
  try {
    return fs.readFileSync(serverLogFile, "utf8");
  } catch {
    return "";
  }
}

async function waitReady(ms = 25_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (server?.exitCode != null) throw new Error(`сервер завершился (код ${server.exitCode})\n${readServerLog().slice(-1500)}`);
    try {
      const res = await fetch(`${BASE}/api/login`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return;
    } catch {
      /* ещё поднимается */
    }
    await sleep(150);
  }
  throw new Error(`сервер не ответил за ${ms} мс\n${readServerLog().slice(-1500)}`);
}

async function stopServer() {
  if (!server || server.exitCode != null) {
    server = null;
    return;
  }
  server.kill();
  const started = Date.now();
  while (server.exitCode == null && Date.now() - started < 6000) await sleep(100);
  if (server.exitCode == null) server.kill("SIGKILL");
  // старый процесс мог ещё держать порт — даём ему исчезнуть
  await sleep(200);
  server = null;
}

async function restartServer() {
  await stopServer();
  startServer();
  await waitReady();
}

/* ------------------------------- HTTP-хелперы ------------------------------- */

async function request(pathname, { method = "GET", cookie, body, timeout = 30_000 } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
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

async function login() {
  const res = await request("/api/login", { method: "POST", body: { login: "admin", password: ADMIN_PASSWORD } });
  return { status: res.status, cookie: sessionCookie(res), data: res.data };
}

let nodeSeq = 0;
/** Запуск node-скрипта без пайпов (в песочнице DSH spawn с pipe может дать EPERM). */
function runNode(args, timeoutMs = 120_000) {
  nodeSeq += 1;
  const logFile = path.join(tmp, `node-${nodeSeq}.log`);
  const fd = fs.openSync(logFile, "a");
  const child = spawn(NODE, args, { cwd: ROOT, stdio: ["ignore", fd, fd], windowsHide: true });
  fs.closeSync(fd);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* уже завершился */
      }
    }, timeoutMs);
    const done = (code) => {
      clearTimeout(timer);
      let out = "";
      try {
        out = fs.readFileSync(logFile, "utf8");
      } catch {
        /* лог не создался */
      }
      resolve({ code: code ?? 1, out });
    };
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code));
  });
}

/* --------------------------------- сценарии --------------------------------- */

let exception = null;
try {
  startServer();
  await waitReady();
  check("сервер поднялся на 7797", true);

  let admin = await login();
  check("admin XvQ2xTvPrS7z входит (200 + cookie)", admin.status === 200 && Boolean(admin.cookie), `статус ${admin.status}`);
  if (!admin.cookie) throw new Error("без cookie админа проверять нечего");
  let cookie = admin.cookie;

  /* ---------------------- 1. дежурный переживает рестарт ---------------------- */

  const watchStart = await request("/api/watch/start", { method: "POST", cookie, body: { everyMin: 7 } });
  check(
    "POST /api/watch/start → running=true, everyMin=7",
    watchStart.status === 200 && watchStart.data.running === true && watchStart.data.everyMin === 7,
    `статус ${watchStart.status} · ${JSON.stringify(watchStart.data)}`
  );
  check("watch.state.json создан в каталоге запусков", fs.existsSync(watchStateFile), watchStateFile);
  const beforeRestart = await request("/api/watch", { cookie });
  const lastRunAt = beforeRestart.data.lastRunAt;
  check("до рестарта GET /api/watch → running + lastRunAt", beforeRestart.data.running === true && Boolean(lastRunAt), JSON.stringify(beforeRestart.data));

  await restartServer();
  admin = await login();
  check("после рестарта admin снова входит", admin.status === 200 && Boolean(admin.cookie), `статус ${admin.status}`);
  cookie = admin.cookie ?? cookie;

  const afterRestart = await request("/api/watch", { cookie });
  check(
    "после рестарта GET /api/watch → running=true и тот же интервал",
    afterRestart.status === 200 && afterRestart.data.running === true && afterRestart.data.everyMin === 7,
    `статус ${afterRestart.status} · ${JSON.stringify(afterRestart.data)}`
  );
  check("lastRunAt после рестарта не потерян", afterRestart.data.lastRunAt === lastRunAt, `${afterRestart.data.lastRunAt} vs ${lastRunAt}`);
  const savedOnDisk = JSON.parse(fs.readFileSync(watchStateFile, "utf8"));
  check(
    "watch.state.json хранит running=true и everyMin=7",
    savedOnDisk.running === true && savedOnDisk.everyMin === 7,
    JSON.stringify(savedOnDisk)
  );

  const watchStop = await request("/api/watch/stop", { method: "POST", cookie });
  check("POST /api/watch/stop → running=false", watchStop.status === 200 && watchStop.data.running === false, JSON.stringify(watchStop.data));
  await restartServer();
  admin = await login();
  cookie = admin.cookie ?? cookie;
  const afterStopRestart = await request("/api/watch", { cookie });
  check(
    "после stop+рестарта дежурный не включается сам",
    afterStopRestart.status === 200 && afterStopRestart.data.running === false && afterStopRestart.data.everyMin === 7,
    JSON.stringify(afterStopRestart.data)
  );

  /* ------------------------- 2. новые поля в /api/state ------------------------- */

  const task = "Интеграционная проверка: страница с заголовком и кнопкой";
  const created = await request("/api/runs", { method: "POST", cookie, body: { task } });
  check("прогон создан (201)", created.status === 201 && Boolean(created.data.run?.id), `статус ${created.status}`);
  const runId = created.data.run?.id;
  if (!runId) throw new Error("без id прогона проверять блоки нечего");

  let blocks = [];
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const poll = await request(`/api/runs/${runId}`, { cookie });
    blocks = poll.data.run?.blocks ?? [];
    if (blocks.length) break;
    if (["failed", "cancelled"].includes(poll.data.run?.status)) break;
    await sleep(250);
  }
  check("у созданного прогона появились блоки", blocks.length > 0, `блоков: ${blocks.length}`);
  if (!blocks.length) throw new Error("прогон не дошёл до декомпозиции");

  const state = await request("/api/state", { cookie });
  check("GET /api/state → 200", state.status === 200, `статус ${state.status}`);
  const stateRun = (state.data.runs ?? []).find((r) => r.id === runId);
  check("созданный прогон есть в /api/state", Boolean(stateRun), (state.data.runs ?? []).map((r) => r.id).join(", "));
  const stateBlock = stateRun?.blocks?.[0];
  const BLOCK_FIELDS = ["fallbacks", "needsRecheck", "autoAccepted", "integrityWarnings", "rechecks"];
  check(
    "у блока в /api/state есть все новые поля",
    Boolean(stateBlock) && BLOCK_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(stateBlock, k)),
    stateBlock ? Object.keys(stateBlock).join(", ") : "блока нет"
  );
  check(
    "типы новых полей блока в /api/state корректны",
    Boolean(stateBlock) &&
      Number.isFinite(Number(stateBlock.fallbacks)) &&
      typeof stateBlock.needsRecheck === "boolean" &&
      typeof stateBlock.autoAccepted === "boolean" &&
      Array.isArray(stateBlock.integrityWarnings) &&
      Number.isFinite(Number(stateBlock.rechecks)),
    JSON.stringify(stateBlock)
  );
  check("у прогона в /api/state есть fallbacks", Number.isFinite(Number(stateRun?.fallbacks)), String(stateRun?.fallbacks));

  const fixtureRun = (state.data.runs ?? []).find((r) => r.id === FIXTURE_ID);
  const fixtureBlock = fixtureRun?.blocks?.[0];
  check(
    "фикстур: /api/state отдаёт значения fallbacks/needsRecheck/autoAccepted/rechecks",
    Boolean(fixtureBlock) &&
      fixtureBlock.fallbacks === 2 &&
      fixtureBlock.needsRecheck === true &&
      fixtureBlock.autoAccepted === true &&
      fixtureBlock.rechecks === 1,
    JSON.stringify(fixtureBlock)
  );
  check(
    "фикстур: /api/state отдаёт предупреждения целостности",
    Array.isArray(fixtureBlock?.integrityWarnings) && fixtureBlock.integrityWarnings.includes(FIXTURE_WARNING),
    JSON.stringify(fixtureBlock?.integrityWarnings)
  );
  check("фикстур: fallbacks прогона в /api/state", fixtureRun?.fallbacks === 3, String(fixtureRun?.fallbacks));

  const fixtureSnapshot = await request(`/api/runs/${FIXTURE_ID}`, { cookie });
  const snapBlock = fixtureSnapshot.data.run?.blocks?.[0];
  check(
    "snapshot(): новые поля блока не потерялись",
    fixtureSnapshot.status === 200 &&
      snapBlock?.fallbacks === 2 &&
      snapBlock?.needsRecheck === true &&
      snapBlock?.autoAccepted === true &&
      snapBlock?.rechecks === 1 &&
      snapBlock?.integrityWarnings?.[0] === FIXTURE_WARNING,
    JSON.stringify(snapBlock)
  );
  check("snapshot(): manual.auto=true (подпись «принят автоматически»)", snapBlock?.manual?.auto === true && snapBlock?.manual?.decision === "accept", JSON.stringify(snapBlock?.manual));
  check("snapshot(): fallbacks прогона", fixtureSnapshot.data.run?.fallbacks === 3, String(fixtureSnapshot.data.run?.fallbacks));

  /* ------------------------- 3. check-dom с каталогом ------------------------- */

  const domDir = path.join(tmp, "dom-fixture");
  fs.mkdirSync(domDir, { recursive: true });
  fs.writeFileSync(path.join(domDir, "index.html"), '<!doctype html><html><body><div id="probeTarget"></div></body></html>\n', "utf8");
  fs.writeFileSync(path.join(domDir, "app.js"), 'const a = $("#probeTarget");\nconst b = $("#probeMissing");\n', "utf8");
  const domScript = path.join(ROOT, "scripts", "check-dom.mjs");

  const dom = await runNode([domScript, domDir]);
  check("check-dom <dir> → exit 0", dom.code === 0, `код ${dom.code}`);
  check(
    "check-dom <dir> читает переданный каталог (ids used: 2, ids in html: 1)",
    /ids used:\s*2\s*\|\s*ids in html:\s*1/.test(dom.out),
    dom.out.trim().split(/\r?\n/).slice(0, 4).join(" | ")
  );
  check("check-dom <dir> видит missing из фикстуры (probeMissing)", /missing in html:\s*probeMissing/.test(dom.out), dom.out.trim().split(/\r?\n/).slice(-3).join(" | "));

  const domEmpty = path.join(tmp, "dom-empty");
  fs.mkdirSync(domEmpty, { recursive: true });
  const domMissing = await runNode([domScript, domEmpty]);
  check(
    "check-dom <dir> без index.html → exit 1 и понятное сообщение",
    domMissing.code === 1 && /index\.html не найден/.test(domMissing.out),
    `код ${domMissing.code} · ${domMissing.out.trim().slice(0, 120)}`
  );

  /* ----------------------- 4. check-notepad с каталогом ----------------------- */

  const notepadScript = path.join(ROOT, "scripts", "check-notepad.mjs");
  const emptyNotepad = path.join(tmp, "notepad-empty");
  fs.mkdirSync(emptyNotepad, { recursive: true });
  const notepadBad = await runNode([notepadScript, emptyNotepad], 60_000);
  check(
    "check-notepad <пустой dir> → exit 1 и видит отсутствие index.html именно там",
    notepadBad.code !== 0 && /file exists: index\.html/.test(notepadBad.out) && new RegExp(emptyNotepad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(notepadBad.out),
    `код ${notepadBad.code} · ${notepadBad.out.trim().split(/\r?\n/).slice(-2).join(" | ")}`
  );

  const realNotepad = path.join(ROOT, "output", "notepad");
  const notepadGood = await runNode([notepadScript, realNotepad], 120_000);
  check(
    "check-notepad <output/notepad> → exit 0, все проверки прошли",
    notepadGood.code === 0 && /Summary:\s*\d+ passed,\s*0 failed/.test(notepadGood.out),
    `код ${notepadGood.code} · ${notepadGood.out.trim().split(/\r?\n/).slice(-2).join(" | ")}`
  );
  check(
    "check-notepad <dir> печатает проверяемый каталог",
    notepadGood.out.includes(realNotepad),
    notepadGood.out.trim().split(/\r?\n/)[0]
  );
} catch (err) {
  exception = err;
  failed = Math.max(failed, 1);
  console.error("FAIL · исключение:", err?.stack || err);
  const log = readServerLog();
  if (log) console.error("--- хвост лога сервера ---\n" + log.slice(-2000));
} finally {
  await stopServer();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* временный каталог мог остаться — на результат не влияет */
  }
}

if (exception) console.error(`\nисключение: ${exception.message}`);
console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
