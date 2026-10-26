/**
 * Проверка «закалки» портала: rate-limit входа, защита статики прогонов и студии,
 * потоковый экспорт ZIP.
 *
 * Поднимает server.mjs на 7798 с временными RUNS_DIR / PROJECTS_FILE / MAILBOX_FILE /
 * USERS_FILE / STUDIO_DIR, MOCK=1 и PORTAL_TOKEN. Первый сервер проверяет лимиты
 * 5/5мин и сброс счётчика успешным входом; второй (TRUST_PROXY=1, LOGIN_MAX_5M=100)
 * — часовой лимит 20 и то, что IP берётся из x-forwarded-for только за прокси.
 *
 * Запуск: node scripts/probe-hardening.mjs  (Exit 1 при любом провале)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { crc32 } from "../lib/zip.mjs";
import { zipStream } from "../lib/zip-pack.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const PORT = 7798;
const BASE = `http://127.0.0.1:${PORT}`;
const PORTAL_TOKEN = "hardening-portal-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};

/* ------------------------------ временные данные ------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-hardening-"));
const runsDir = path.join(tmp, "runs");
const projectsFile = path.join(tmp, "projects.json");
const mailboxFile = path.join(tmp, "mailbox.json");
const usersFile = path.join(tmp, "users.json");
const studioDir = path.join(tmp, "studio");
const serverLogFile = path.join(tmp, "server.log");
const serverLog2File = path.join(tmp, "server2.log");

const runId = "20260101-000002-hardening";
const projectId = "p-hardening";
const now = new Date().toISOString();
const task = "Проверка hardening: потоковый ZIP и защита статики";

const APP_MARKER = "HARDENING-APP-MARKER";
const MOCKUP_MARKER = "HARDENING-MOCKUP-MARKER";
const appHtml = `<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><title>hardening</title><link rel="stylesheet" href="styles.css"></head><body><h1>${APP_MARKER}</h1></body></html>\n`;
const mockupHtml = `<!doctype html>\n<html lang="ru"><body><p>${MOCKUP_MARKER}</p></body></html>\n`;

/* 320 КБ: файл заведомо больше одного блока чтения (64 КБ) */
const bigSize = 320 * 1024;
const big = Buffer.alloc(bigSize);
for (let i = 0; i < big.length; i++) big[i] = (i * 37 + 11) & 0xff;

const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex"
);

