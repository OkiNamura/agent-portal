/**
 * Проверка ручного управления агентами и помощника настройки.
 *
 * Поднимает свой сервер на PORT=7805 с MOCK=1 и временными каталогами
 * (CONFIG_DIR с копиями agents/pipeline/harness/providers, RUNS_DIR,
 * PROJECTS_FILE, MAILBOX_FILE, USERS_FILE, STUDIO_DIR, SNAPSHOTS_DIR),
 * чтобы не трогать рабочий config/ и данные портала.
 *
 * Сценарии: create (id генерируется), update, duplicate, delete свободного;
 * 409 для coder (стадия конвейера) и assistant (код портала); 403 для
 * editor/viewer; assist в MOCK возвращает все поля и note; агент виден в state.
 *
 * Запуск: node scripts/probe-agents.mjs  (Exit 1 при любом провале)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../lib/auth.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const PORT = 7805;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "XvQ2xTvPrS7z";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};
const short = (data) => (typeof data === "string" ? data : JSON.stringify(data)).slice(0, 300);

/* ----------------------------- временные данные ----------------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-agents-"));
const configDir = path.join(tmp, "config");
const runsDir = path.join(tmp, "runs");
const studioDir = path.join(tmp, "studio");
const snapshotsDir = path.join(tmp, "snapshots");
const usersFile = path.join(tmp, "users.json");
const projectsFile = path.join(tmp, "projects.json");
const mailboxFile = path.join(tmp, "mailbox.json");
const serverLogFile = path.join(tmp, "server.log");

for (const dir of [configDir, runsDir, studioDir, snapshotsDir]) fs.mkdirSync(dir, { recursive: true });
for (const name of ["agents.json", "pipeline.json", "harness.json", "providers.json"]) {
  fs.copyFileSync(path.join(ROOT, "config", name), path.join(configDir, name));
}
// Пустые ключи: MOCK не должен ничего искать в боевом config/keys.json.
fs.writeFileSync(
  path.join(configDir, "keys.json"),
  JSON.stringify({ keys: [], defaultKeyId: null, assign: {}, providers: {} }, null, 2),
  "utf8"
);
// Админ известен заранее — не нужно вылавливать пароль первого запуска из лога.
fs.writeFileSync(
  usersFile,
  JSON.stringify(
    {
      users: [
        {
          id: "u-probe-admin",
          login: ADMIN_LOGIN,
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

const pipeline = JSON.parse(fs.readFileSync(path.join(configDir, "pipeline.json"), "utf8").replace(/^\uFEFF/, ""));

/* -------------------------------- сервер -------------------------------- */

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  MOCK: "1",
  CONFIG_DIR: configDir,
  RUNS_DIR: runsDir,
  PROJECTS_FILE: projectsFile,
  MAILBOX_FILE: mailboxFile,
  USERS_FILE: usersFile,
  STUDIO_DIR: studioDir,
  SNAPSHOTS_DIR: snapshotsDir,
};
delete serverEnv.AUTH_FILE;
delete serverEnv.PORTAL_TOKEN;

