/**
 * Проверка чата «Презентации» (kind=decks).
 *
 * Поднимает server.mjs на PORT=7800 с временными RUNS_DIR / PROJECTS_FILE /
 * MAILBOX_FILE / USERS_FILE / STUDIO_DIR и MOCK=1. Логинится admin'ом с
 * известным паролем, создаёт чат presentations, просит структуру, проверяет
 * ответ, скачивает .pptx и валидирует ZIP/OOXML по сырым байтам.
 *
 * Сценарии:
 *   1. POST /api/studio/sessions kind=decks → чат создан;
 *   2. POST /api/studio/deck → 200, слайды + имя файла, .pptx реально собран;
 *   3. GET /api/studio/deck/:id.pptx → 200, Content-Type презентации, PK,
 *      > 3000 байт, EOCD, нужные части пакета внутри архива;
 *   4. повторное сообщение → 200, доработка, структура та же (MOCK: 2 слайда),
 *      оба файла разные и целые;
 *   5. viewer не может отправлять (403), admin может.
 *
 * Запуск: node scripts/probe-decks.mjs  (Exit 1 при любом провале)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../lib/auth.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const PORT = 7800;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = "XvQ2xTvPrS7z";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};

/* ------------------------------ временные данные ------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-decks-"));
const runsDir = path.join(tmp, "runs");
const projectsFile = path.join(tmp, "projects.json");
const mailboxFile = path.join(tmp, "mailbox.json");
const usersFile = path.join(tmp, "users.json");
const studioDir = path.join(tmp, "studio");
const serverLogFile = path.join(tmp, "server.log");

fs.mkdirSync(runsDir, { recursive: true });
fs.mkdirSync(studioDir, { recursive: true });

// admin с известным паролем: проверка не зависит от случайного пароля первого запуска
fs.writeFileSync(
  usersFile,
  JSON.stringify(
    {
      users: [
        {
          id: "u-probe-deck-admin",
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

const logFd = fs.openSync(serverLogFile, "a");
const server = spawn(NODE, ["server.mjs"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", logFd, logFd], windowsHide: true });
fs.closeSync(logFd);

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

/** Скачивание бинарника: fetch с cookie, без JSON-разбора. */
async function download(pathname, cookie) {
  const res = await fetch(BASE + pathname, {
    headers: cookie ? { Cookie: cookie } : {},
    signal: AbortSignal.timeout(20_000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}

/** ZIP без сжатия: имена частей лежат в открытом виде, этого достаточно для честной проверки. */
function zipFacts(buf) {
  const eocdOffset = buf.length - 22;
  const eocdOk = eocdOffset >= 0 && buf.readUInt32LE(eocdOffset) === 0x06054b50;
  const entries = eocdOk ? buf.readUInt16LE(eocdOffset + 10) : -1;
  const parts = [
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/slideMasters/slideMaster1.xml",
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    "ppt/slideLayouts/slideLayout1.xml",
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    "ppt/theme/theme1.xml",
    "ppt/slides/slide1.xml",
    "ppt/slides/_rels/slide1.xml.rels",
    "ppt/slides/slide2.xml",
  ];
  return {
    eocdOk,
    entries,
    localHeaderOk: buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50,
    hasPart: (name) => buf.includes(Buffer.from(name, "utf8")),
    missing: parts.filter((name) => !buf.includes(Buffer.from(name, "utf8"))),
  };
}

function deckShape(deck) {
  const slides = Array.isArray(deck?.slides) ? deck.slides : [];
  return {
    count: slides.length,
    valid: slides.every(
      (s) => s && typeof s.title === "string" && s.title.length > 0 && Array.isArray(s.bullets) && s.bullets.every((b) => typeof b === "string")
    ),
  };
}

/* ------------------------------- сценарии ------------------------------- */

let exception = null;
try {
  await waitReady();
  check("сервер поднялся на 7800", true);

  const admin = await login("admin", ADMIN_PASSWORD);
  check("admin входит по паролю портала (200)", admin.res.status === 200 && Boolean(admin.cookie), `статус ${admin.res.status}`);
  if (!admin.cookie) throw new Error("без cookie админа проверять нечего");
  const cookie = admin.cookie;

  /* 1. новый чат «Презентации» */
  const created = await request("/api/studio/sessions", {
    method: "POST",
    cookie,
    body: { name: "Презентация для клиента", kind: "decks" },
  });
  check("создание чата kind=decks → 200", created.status === 200 && created.data.session?.kind === "decks", `статус ${created.status}`);
  const sessionId = created.data.session?.id;
  check("у чата есть id", Boolean(sessionId), sessionId ?? "нет");
  if (!sessionId) throw new Error("чат не создан");

  const list = await request("/api/studio/sessions?view=all", { cookie });
  check("чат виден в списке с kind=decks", (list.data.sessions ?? []).some((s) => s.id === sessionId && s.kind === "decks"));

  /* 2. первая структура + .pptx */
  const first = await request("/api/studio/deck", {
    method: "POST",
    cookie,
    body: { sessionId, slideCount: 5, text: "Сделай презентацию на 5 слайдов про запуск нового продукта для инвесторов" },
  });
  check("POST /api/studio/deck → 200", first.status === 200, `статус ${first.status} · ${String(first.data.error ?? "")}`);
  const msg1 = first.data.message;
  check("ответ содержит сообщение-презентацию", msg1?.role === "deck", `role=${msg1?.role ?? "нет"}`);
  const shape1 = deckShape(msg1);
  check("в сообщении есть слайды с заголовками и пунктами", shape1.valid && shape1.count === 2, `слайдов ${shape1.count}`);
  check("MOCK всегда отдаёт 2 слайда", shape1.count === 2, `слайдов ${shape1.count}`);
  check("в сообщении есть имя .pptx-файла", typeof msg1?.file === "string" && msg1.file.endsWith(".pptx"), String(msg1?.file ?? "нет"));
  check("в ответе есть thread с запросом и презентацией", Array.isArray(first.data.thread) && first.data.thread.filter((m) => m.role === "deck").length === 1);

  const diskFile = msg1?.file ? path.join(studioDir, msg1.file) : null;
  const diskOk = Boolean(diskFile && fs.existsSync(diskFile));
  check("файл .pptx сохранён в каталоге студии", diskOk, diskFile ?? "нет");
  const diskSize = diskOk ? fs.statSync(diskFile).size : 0;
  check("файл на диске > 3000 байт", diskSize > 3000, `${diskSize} байт`);
  check("заголовок презентации непустой", typeof msg1?.title === "string" && msg1.title.length > 2, String(msg1?.title ?? "нет"));

  /* 3. скачивание и проверка ZIP/OOXML */
  const dl1 = await download(`/api/studio/deck/${msg1.id}.pptx`, cookie);
  check("GET /api/studio/deck/:id.pptx → 200", dl1.status === 200, `статус ${dl1.status}`);
  check(
    "Content-Type — презентация PowerPoint",
    /application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation/.test(String(dl1.headers.get("content-type") ?? "")),
    String(dl1.headers.get("content-type") ?? "")
  );
  check(
    "Content-Disposition — вложение .pptx",
    /attachment/.test(String(dl1.headers.get("content-disposition") ?? "")) && /\.pptx/.test(String(dl1.headers.get("content-disposition") ?? "")),
    String(dl1.headers.get("content-disposition") ?? "")
  );
  check("скачанный файл начинается с PK", dl1.buf.length > 2 && dl1.buf.subarray(0, 2).toString("latin1") === "PK");
  check("скачанный файл > 3000 байт", dl1.buf.length > 3000, `${dl1.buf.length} байт`);
  const zip1 = zipFacts(dl1.buf);
  check("EOCD найден в конце архива", zip1.eocdOk);
  check("local file header на месте", zip1.localHeaderOk);
  check("в архиве есть записи", zip1.entries >= 15, `записей ${zip1.entries}`);
  check("в архиве есть ключевые части OOXML", zip1.missing.length === 0, zip1.missing.length ? `нет: ${zip1.missing.join(", ")}` : "все на месте");

  const noAuth = await download(`/api/studio/deck/${msg1.id}.pptx`, null);
  check("без сессии скачать нельзя (401)", noAuth.status === 401, `статус ${noAuth.status}`);

  /* 4. повторное сообщение — доработка, структура та же */
  const second = await request("/api/studio/deck", {
    method: "POST",
    cookie,
    body: { sessionId, text: "Добавь слайд про бюджет и сделай заголовки короче" },
  });
  check("повторное сообщение → 200", second.status === 200, `статус ${second.status} · ${String(second.data.error ?? "")}`);
  const msg2 = second.data.message;
  const shape2 = deckShape(msg2);
  check("MOCK на доработку снова отдаёт 2 слайда", shape2.count === 2, `слайдов ${shape2.count}`);
  check("структура слайдов та же (title + bullets)", shape2.valid);
  check("второй .pptx — отдельный файл", typeof msg2?.file === "string" && msg2.file !== msg1.file, `${msg1.file} → ${msg2?.file}`);
  check("в переписке две презентации", (second.data.thread ?? []).filter((m) => m.role === "deck").length === 2);
  check("второй запрос пользователя сохранён в thread", (second.data.thread ?? []).some((m) => m.role === "user" && /бюджет/.test(String(m.text ?? ""))));

  const dl2 = await download(`/api/studio/deck/${msg2.id}.pptx`, cookie);
  check("второй .pptx скачивается (200, PK)", dl2.status === 200 && dl2.buf.subarray(0, 2).toString("latin1") === "PK", `статус ${dl2.status}`);
  check("второй .pptx > 3000 байт", dl2.buf.length > 3000, `${dl2.buf.length} байт`);
  check("оба файла лежат в студии", [msg1.file, msg2.file].every((f) => fs.existsSync(path.join(studioDir, f))));

  /* 5. роли: viewer только читает, admin отправляет */
  const viewerPass = "viewer-pass-123";
  const createViewer = await request("/api/users", {
    method: "POST",
    cookie,
    body: { login: "probe-deck-viewer", password: viewerPass, role: "viewer" },
  });
  check("admin создаёт viewer", createViewer.status === 201, `статус ${createViewer.status}`);
  const viewer = await login("probe-deck-viewer", viewerPass);
  check("viewer входит", viewer.res.status === 200 && Boolean(viewer.cookie));

  const viewerSend = await request("/api/studio/deck", {
    method: "POST",
    cookie: viewer.cookie,
    body: { sessionId, text: "Попробуй собрать презентацию" },
  });
  check("viewer не может отправлять в презентации (403)", viewerSend.status === 403, `статус ${viewerSend.status}`);
  const viewerRead = await request(`/api/studio/thread?session=${encodeURIComponent(sessionId)}`, { cookie: viewer.cookie });
  check("viewer читает переписку (200)", viewerRead.status === 200, `статус ${viewerRead.status}`);

  const adminAgain = await request("/api/studio/deck", {
    method: "POST",
    cookie,
    body: { sessionId, text: "Ещё раз: сделай акцент на сроках" },
  });
  check("admin по-прежнему может отправлять (200)", adminAgain.status === 200, `статус ${adminAgain.status}`);

  /* 6. чужой тип чата: понятная ошибка, а не 500 */
  const docs = await request("/api/studio/sessions", { method: "POST", cookie, body: { name: "Документы", kind: "docs" } });
  const wrongKind = await request("/api/studio/deck", {
    method: "POST",
    cookie,
    body: { sessionId: docs.data.session?.id, text: "Сделай презентацию" },
  });
  check("презентация в чате docs → 409 с объяснением", wrongKind.status === 409 && typeof wrongKind.data.error === "string", `статус ${wrongKind.status}`);
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
    /* временный каталог мог остаться — не влияет на проверку */
  }
}

if (exception) console.error(`\nисключение: ${exception.message}`);
console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