function prepareFixtures() {
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(studioDir, { recursive: true });

  /* студия: одна картинка за входом */
  fs.writeFileSync(path.join(studioDir, "hard.png"), png);
  fs.writeFileSync(
    path.join(studioDir, "index.json"),
    JSON.stringify(
      {
        items: [
          {
            id: "img-hard",
            at: now,
            prompt: "проверка защиты статики",
            model: "test/model",
            aspectRatio: "1:1",
            quality: "auto",
            mediaType: "image/png",
            file: "hard.png",
            size: png.length,
            cost: 0.01,
            ms: 0,
            ref: null,
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  /* проект + завершённый прогон с файлами */
  fs.writeFileSync(
    projectsFile,
    JSON.stringify(
      {
        projects: [
          { id: projectId, name: "Проверка hardening", task, createdAt: now, updatedAt: now, runIds: [runId] },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(path.join(runDir, "artifacts", "work", "data"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "artifacts", "blocks", "b1"), { recursive: true });

  const run = {
    id: runId,
    task,
    change: null,
    baseId: null,
    projectId,
    createdAt: now,
    updatedAt: now,
    status: "done",
    stageIndex: 0,
    awaiting: null,
    plan: { title: "Проверка hardening", blocks: [{ id: "b1", title: "Отдать проект", goal: "ZIP и превью", acceptance: [] }] },
    blocks: [{ id: "b1", title: "Отдать проект", goal: "ZIP и превью", status: "verified", files: [], test: null, fixes: [], history: [] }],
    approvals: {},
    stageMeta: {},
    workspace: { "index.html": appHtml },
    usage: { prompt: 0, completion: 0, cost: 0.42, calls: 1 },
    error: null,
    eventSeq: 0,
    events: [],
  };
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ ...run, events: undefined }, null, 2), "utf8");

  fs.writeFileSync(path.join(runDir, "artifacts", "work", "index.html"), appHtml, "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "work", "styles.css"), "h1 { color: #246; }\n", "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "work", "data", "blob.bin"), big);
  fs.writeFileSync(path.join(runDir, "artifacts", "mockup.html"), mockupHtml, "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "blocks", "b1", "spec.md"), "# Спека блока b1\n", "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "blocks", "b1", "test-1.md"), "# Проверка\n\npass\n", "utf8");
}

prepareFixtures();

/* ------------------------------- запуск сервера ------------------------------- */

const children = [];

function startServer({ env, logFile }) {
  const base = { ...process.env };
  for (const key of ["AUTH_FILE", "TRUST_PROXY", "LOGIN_MAX_5M", "LOGIN_MAX_1H"]) delete base[key];
  const serverEnv = {
    ...base,
    ...env,
    PORT: String(PORT),
    MOCK: "1",
    RUNS_DIR: runsDir,
    PROJECTS_FILE: projectsFile,
    MAILBOX_FILE: mailboxFile,
    USERS_FILE: usersFile,
    STUDIO_DIR: studioDir,
  };
  // Вывод сервера — в файл: в песочнице DSH пайпы stdio могут быть недоступны (spawn EPERM).
  const fd = fs.openSync(logFile, "a");
  const child = spawn(NODE, ["server.mjs"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", fd, fd], windowsHide: true });
  fs.closeSync(fd);
  children.push(child);
  return child;
}

function readLog(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function waitReady(child, logFile, ms = 20_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (child.exitCode != null) throw new Error(`сервер завершился (код ${child.exitCode})\n${readLog(logFile).slice(-1500)}`);
    try {
      const res = await fetch(`${BASE}/api/login`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return;
    } catch {
      /* ещё не поднялся */
    }
    await sleep(150);
  }
  throw new Error(`сервер не ответил за ${ms} мс\n${readLog(logFile).slice(-1500)}`);
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  const started = Date.now();
  while (child.exitCode == null && Date.now() - started < 5000) await sleep(100);
  if (child.exitCode == null) child.kill("SIGKILL");
}

/* ------------------------------- HTTP-хелперы ------------------------------- */

async function request(pathname, { method = "GET", cookie, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  const res = await fetch(BASE + pathname, {
    method,
    headers: h,
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

function sessionCookieOf(res) {
  for (const raw of setCookies(res)) {
    const first = raw.split(";")[0];
    if (first.startsWith("portal_session=")) return first;
  }
  return null;
}

async function login(password) {
  const res = await request("/api/login", { method: "POST", body: { login: "admin", password } });
  return { res, cookie: sessionCookieOf(res) };
}

/** Один неверный вход: возвращает статус, тело и Retry-After. */
async function wrongLogin(tag, headers = {}) {
  const res = await request("/api/login", { method: "POST", body: { login: "admin", password: `wrong-${tag}` }, headers });
  return { status: res.status, data: res.data, retryAfter: res.headers.get("retry-after") };
}

const RATE_ERROR_RE = /^слишком много попыток входа, попробуй через \d+ минут$/;

/* ------------------------------ разбор ZIP ------------------------------ */

function parseLocalEntries(buf) {
  const entries = [];
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const localOffset = off;
    const flags = buf.readUInt16LE(off + 6);
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen);
    const dataOffset = off + 30 + nameLen + extraLen;
    entries.push({ name, flags, method, crc, size, localOffset, dataOffset, data: buf.subarray(dataOffset, dataOffset + size) });
    off = dataOffset + size;
  }
  return { entries, endOffset: off };
}

function parseCentralDirectory(buf, cdOffset, cdSize) {
  const entries = [];
  let off = cdOffset;
  const end = cdOffset + cdSize;
  while (off + 46 <= end) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`central directory: нет сигнатуры по смещению ${off}`);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, crc, size, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (off !== end) throw new Error("central directory: размер не совпал с EOCD");
  return entries;
}

/* --------------------------- статический контроль --------------------------- */

function staticChecks() {
  const zipPackSrc = fs.readFileSync(path.join(ROOT, "lib", "zip-pack.mjs"), "utf8");
  const serverSrc = fs.readFileSync(path.join(ROOT, "server.mjs"), "utf8");

  check("zip-pack: экспортирует zipStream (async-генератор)", /export\s+async\s+function\*\s+zipStream\s*\(/.test(zipPackSrc));
  check("zip-pack: нигде не вызывает Buffer.concat (архив не собирается целиком)", !zipPackSrc.includes("Buffer.concat"));
  check(
    "zip-pack: файлы читаются блоками по 64 КБ",
    /const CHUNK = 64 \* 1024/.test(zipPackSrc) && /highWaterMark:\s*CHUNK/.test(zipPackSrc),
  );
  check("server: export.zip пишет через zipStream", /zipStream\(entries\)/.test(serverSrc));
  check("server: ZIP уходит в res.write по частям (writeChunk)", /writeChunk\(res,\s*chunk\)/.test(serverSrc));
  check("server: старый буферный buildProjectZip больше не используется", !/buildProjectZip\b/.test(serverSrc));
}

/* --------------------------------- сценарии --------------------------------- */

let exception = null;
let adminPassword = null;

try {
  staticChecks();

  /* ---------- сервер 1: лимит 5/5мин, сброс успехом, защита статики, ZIP ---------- */
  const server1 = startServer({ env: { PORTAL_TOKEN: PORTAL_TOKEN }, logFile: serverLogFile });
  await waitReady(server1, serverLogFile);
  check("сервер поднялся на 7798", true);
  adminPassword = readLog(serverLogFile).match(/пароль:\s*([A-Za-z0-9]{6,})/)?.[1] ?? null;
  if (!adminPassword) throw new Error("в логе сервера нет пароля первого администратора");

  const first = await login(adminPassword);
  check("admin входит (200)", first.res.status === 200 && Boolean(first.cookie), `статус ${first.res.status}`);
  if (!first.cookie) throw new Error("без cookie админа проверять нечего");

  /* 1. шесть неверных паролей подряд */
  const firstFive = [];
  for (let i = 1; i <= 5; i++) firstFive.push(await wrongLogin(`a${i}`));
  check(
    "попытки 1–5 с неверным паролем → 401",
    firstFive.every((r) => r.status === 401 && r.data.error === "неверный логин или пароль"),
    firstFive.map((r) => r.status).join(", "),
  );
  const sixth = await wrongLogin("a6");
  check("6-я попытка подряд → 429", sixth.status === 429, `статус ${sixth.status}`);
  check(
    "429: текст «слишком много попыток входа, попробуй через N минут»",
    RATE_ERROR_RE.test(String(sixth.data.error ?? "")),
    String(sixth.data.error ?? ""),
  );
  check("429: есть заголовок Retry-After (1…300 секунд)", Number(sixth.retryAfter) > 0 && Number(sixth.retryAfter) <= 300, `Retry-After: ${sixth.retryAfter}`);

  /* 2. успешный вход сбрасывает счётчик */
  const afterBlock = await login(adminPassword);
  check("верный пароль после блокировки → 200 (успех сбрасывает счётчик)", afterBlock.res.status === 200 && Boolean(afterBlock.cookie), `статус ${afterBlock.res.status}`);
  const cookie = afterBlock.cookie ?? admin.cookie;

  const afterReset = [];
  for (let i = 1; i <= 5; i++) afterReset.push(await wrongLogin(`b${i}`));
  check(
    "после сброса снова доступны 5 попыток (все 401, без 429)",
    afterReset.every((r) => r.status === 401),
    afterReset.map((r) => r.status).join(", "),
  );
  const sixthAgain = await wrongLogin("b6");
  check("после сброса 6-я попытка снова → 429", sixthAgain.status === 429, `статус ${sixthAgain.status}`);

  /* 3. без TRUST_PROXY поддельный x-forwarded-for не спасает от лимита */
  const spoofed = await wrongLogin("spoof", { "X-Forwarded-For": "203.0.113.77" });
  check("X-Forwarded-For без TRUST_PROXY игнорируется (429)", spoofed.status === 429, `статус ${spoofed.status}`);

  /* 4. статика за входом */
  const studioAnon = await request("/studio/hard.png");
  check("/studio/<file> без cookie → 401", studioAnon.status === 401 && studioAnon.data.error === "нужен вход", `статус ${studioAnon.status}`);

  const studioNoToken = await fetch(`${BASE}/studio/hard.png`, { signal: AbortSignal.timeout(10_000) });
  check("/studio/<file> без cookie и токена → 401", studioNoToken.status === 401, `статус ${studioNoToken.status}`);

  const studioBadToken = await fetch(`${BASE}/studio/hard.png?token=wrong-token`, { signal: AbortSignal.timeout(10_000) });
  check("/studio/<file> с неверным токеном → 401", studioBadToken.status === 401, `статус ${studioBadToken.status}`);

  const studioToken = await fetch(`${BASE}/studio/hard.png?token=${encodeURIComponent(PORTAL_TOKEN)}`, { signal: AbortSignal.timeout(10_000) });
  const studioTokenBuf = Buffer.from(await studioToken.arrayBuffer());
  check("картинка студии по ?token=PORTAL_TOKEN → 200 image/png", studioToken.status === 200 && /^image\/png/.test(studioToken.headers.get("content-type") ?? "") && studioTokenBuf.equals(png), `статус ${studioToken.status}`);

  const studioCookie = await fetch(`${BASE}/studio/hard.png`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10_000) });
  const studioCookieBuf = Buffer.from(await studioCookie.arrayBuffer());
  check("картинка студии с cookie → 200 и байты совпадают", studioCookie.status === 200 && studioCookieBuf.equals(png), `статус ${studioCookie.status}`);

  const previewAnon = await request(`/preview/${runId}/app/index.html`);
  check("/preview/... без cookie → 401", previewAnon.status === 401 && previewAnon.data.error === "нужен вход", `статус ${previewAnon.status}`);
  const previewCookie = await request(`/preview/${runId}/app/index.html`, { cookie });
  check("/preview/... с cookie → 200 и это проект", previewCookie.status === 200 && previewCookie.text.includes(APP_MARKER), `статус ${previewCookie.status}`);
  const previewToken = await request(`/preview/${runId}/app/index.html?token=${encodeURIComponent(PORTAL_TOKEN)}`);
  check("/preview/... по ?token=PORTAL_TOKEN → 200", previewToken.status === 200 && previewToken.text.includes(APP_MARKER), `статус ${previewToken.status}`);

  const mockupAnon = await request(`/preview/${runId}/mockup`);
  check("/preview/<id>/mockup без cookie → 401", mockupAnon.status === 401, `статус ${mockupAnon.status}`);
  const mockupCookie = await request(`/preview/${runId}/mockup`, { cookie });
  check("/preview/<id>/mockup с cookie → 200", mockupCookie.status === 200 && mockupCookie.text.includes(MOCKUP_MARKER), `статус ${mockupCookie.status}`);

  const redirectRes = await fetch(`${BASE}/preview/${runId}/app/?token=${encodeURIComponent(PORTAL_TOKEN)}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const redirectTo = redirectRes.headers.get("location") ?? "";
  check(
    "редирект на index.html сохраняет ?token=",
    redirectRes.status === 302 && redirectTo.includes("?token="),
    `${redirectRes.status} → ${redirectTo}`,
  );

  const publicPage = await request("/");
  const publicJs = await request("/app.js");
  check("публичная страница портала по-прежнему без входа (/ → 200)", publicPage.status === 200 && publicPage.text.includes('id="loginScreen"'), `статус ${publicPage.status}`);
  check("публичная статика по-прежнему открыта (/app.js → 200)", publicJs.status === 200, `статус ${publicJs.status}`);

  /* 5. потоковый export.zip */
  const anonZip = await fetch(`${BASE}/api/runs/${runId}/export.zip`, { signal: AbortSignal.timeout(20_000) });
  check("export.zip без cookie → 401", anonZip.status === 401, `статус ${anonZip.status}`);

  const zipRes = await fetch(`${BASE}/api/runs/${runId}/export.zip`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(30_000) });
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  check("GET export.zip → 200", zipRes.status === 200, `статус ${zipRes.status}`);
  check("Content-Type: application/zip", /application\/zip/.test(zipRes.headers.get("content-type") ?? ""), zipRes.headers.get("content-type") ?? "");
  check("Content-Disposition — вложение .zip", /attachment/i.test(zipRes.headers.get("content-disposition") ?? "") && /\.zip/i.test(zipRes.headers.get("content-disposition") ?? ""), zipRes.headers.get("content-disposition") ?? "");
  check("архив начинается с PK, размер > 0", zipBuf.length > 0 && zipBuf.subarray(0, 2).toString() === "PK", `${zipBuf.length} байт`);

  const eocd = zipBuf.subarray(zipBuf.length - 22);
  const eocdOk = eocd.length === 22 && eocd.readUInt32LE(0) === 0x06054b50;
  check("EOCD в последних 22 байтах", eocdOk, eocd.subarray(0, 4).toString("hex"));

  let local = { entries: [], endOffset: 0 };
  let central = [];
  let zipParsed = false;
  if (eocdOk) {
    try {
      local = parseLocalEntries(zipBuf);
      const total = eocd.readUInt16LE(10);
      const cdSize = eocd.readUInt32LE(12);
      const cdOffset = eocd.readUInt32LE(16);
      central = parseCentralDirectory(zipBuf, cdOffset, cdSize);
      zipParsed = true;
      check("число записей в EOCD совпадает с local headers", total === local.entries.length, `EOCD ${total}, local ${local.entries.length}`);
      check(
        "central directory примыкает к EOCD, а local — к central",
        cdOffset === local.endOffset && cdOffset + cdSize + 22 === zipBuf.length,
        `cdOffset ${cdOffset}, end ${local.endOffset}, cdSize ${cdSize}`,
      );
      check(
        "central directory ссылается на те же записи",
        central.length === local.entries.length &&
          central.every((c) => {
            const l = local.entries.find((e) => e.name === c.name);
            return l && l.crc === c.crc && l.size === c.size && l.localOffset === c.localOffset;
          }),
        central.map((c) => c.name).join(", "),
      );
      const methodOk = local.entries.every((e) => e.method === 0 && (e.flags & 0x08) === 0);
      check("все записи — store, без data descriptor (совместимо с архиваторами)", methodOk);
      const crcOk = local.entries.every((e) => crc32(e.data) === e.crc);
      check("CRC32 каждой записи сходится с данными", crcOk);
    } catch (err) {
      check("ZIP разбирается без ошибок", false, String(err?.message || err));
    }
  }

  if (zipParsed) {
    const names = local.entries.map((e) => e.name);
    check(
      "имена внутри прежние: index.html, styles.css, data/blob.bin, README.md, artifacts/**",
      ["index.html", "styles.css", "data/blob.bin", "README.md"].every((n) => names.includes(n)) &&
        names.some((n) => n.startsWith("artifacts/") && n.endsWith("spec.md")) &&
        names.some((n) => n.startsWith("artifacts/") && n.endsWith("test-1.md")),
      names.join(", "),
    );
    const bigEntry = local.entries.find((e) => e.name === "data/blob.bin");
    check("большой файл целиком в архиве (320 КБ, CRC)", Boolean(bigEntry) && bigEntry.size === bigSize && bigEntry.data.equals(big), bigEntry ? `${bigEntry.size} байт` : "нет записи");
    const readmeEntry = local.entries.find((e) => e.name === "README.md");
    const readme = readmeEntry ? readmeEntry.data.toString("utf8") : "";
    check("README.md описывает задачу и как открыть", readme.includes("## Задача") && readme.includes("## Как открыть"), readme.slice(0, 60).replace(/\n/g, " "));
  }

  /* 6. zipStream отдаёт чанки, а не один буфер */
  const chunks = [];
  for await (const chunk of zipStream([
    { name: "data/blob.bin", path: path.join(runsDir, runId, "artifacts", "work", "data", "blob.bin") },
    { name: "note.txt", data: "привет" },
  ])) {
    chunks.push(chunk);
  }
  const streamed = Buffer.concat(chunks);
  const maxChunk = chunks.reduce((m, c) => Math.max(m, c.length), 0);
  check("zipStream: генератор отдаёт много чанков", chunks.length > 10, `чанков ${chunks.length}`);
  check("zipStream: ни один чанк не больше 64 КБ + заголовок", maxChunk <= 64 * 1024, `максимум ${maxChunk} байт`);
  check(
    "zipStream: собранный из чанков архив валиден (PK…EOCD)",
    streamed.subarray(0, 2).toString() === "PK" && streamed.readUInt32LE(streamed.length - 22) === 0x06054b50,
    `${streamed.length} байт`,
  );

  await stopServer(server1);

  /* ---------- сервер 2: часовой лимит 20 и доверие x-forwarded-for ---------- */
  const server2 = startServer({
    env: { TRUST_PROXY: "1", LOGIN_MAX_5M: "100", PORTAL_TOKEN: PORTAL_TOKEN },
    logFile: serverLog2File,
  });
  await waitReady(server2, serverLog2File);
  check("сервер 2 поднялся (TRUST_PROXY=1, 5-минутный лимит отключён)", true);

  const hourIp = { "X-Forwarded-For": "198.51.100.10" };
  const twenty = [];
  for (let i = 1; i <= 20; i++) twenty.push(await wrongLogin(`h${i}`, hourIp));
  check("20 неверных попыток за час → все 401", twenty.every((r) => r.status === 401), twenty.map((r) => r.status).join(", "));
  const twentyFirst = await wrongLogin("h21", hourIp);
  check("21-я попытка за час → 429", twentyFirst.status === 429, `статус ${twentyFirst.status}`);
  check(
    "часовой 429: Retry-After ≈ час и текст «через 60 минут»",
    Number(twentyFirst.retryAfter) > 3000 && Number(twentyFirst.retryAfter) <= 3600 && /через 60 минут/.test(String(twentyFirst.data.error ?? "")),
    `Retry-After: ${twentyFirst.retryAfter} · ${twentyFirst.data.error}`,
  );
  const otherIp = await wrongLogin("other", { "X-Forwarded-For": "198.51.100.11" });
  check("при TRUST_PROXY=1 другой IP из x-forwarded-for не заблокирован → 401", otherIp.status === 401, `статус ${otherIp.status}`);

  await stopServer(server2);
} catch (err) {
  exception = err;
  failed = Math.max(failed, 1);
  console.error("FAIL · исключение:", err?.stack || err);
  for (const file of [serverLogFile, serverLog2File]) {
    const log = readLog(file);
    if (log) console.error(`--- хвост лога (${path.basename(file)}) ---\n` + log.slice(-2000));
  }
} finally {
  for (const child of children) await stopServer(child);
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* временный каталог мог остаться — не влияет на проверку */
  }
}

if (exception) console.error(`\nисключение: ${exception.message}`);
console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