const server = (() => {
  const fd = fs.openSync(serverLogFile, "a");
  const child = spawn(NODE, ["server.mjs"], {
    cwd: ROOT,
    env: serverEnv,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
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
  return { status: res.status, data, text, headers: res.headers };
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

const validAgent = (name, extra = {}) => ({
  name,
  role: "Проверка",
  model: "deepseek/deepseek-v3.2",
  temperature: 0.4,
  prompt: `Ты — ${name.toLowerCase()}. Отвечай кратко и по делу.`,
  ...extra,
});

/* -------------------------------- сценарии -------------------------------- */

let exception = null;
try {
  await waitReady();
  check("сервер поднялся на 7805, GET /api/login → 200", true);

  const admin = await login(ADMIN_LOGIN, ADMIN_PASSWORD);
  check("admin входит с известным паролем", admin.res.status === 200 && Boolean(admin.cookie), `статус ${admin.res.status}`);
  if (!admin.cookie) throw new Error("без cookie администратора проверять нечего");
  const cookie = admin.cookie;

  /* 1. создание: id генерируется из имени */
  const createdRes = await request("/api/agents", { method: "POST", cookie, body: validAgent("Тестовый агент") });
  const created = createdRes.data?.agent;
  check("POST /api/agents → 200", createdRes.status === 200, `статус ${createdRes.status} · ${short(createdRes.data)}`);
  check(
    "id сгенерирован из имени (testovyy-agent)",
    Boolean(created) && /^[a-z0-9][a-z0-9-]{0,39}$/.test(created.id) && created.id === "testovyy-agent",
    String(created?.id)
  );
  check("агент сохранён в config/agents.json", Boolean(created) && fs.readFileSync(path.join(configDir, "agents.json"), "utf8").includes(`"id": "${created.id}"`));

  const stateCreated = await request("/api/state", { cookie });
  const inState = (stateCreated.data?.agents?.agents ?? []).find((a) => a.id === created?.id);
  check("созданный агент виден в GET /api/state", Boolean(inState), inState ? `id ${inState.id}` : "не найден");

  /* 2. обновление температуры */
  const updateRes = await request(`/api/agents/${created.id}`, { method: "POST", cookie, body: { temperature: 0.9 } });
  check(
    "POST /api/agents/:id обновляет температуру → 200",
    updateRes.status === 200 && Number(updateRes.data?.agent?.temperature) === 0.9,
    `статус ${updateRes.status} · temperature=${updateRes.data?.agent?.temperature}`
  );
  const stateUpdated = await request("/api/state", { cookie });
  const updated = (stateUpdated.data?.agents?.agents ?? []).find((a) => a.id === created.id);
  check("новая температура видна в GET /api/state", Number(updated?.temperature) === 0.9, String(updated?.temperature));

  /* 3. дублирование */
  const dupRes = await request(`/api/agents/${created.id}/duplicate`, { method: "POST", cookie });
  const copy = dupRes.data?.agent;
  check("POST /api/agents/:id/duplicate → 200", dupRes.status === 200, `статус ${dupRes.status} · ${short(dupRes.data)}`);
  check(
    "копия: имя «… (копия)» и новый id",
    Boolean(copy) && copy.id !== created.id && copy.name === "Тестовый агент (копия)",
    `${copy?.id} · ${copy?.name}`
  );

  /* 4. удаление свободного агента */
  const delFree = copy
    ? await request(`/api/agents/${copy.id}`, { method: "DELETE", cookie })
    : { status: 0, data: { error: "копия не создана" } };
  check(
    "DELETE свободного агента → 200",
    delFree.status === 200 && !(delFree.data?.agents?.agents ?? []).some((a) => a.id === copy?.id),
    `статус ${delFree.status} · ${short(delFree.data?.error ?? "")}`
  );

  /* 5. занятость: стадия конвейера */
  const coderStage = (pipeline.stages ?? []).find((s) => s.agent === "coder");
  const delCoder = await request("/api/agents/coder", { method: "DELETE", cookie });
  check("DELETE агента стадии конвейера (coder) → 409", delCoder.status === 409, `статус ${delCoder.status} · ${short(delCoder.data)}`);
  check(
    "в 409 названа стадия конвейера",
    delCoder.status === 409 && Boolean(coderStage) && String(delCoder.data?.error ?? "").includes(coderStage.title),
    `ожидали «${coderStage?.title}»: ${short(delCoder.data?.error ?? "")}`
  );

  /* 6. занятость: код портала */
  const delAssistant = await request("/api/agents/assistant", { method: "DELETE", cookie });
  check("DELETE assistant (код портала) → 409", delAssistant.status === 409, `статус ${delAssistant.status} · ${short(delAssistant.data)}`);
  check(
    "в 409 объяснено, что агент занят кодом",
    delAssistant.status === 409 && /код портала/i.test(String(delAssistant.data?.error ?? "")),
    short(delAssistant.data?.error ?? "")
  );

  /* 7. помощник в MOCK */
  const agentsBeforeAssist = fs.readFileSync(path.join(configDir, "agents.json"), "utf8");
  const assistRes = await request("/api/agents/assist", {
    method: "POST",
    cookie,
    body: { text: "Нужен агент, который проверяет орфографию и объясняет правки" },
  });
  const proposal = assistRes.data ?? {};
  const fields = ["name", "role", "id", "model", "provider", "temperature", "prompt", "note"];
  check("POST /api/agents/assist → 200", assistRes.status === 200, `статус ${assistRes.status} · ${short(assistRes.data)}`);
  check(
    "assist вернул все поля предложения",
    fields.every((f) => proposal[f] !== undefined && proposal[f] !== null && String(proposal[f]).length > 0),
    fields.filter((f) => proposal[f] === undefined || proposal[f] === "").join(", ") || "все на месте"
  );
  check(
    "assist вернул непустой note",
    typeof proposal.note === "string" && proposal.note.trim().length > 0,
    String(proposal.note ?? "")
  );
  check(
    "assist не пишет в config/agents.json (запись только по «Применить»)",
    fs.readFileSync(path.join(configDir, "agents.json"), "utf8") === agentsBeforeAssist
  );

  const askRes = await request("/api/agents/assist", {
    method: "POST",
    cookie,
    body: { text: "что даёт температура 0.1 против 0.7?", mode: "ask" },
  });
  check(
    "assist mode=ask → текстовый ответ без JSON-полей",
    askRes.status === 200 && typeof askRes.data?.answer === "string" && askRes.data.answer.length > 0 && askRes.data.note === undefined,
    `статус ${askRes.status} · ${short(askRes.data?.answer ?? askRes.data)}`
  );

  /* 8. валидация */
  const badTemp = await request("/api/agents", { method: "POST", cookie, body: validAgent("Плохая температура", { temperature: 3 }) });
  check("temperature 3 → 400", badTemp.status === 400, `статус ${badTemp.status} · ${short(badTemp.data)}`);
  const badProvider = await request("/api/agents", { method: "POST", cookie, body: validAgent("Плохой провайдер", { provider: "nope" }) });
  check("несуществующий провайдер → 400", badProvider.status === 400, `статус ${badProvider.status} · ${short(badProvider.data)}`);
  const dupId = await request("/api/agents", { method: "POST", cookie, body: validAgent("Дубликат id", { id: created.id }) });
  check("дубликат id → 409", dupId.status === 409, `статус ${dupId.status} · ${short(dupId.data)}`);
  const changeId = await request(`/api/agents/${created.id}`, { method: "POST", cookie, body: { id: "drugoy-id" } });
  check("смена id при обновлении → 400", changeId.status === 400, `статус ${changeId.status} · ${short(changeId.data)}`);

  /* 9. роли editor/viewer */
  const viewerPass = "viewer-pass-123";
  const editorPass = "editor-pass-123";
  const mkViewer = await request("/api/users", { method: "POST", cookie, body: { login: "viewer", password: viewerPass, role: "viewer" } });
  const mkEditor = await request("/api/users", { method: "POST", cookie, body: { login: "editor", password: editorPass, role: "editor" } });
  check("admin создаёт viewer и editor", mkViewer.status === 201 && mkEditor.status === 201, `${mkViewer.status}/${mkEditor.status}`);
  const editor = await login("editor", editorPass);
  const viewer = await login("viewer", viewerPass);

  const editorCreate = await request("/api/agents", { method: "POST", cookie: editor.cookie, body: validAgent("Агент редактора") });
  check("editor POST /api/agents → 403", editorCreate.status === 403, `статус ${editorCreate.status} · ${short(editorCreate.data)}`);
  const editorDelete = await request(`/api/agents/${created.id}`, { method: "DELETE", cookie: editor.cookie });
  check("editor DELETE /api/agents/:id → 403", editorDelete.status === 403, `статус ${editorDelete.status} · ${short(editorDelete.data)}`);
  const editorConfig = await request("/api/config", {
    method: "POST",
    cookie: editor.cookie,
    body: { agents: { agents: [] } },
  });
  check("editor POST /api/config с агентами → 403 (нет обхода)", editorConfig.status === 403, `статус ${editorConfig.status} · ${short(editorConfig.data)}`);
  const viewerCreate = await request("/api/agents", { method: "POST", cookie: viewer.cookie, body: validAgent("Агент наблюдателя") });
  check("viewer POST /api/agents → 403", viewerCreate.status === 403, `статус ${viewerCreate.status} · ${short(viewerCreate.data)}`);
  const viewerDelete = await request(`/api/agents/${created.id}`, { method: "DELETE", cookie: viewer.cookie });
  check("viewer DELETE /api/agents/:id → 403", viewerDelete.status === 403, `статус ${viewerDelete.status} · ${short(viewerDelete.data)}`);

  const stateAfterDeny = await request("/api/state", { cookie });
  check(
    "после запрещённых удалений агент на месте",
    (stateAfterDeny.data?.agents?.agents ?? []).some((a) => a.id === created.id)
  );

  /* 10. удаление из state и диска */
  const delCreated = await request(`/api/agents/${created.id}`, { method: "DELETE", cookie });
  const stateFinal = await request("/api/state", { cookie });
  check(
    "DELETE свободного агента убирает его из state",
    delCreated.status === 200 && !(stateFinal.data?.agents?.agents ?? []).some((a) => a.id === created.id),
    `статус ${delCreated.status}`
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
    /* временный каталог мог остаться — на результат проверки не влияет */
  }
}

if (exception) console.error(`\nисключение: ${exception.message}`);
console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
