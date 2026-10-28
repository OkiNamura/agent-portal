/**
 * Проверка настраиваемых провайдеров (OpenAI-совместимые шлюзы).
 *
 * Поднимает:
 *   - mock-сервер на 127.0.0.1:7804 (обычный http.createServer) с /v1/models,
 *     /v1/chat/completions и /v1/images/generations (b64 1×1 PNG);
 *   - сам портал на 127.0.0.1:7803 с временными CONFIG_DIR / RUNS_DIR /
 *     STUDIO_DIR / USERS_FILE / SNAPSHOTS_DIR.
 *
 * Проверяет: добавление провайдера через API, GET /api/providers без ключей,
 * POST /:id/test (2 модели), вызов агента с provider=local (запрос реально
 * пришёл на 7804), картинку через /images/generations и удаление провайдера.
 *
 * Запуск: node scripts/probe-providers.mjs  (Exit 1 при любом провале)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const PORT = 7803;
const MOCK_PORT = 7804;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};

const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex"
);

/* ------------------------------ временные данные ------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-providers-"));
const configDir = path.join(tmp, "config");
const runsDir = path.join(tmp, "runs");
const studioDir = path.join(tmp, "studio");
const snapshotsDir = path.join(tmp, "snapshots");
const usersFile = path.join(tmp, "users.json");
const serverLogFile = path.join(tmp, "server.log");
const providersFile = path.join(configDir, "providers.json");
const keysFile = path.join(configDir, "keys.json");

for (const dir of [configDir, runsDir, studioDir, snapshotsDir]) fs.mkdirSync(dir, { recursive: true });

// Конфиг агентов: assistant и artist ходят в локальный провайдер local.
const agents = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "agents.json"), "utf8"));
for (const agent of agents.agents ?? []) {
  if (agent.id === "assistant") {
    agent.provider = "local";
    agent.model = "mock/alpha";
  }
  if (agent.id === "artist") {
    agent.provider = "local";
    agent.model = "mock/alpha";
  }
}
fs.writeFileSync(path.join(configDir, "agents.json"), JSON.stringify(agents, null, 2), "utf8");
fs.copyFileSync(path.join(ROOT, "config", "pipeline.json"), path.join(configDir, "pipeline.json"));
fs.copyFileSync(path.join(ROOT, "config", "harness.json"), path.join(configDir, "harness.json"));
// Провайдеров пока нет — добавим через API, как это сделает пользователь.
fs.writeFileSync(
  providersFile,
  JSON.stringify(
    {
      providers: [
        {
          id: "openrouter",
          name: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          kind: "openrouter",
          apiKeyEnv: "OPENROUTER_API_KEY",
          enabled: true,
        },
      ],
      default: "openrouter",
    },
    null,
    2
  ),
  "utf8"
);

/* -------------------------------- mock-сервер -------------------------------- */

const mockRequests = [];

function jsonReply(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const mockServer = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    json = null;
  }
  mockRequests.push({ method: req.method, url: req.url, headers: req.headers, body: json });

  if (req.method === "GET" && req.url === "/v1/models") {
    return jsonReply(res, 200, {
      object: "list",
      data: [
        { id: "mock/alpha", name: "Mock Alpha", object: "model" },
        { id: "mock/beta", name: "Mock Beta", object: "model" },
      ],
    });
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const user = json?.messages?.find((m) => m.role === "user")?.content ?? "";
    return jsonReply(res, 200, {
      id: "chatcmpl-mock",
      object: "chat.completion",
      model: json?.model ?? "mock/alpha",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: `ответ от mock: ${String(user).slice(0, 80)}` },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }

  if (req.method === "POST" && req.url === "/v1/images/generations") {
    return jsonReply(res, 200, {
      created: Math.floor(Date.now() / 1000),
      model: json?.model ?? "mock/image",
      data: [{ b64_json: png.toString("base64") }],
    });
  }

  return jsonReply(res, 404, { error: { message: `mock: нет ${req.method} ${req.url}` } });
});

async function startMock() {
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(new Error(`mock-сервер не занял ${MOCK_PORT}: ${err.message}`));
    mockServer.once("error", onError);
    mockServer.listen(MOCK_PORT, "127.0.0.1", () => {
      mockServer.off("error", onError);
      resolve();
    });
  });
}

async function stopMock() {
  await new Promise((resolve) => mockServer.close(() => resolve()));
}

/* ------------------------------- запуск портала ------------------------------- */

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  CONFIG_DIR: configDir,
  RUNS_DIR: runsDir,
  PROJECTS_FILE: path.join(tmp, "projects.json"),
  MAILBOX_FILE: path.join(tmp, "mailbox.json"),
  USERS_FILE: usersFile,
  STUDIO_DIR: studioDir,
  SNAPSHOTS_DIR: snapshotsDir,
  // Пустая строка важнее .env: loadEnv не перезаписывает уже заданные значения
  OPENROUTER_API_KEY: "",
};
delete serverEnv.MOCK;
delete serverEnv.AUTH_FILE;

