/**
 * Проверка авторизации и ролей.
 *
 * Сам поднимает сервер на свободном порту 7791 с временными каталогами,
 * прогоняет сценарии viewer/editor/admin и гасит сервер.
 *
 * Запуск: node scripts/probe-auth.mjs  (Exit 1 при любом провале)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const PORT = Number(process.env.PORT || 7791);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-auth-"));
const usersFile = path.join(tmp, "users.json");
const keysFile = path.join(ROOT, "config", "keys.json");
const keysBackup = fs.existsSync(keysFile) ? fs.readFileSync(keysFile) : null;

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};

/* ------------------------------- запуск сервера ------------------------------- */

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  MOCK: "1", // никаких настоящих вызовов OpenRouter
  RUNS_DIR: path.join(tmp, "runs"),
  PROJECTS_FILE: path.join(tmp, "projects.json"),
  MAILBOX_FILE: path.join(tmp, "mailbox.json"),
  USERS_FILE: usersFile,
};
delete serverEnv.AUTH_FILE;

const server = (() => {
  // Вывод сервера пишем в файл: в песочнице DSH пайпы stdio могут быть недоступны (spawn EPERM).
  const logFile = path.join(tmp, "server.log");
  const fd = fs.openSync(logFile, "a");
  const child = spawn(NODE, ["server.mjs"], {
    cwd: ROOT,
    env: serverEnv,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  return child;
})();

const serverLogFile = path.join(tmp, "server.log");
function readServerLog() {
  try {
    return fs.readFileSync(serverLogFile, "utf8");
  } catch {
    return "";
  }
}

let adminPassword = null;

async function waitReady(ms = 20_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const log = readServerLog();
    if (!adminPassword) {
      const m = log.match(/пароль:\s*([A-Za-z0-9]{6,})/);
      if (m) adminPassword = m[1];
    }
    if (server.exitCode != null) throw new Error(`сервер завершился (код ${server.exitCode})\n${log.slice(-1200)}`);
    try {
      const res = await fetch(`${BASE}/api/login`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return;
    } catch {
      /* ещё не поднялся */
    }
    await sleep(150);
  }
  throw new Error(`сервер не ответил за ${ms} мс\n${readServerLog().slice(-1200)}`);
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

function tokenOf(cookie) {
  return cookie ? cookie.slice("portal_session=".length) : null;
}

async function login(name, password) {
  const res = await request("/api/login", { method: "POST", body: { login: name, password } });
  const cookie = sessionCookie(res);
  return { res, cookie, token: tokenOf(cookie) };
}

/* ------------------------------- сценарии ------------------------------- */

let exception = null;
try {
  await waitReady();
  check("сервер поднялся на 7791, GET /api/login → 200", true);

  const page = await request("/");
  check("страница портала отдаётся без сессии (нужна для формы входа)", page.status === 200 && page.text.includes('id="loginScreen"'), `статус ${page.status}`);

  check("первый запуск напечатал пароль администратора", Boolean(adminPassword), adminPassword ? "12 символов" : "строки «пароль:» в логе нет");
  check("пароль администратора длиной 12 символов", (adminPassword ?? "").length === 12, String((adminPassword ?? "").length));
  if (!adminPassword) throw new Error("без пароля первого админа проверять нечего");

  /* 1. без cookie — 401 */
  const anon = await request("/api/state");
  check("без cookie GET /api/state → 401 «нужен вход»", anon.status === 401 && anon.data.error === "нужен вход", `${anon.status} · ${JSON.stringify(anon.data)}`);

  const sseAnon = await request("/api/runs/nope/events");
  check("без cookie SSE /events → 401", sseAnon.status === 401, `статус ${sseAnon.status}`);

  /* 2. неверный пароль, затем верный */
  const wrong = await request("/api/login", { method: "POST", body: { login: "admin", password: "definitely-not-the-password" } });
  check("неверный пароль → 401", wrong.status === 401, `статус ${wrong.status}`);

  const adminLogin = await login("admin", adminPassword);
  check("верный пароль → 200", adminLogin.res.status === 200, `статус ${adminLogin.res.status}`);
  check("выдана cookie портала", Boolean(adminLogin.cookie), adminLogin.cookie ?? "cookie нет");

  const rawCookie = setCookies(adminLogin.res).join("\n");
  check(
    "cookie: HttpOnly + SameSite=Strict + Path=/ + Max-Age=43200",
    /HttpOnly/i.test(rawCookie) && /SameSite=Strict/i.test(rawCookie) && /Path=\//.test(rawCookie) && /Max-Age=43200/.test(rawCookie),
    rawCookie.replace(/\n/g, " | ")
  );

  const me = await request("/api/me", { cookie: adminLogin.cookie });
  check("GET /api/me → admin", me.status === 200 && me.data.login === "admin" && me.data.role === "admin", JSON.stringify(me.data));

  const usersOnDisk = JSON.parse(fs.readFileSync(usersFile, "utf8"));
  check(
    "сессия сохранена в users.json с TTL",
    Array.isArray(usersOnDisk.sessions) &&
      usersOnDisk.sessions.some((s) => s.token === adminLogin.token && Number(s.expiresAt) - Date.now() > 11 * 3600_000),
    `сессий: ${usersOnDisk.sessions?.length ?? 0}`
  );
  check("пароль в файле — scrypt-хеш, не открытый текст", /^scrypt\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/.test(usersOnDisk.users[0].passHash));

  /* 3. админ заводит viewer и editor */
  const viewerPass = "viewer-pass-123";
  const editorPass = "editor-pass-123";
  const createViewer = await request("/api/users", { method: "POST", cookie: adminLogin.cookie, body: { login: "viewer", password: viewerPass, role: "viewer" } });
  check("admin создаёт viewer (201)", createViewer.status === 201, JSON.stringify(createViewer.data?.user ?? createViewer.data));
  const createEditor = await request("/api/users", { method: "POST", cookie: adminLogin.cookie, body: { login: "editor", password: editorPass, role: "editor" } });
  check("admin создаёт editor (201)", createEditor.status === 201, JSON.stringify(createEditor.data?.user ?? createEditor.data));

  /* 4. viewer — только GET */
  const viewerLogin = await login("viewer", viewerPass);
  check("viewer входит (200)", viewerLogin.res.status === 200 && Boolean(viewerLogin.cookie));
  const viewerState = await request("/api/state", { cookie: viewerLogin.cookie });
  check("viewer GET /api/state → 200", viewerState.status === 200);
  const viewerRuns = await request("/api/runs", {
    method: "POST",
    cookie: viewerLogin.cookie,
    body: { task: "Проверка роли viewer: запуск должен быть запрещён" },
  });
  check("viewer POST /api/runs → 403", viewerRuns.status === 403, `статус ${viewerRuns.status} · ${JSON.stringify(viewerRuns.data)}`);
  const viewerKeys = await request("/api/keys", { method: "POST", cookie: viewerLogin.cookie, body: { label: "x", key: "sk-or-v1-000000000000000000000000" } });
  check("viewer POST /api/keys → 403", viewerKeys.status === 403, `статус ${viewerKeys.status}`);

  /* 5. editor — прогоны можно, ключи нельзя, проекты удалять нельзя */
  const editorLogin = await login("editor", editorPass);
  check("editor входит (200)", editorLogin.res.status === 200 && Boolean(editorLogin.cookie));
  const editorRuns = await request("/api/runs", {
    method: "POST",
    cookie: editorLogin.cookie,
    body: { task: "Проверка роли editor: прогон должен создаться" },
  });
  check("editor POST /api/runs → 201", editorRuns.status === 201, `статус ${editorRuns.status} · ${JSON.stringify(editorRuns.data?.run?.id ?? editorRuns.data)}`);
  const editorRunId = editorRuns.data?.run?.id;
  const editorKeys = await request("/api/keys", { method: "POST", cookie: editorLogin.cookie, body: { label: "x", key: "sk-or-v1-000000000000000000000000" } });
  check("editor POST /api/keys → 403", editorKeys.status === 403, `статус ${editorKeys.status}`);
  const editorProject = await request("/api/projects", { method: "POST", cookie: editorLogin.cookie, body: { name: "probe", task: "Проект для проверки запрета удаления" } });
  check("editor POST /api/projects → 201", editorProject.status === 201, `статус ${editorProject.status}`);
  const editorDelete = await request(`/api/projects/${editorProject.data?.project?.id}`, { method: "DELETE", cookie: editorLogin.cookie });
  check("editor DELETE /api/projects/:id → 403", editorDelete.status === 403, `статус ${editorDelete.status}`);

  /* 6. SSE: токен в query */
  if (editorRunId && editorLogin.token) {
    const controller = new AbortController();
    const sse = await fetch(`${BASE}/api/runs/${editorRunId}/events?token=${editorLogin.token}`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    check(
      "SSE с ?token= (без cookie) → 200 text/event-stream",
      sse.status === 200 && /text\/event-stream/.test(sse.headers.get("content-type") ?? ""),
      `${sse.status} · ${sse.headers.get("content-type")}`
    );
    await sse.body?.cancel().catch(() => {});
    controller.abort();
  } else {
    check("SSE с ?token= (без cookie) → 200 text/event-stream", false, "нет runId или токена editor");
  }

  if (editorRunId && editorLogin.cookie) {
    const controller = new AbortController();
    const sse = await fetch(`${BASE}/api/runs/${editorRunId}/events`, {
      signal: controller.signal,
      headers: { Cookie: editorLogin.cookie, Accept: "text/event-stream" },
    });
    check(
      "SSE по cookie (как EventSource из браузера) → 200",
      sse.status === 200 && /text\/event-stream/.test(sse.headers.get("content-type") ?? ""),
      `${sse.status} · ${sse.headers.get("content-type")}`
    );
    await sse.body?.cancel().catch(() => {});
    controller.abort();
  } else {
    check("SSE по cookie (как EventSource из браузера) → 200", false, "нет runId или cookie editor");
  }

  /* 7. admin может менять ключи */
  const adminKeys = await request("/api/keys", {
    method: "POST",
    cookie: adminLogin.cookie,
    body: { label: "probe-auth", key: "sk-or-v1-0000000000000000000000000000000000000000000000", limitDaily: 0 },
  });
  check("admin POST /api/keys → 200", adminKeys.status === 200, `статус ${adminKeys.status} · ${JSON.stringify(adminKeys.data?.error ?? "")}`);

  const usersList = await request("/api/users", { cookie: adminLogin.cookie });
  check("admin GET /api/users → 200", usersList.status === 200 && Array.isArray(usersList.data.users), `пользователей: ${usersList.data?.users?.length ?? 0}`);

  /* 8. logout инвалидирует сессию */
  const logout = await request("/api/logout", { method: "POST", cookie: adminLogin.cookie });
  check("POST /api/logout → 200", logout.status === 200, `статус ${logout.status}`);
  const afterLogout = await request("/api/state", { cookie: adminLogin.cookie });
  check("после logout GET /api/state → 401", afterLogout.status === 401, `статус ${afterLogout.status}`);
  const meAfterLogout = await request("/api/me", { cookie: adminLogin.cookie });
  check("после logout GET /api/me → 401", meAfterLogout.status === 401, `статус ${meAfterLogout.status}`);
  const sessionsAfter = JSON.parse(fs.readFileSync(usersFile, "utf8")).sessions ?? [];
  check("токен удалён из файла сессий", !sessionsAfter.some((s) => s.token === adminLogin.token), `сессий осталось: ${sessionsAfter.length}`);
} catch (err) {
  exception = err;
  failed = Math.max(failed, 1);
  console.error("FAIL · исключение:", err?.stack || err);
  const log = readServerLog();
  if (log) console.error("--- хвост лога сервера ---\n" + log.slice(-2000));
} finally {
  await stopServer();
  try {
    if (keysBackup) fs.writeFileSync(keysFile, keysBackup);
    else if (fs.existsSync(keysFile)) fs.rmSync(keysFile, { force: true });
  } catch (err) {
    console.error("не удалось восстановить config/keys.json:", err.message);
    failed = Math.max(failed, 1);
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* временный каталог мог остаться — не влияет на проверку */
  }
}

if (exception) console.error(`\nисключение: ${exception.message}`);
console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