let server = null;

function readServerLog() {
  try {
    return fs.readFileSync(serverLogFile, "utf8");
  } catch {
    return "";
  }
}

function startPortal() {
  const fd = fs.openSync(serverLogFile, "a");
  server = spawn(NODE, ["server.mjs"], {
    cwd: ROOT,
    env: serverEnv,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
}

async function stopPortal() {
  if (!server || server.exitCode != null) return;
  server.kill();
  const started = Date.now();
  while (server.exitCode == null && Date.now() - started < 5000) await sleep(100);
  if (server.exitCode == null) server.kill("SIGKILL");
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
    if (server.exitCode != null) throw new Error(`сервер завершился (код ${server.exitCode})\n${log.slice(-1500)}`);
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

/* ------------------------------- HTTP-хелперы ------------------------------- */

async function request(pathname, { method = "GET", cookie, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
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

const requestsTo = (needle, method = null) =>
  mockRequests.filter((r) => r.url === needle && (!method || r.method === method));

/* -------------------------------- сценарии -------------------------------- */

let exception = null;
let logTail = "";
try {
  await startMock();
  check("mock-сервер слушает 7804", true);
  startPortal();
  await waitReady();
  check("портал поднялся на 7803", true);
  if (!adminPassword) throw new Error("в логе сервера нет пароля первого администратора");

  const admin = await login("admin", adminPassword);
  check("admin входит (200)", admin.res.status === 200 && Boolean(admin.cookie), `статус ${admin.res.status}`);
  if (!admin.cookie) throw new Error("без cookie админа проверять нечего");
  const cookie = admin.cookie;

  /* 1. исходный список провайдеров */
  const initial = await request("/api/providers", { cookie });
  check("GET /api/providers → 200", initial.status === 200, `статус ${initial.status}`);
  check(
    "есть openrouter по умолчанию",
    (initial.data.providers ?? []).some((p) => p.id === "openrouter" && p.isDefault),
    JSON.stringify(initial.data.providers?.map((p) => p.id))
  );

  /* 2. добавление локального провайдера через API */
  const added = await request("/api/providers", {
    method: "POST",
    cookie,
    body: {
      id: "local",
      name: "Mock Local",
      baseUrl: `${MOCK_BASE}/v1`,
      kind: "openai",
      apiKey: "local-secret",
      enabled: true,
    },
  });
  check(
    "POST /api/providers → 201, провайдер добавлен",
    added.status === 201 && added.data.provider?.id === "local" && added.data.provider?.kind === "openai",
    `статус ${added.status} · ${JSON.stringify(added.data.error ?? added.data.provider)}`
  );
  check("у добавленного провайдера ключ распознан (hasKey)", added.data.provider?.hasKey === true);

  const listed = await request("/api/providers", { cookie });
  check(
    "GET /api/providers показывает local без ключа в ответе",
    (listed.data.providers ?? []).some((p) => p.id === "local") && !JSON.stringify(listed.data).includes("local-secret"),
    JSON.stringify(listed.data.providers?.find((p) => p.id === "local"))
  );

  /* 3. ключ — в keys.json, не в providers.json */
  const providersOnDisk = JSON.parse(fs.readFileSync(providersFile, "utf8"));
  check("providers.json не содержит ключ", !JSON.stringify(providersOnDisk).includes("local-secret"));
  check(
    "providers.json содержит local с baseUrl/kind",
    providersOnDisk.providers?.some((p) => p.id === "local" && p.baseUrl === `${MOCK_BASE}/v1` && p.kind === "openai")
  );
  const keysOnDisk = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, "utf8")) : {};
  check("ключ провайдера сохранён в keys.json", keysOnDisk.providers?.local === "local-secret", JSON.stringify(keysOnDisk.providers));

  /* 4. обновление провайдера */
  const updated = await request("/api/providers/local", { method: "POST", cookie, body: { name: "Mock Local 2" } });
  check(
    "POST /api/providers/:id обновляет имя и сохраняет ключ",
    updated.status === 200 && updated.data.provider?.name === "Mock Local 2" && updated.data.provider?.hasKey === true,
    JSON.stringify(updated.data.provider ?? updated.data.error)
  );

  /* 5. проверка связи: 2 модели и время */
  const tested = await request("/api/providers/local/test", { method: "POST", cookie });
  check(
    "POST /api/providers/:id/test → ok, 2 модели, ms",
    tested.status === 200 && tested.data.ok === true && tested.data.models?.length === 2 && typeof tested.data.ms === "number",
    JSON.stringify({ ok: tested.data.ok, models: tested.data.models, ms: tested.data.ms, error: tested.data.error })
  );
  check("test вернул mock/alpha", (tested.data.models ?? []).includes("mock/alpha"));
  const modelRequests = requestsTo("/v1/models", "GET");
  check("mock получил GET /v1/models с ключом", modelRequests.length >= 1 && /^Bearer local-secret$/.test(modelRequests.at(-1).headers.authorization ?? ""), modelRequests.at(-1)?.headers.authorization ?? "нет Authorization");
  check("test неизвестного провайдера → 404", (await request("/api/providers/nope/test", { method: "POST", cookie })).status === 404);

  /* 5б. список моделей для редактора агента — из /models этого провайдера */
  const providerModels = await request("/api/models?provider=local", { cookie });
  check(
    "GET /api/models?provider=local берёт модели из провайдера",
    providerModels.status === 200 &&
      providerModels.data.provider === "local" &&
      (providerModels.data.models ?? []).some((m) => m.id === "mock/alpha"),
    JSON.stringify({ provider: providerModels.data.provider, models: providerModels.data.models?.map((m) => m.id), error: providerModels.data.error })
  );

  /* 6. агент с provider=local реально вызывает 7804 */
  const assistant = await request("/api/assistant", {
    method: "POST",
    cookie,
    body: { question: "Проверка провайдера: ответь коротко" },
  });
  check(
    "агент с provider=local ответил через mock",
    assistant.status === 200 && String(assistant.data.answer ?? "").includes("ответ от mock"),
    `статус ${assistant.status} · ${JSON.stringify(assistant.data).slice(0, 200)}`
  );
  const chatRequests = requestsTo("/v1/chat/completions", "POST");
  check("запрос пришёл на 7804 (chat/completions)", chatRequests.length >= 1, `запросов: ${chatRequests.length}`);
  check(
    "модель агента ушла в mock (mock/alpha) с ключом провайдера",
    chatRequests.at(-1)?.body?.model === "mock/alpha" && /^Bearer local-secret$/.test(chatRequests.at(-1)?.headers?.authorization ?? ""),
    JSON.stringify({ model: chatRequests.at(-1)?.body?.model, auth: chatRequests.at(-1)?.headers?.authorization })
  );

  /* 7. картинка через провайдера (artist.provider=local) */
  const image = await request("/api/studio/generate", {
    method: "POST",
    cookie,
    body: { prompt: "кот в космосе", model: "mock/image", aspectRatio: "1:1" },
  });
  check(
    "POST /api/studio/generate вернул картинку",
    image.status === 200 && Boolean(image.data.item?.file) && image.data.item?.mediaType === "image/png",
    `статус ${image.status} · ${JSON.stringify(image.data).slice(0, 240)}`
  );
  const imageRequests = requestsTo("/v1/images/generations", "POST");
  check("запрос картинки пришёл на 7804 (images/generations)", imageRequests.length >= 1, `запросов: ${imageRequests.length}`);
  check(
    "в теле картинки есть model/prompt/size",
    imageRequests.at(-1)?.body?.model === "mock/image" &&
      imageRequests.at(-1)?.body?.prompt === "кот в космосе" &&
      imageRequests.at(-1)?.body?.size === "1024x1024",
    JSON.stringify(imageRequests.at(-1)?.body)
  );
  if (image.data.item?.file) {
    const stored = fs.readFileSync(path.join(studioDir, image.data.item.file));
    check("файл картинки совпадает с b64 из mock (1×1 PNG)", stored.equals(png), `${stored.length} байт`);
  }

  /* 8. удаление провайдера */
  const removed = await request("/api/providers/local", { method: "DELETE", cookie });
  check("DELETE /api/providers/:id → 200", removed.status === 200, `статус ${removed.status} · ${JSON.stringify(removed.data.error)}`);
  const afterDelete = await request("/api/providers", { cookie });
  check("после удаления local исчез", !(afterDelete.data.providers ?? []).some((p) => p.id === "local"));
  const keysAfter = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, "utf8")) : {};
  check("ключ удалённого провайдера убран из keys.json", !keysAfter.providers?.local);
} catch (err) {
  exception = err;
  console.error("исключение:", err?.stack || err);
} finally {
  await stopPortal().catch(() => {});
  await stopMock().catch(() => {});
  if (failed || exception) logTail = readServerLog().slice(-3000);
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  } catch (err) {
    console.error("temp не удалился:", err?.message || err);
  }
}

if (exception && failed === 0) failed = 1;
if (failed) {
  console.log(`\nПровал: ${failed} проверок.`);
  if (logTail) console.log(`\nЛог сервера (хвост):\n${logTail}`);
  process.exit(1);
}
console.log("\nВсе проверки провайдеров пройдены.");
process.exit(0);
