/**
 * Проверка новых возможностей: галерея, ZIP-экспорт, ручной гейт по блокам, дежурный.
 *
 * Поднимает server.mjs на 7793 с временными RUNS_DIR / PROJECTS_FILE / MAILBOX_FILE /
 * USERS_FILE / STUDIO_DIR и MOCK=1, логинится админом, прогоняет сценарии и гасит сервер.
 *
 * Запуск: node scripts/probe-features.mjs  (Exit 1 при любом провале)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const PORT = 7793;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};

/* ------------------------------ временные данные ------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-features-"));
const runsDir = path.join(tmp, "runs");
const projectsFile = path.join(tmp, "projects.json");
const mailboxFile = path.join(tmp, "mailbox.json");
const usersFile = path.join(tmp, "users.json");
const studioDir = path.join(tmp, "studio");
const serverLogFile = path.join(tmp, "server.log");

const runId = "20260101-000000-probe";
const projectId = "p-probe";
const now = new Date().toISOString();
const task = "Пробный проект: страница с заголовком и стилями";

const pipeline = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "pipeline.json"), "utf8").replace(/^\uFEFF/, ""));
const stages = (pipeline.stages ?? []).filter((s) => s.enabled !== false);
const verifyIndex = stages.findIndex((s) => s.kind === "verify");
if (verifyIndex < 0) {
  console.error("FAIL · в config/pipeline.json нет стадии verify — проверять гейт не на чем");
  process.exit(1);
}

const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex"
);

const indexHtml = '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><title>Проба</title><link rel="stylesheet" href="styles.css"></head><body><h1>Пробный проект</h1></body></html>\n';

function prepareFixtures() {
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(studioDir, { recursive: true });

  /* студия: две картинки, одну удалим через API */
  const item = (id, file, prompt, model, cost) => ({
    id,
    at: now,
    prompt,
    model,
    aspectRatio: "1:1",
    quality: "auto",
    mediaType: "image/png",
    file,
    size: png.length,
    cost,
    ms: 0,
    ref: null,
  });
  fs.writeFileSync(path.join(studioDir, "aaa.png"), png);
  fs.writeFileSync(path.join(studioDir, "bbb.png"), png);
  fs.writeFileSync(
    path.join(studioDir, "index.json"),
    JSON.stringify(
      {
        items: [item("img1", "aaa.png", "красный кот на подоконнике", "test/model-a", 0.02), item("img2", "bbb.png", "синий кит в небе", "test/model-b", 0.03)],
      },
      null,
      2
    ),
    "utf8"
  );

  /* проект + прогон, который стоит на гейте проверки */
  fs.writeFileSync(
    projectsFile,
    JSON.stringify(
      {
        projects: [
          {
            id: projectId,
            name: "Пробный проект",
            task,
            createdAt: now,
            updatedAt: now,
            runIds: [runId],
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );

  const block = {
    id: "b1",
    title: "Страница с заголовком",
    goal: "Показать заголовок и подключить стили",
    status: "built",
    acceptance: ["Есть h1 с текстом", "Подключён styles.css"],
    deps: [],
    spec: "# Страница с заголовком\n\n## Критерии приёмки\n- Есть h1\n- Подключён styles.css\n",
    design: null,
    files: [{ path: "index.html", content: indexHtml }],
    test: { verdict: "pass", summary: "всё на месте", defects: [], criteria: [], round: 1 },
    fixes: [],
    history: [],
  };

  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(path.join(runDir, "artifacts", "work"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "artifacts", "blocks", "b1"), { recursive: true });

  const run = {
    id: runId,
    task,
    change: null,
    baseId: null,
    projectId,
    createdAt: now,
    updatedAt: now,
    status: "awaiting",
    stageIndex: verifyIndex,
    awaiting: { stageId: stages[verifyIndex].id, title: stages[verifyIndex].title, question: "Проверь результат стадии" },
    plan: { title: "План пробы", blocks: [{ id: "b1", title: block.title, goal: block.goal, acceptance: block.acceptance, deps: [] }] },
    blocks: [block],
    approvals: {},
    stageMeta: {},
    workspace: { "index.html": indexHtml, "styles.css": "h1 { color: #123; }\n" },
    usage: { prompt: 0, completion: 0, cost: 5.25, calls: 1 },
    error: null,
    eventSeq: 0,
    events: [],
  };

  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ ...run, events: undefined }, null, 2), "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "work", "index.html"), indexHtml, "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "work", "styles.css"), "h1 { color: #123; }\n", "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "plan.md"), "# План пробы\n", "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "summary.md"), "# Сводка\n", "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "blocks", "b1", "spec.md"), block.spec, "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "blocks", "b1", "test-1.md"), "# Проверка\n\npass\n", "utf8");
  fs.writeFileSync(path.join(runDir, "artifacts", "blocks", "b1", "fix-1.md"), "# Правки\n", "utf8");
}

prepareFixtures();

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

const server = (() => {
  // Вывод сервера — в файл: в песочнице DSH пайпы stdio могут быть недоступны (spawn EPERM).
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

/** Разбор ZIP, который пишет lib/zip.mjs (store, без сжатия). */
function zipEntries(buf) {
  const out = [];
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const size = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen);
    const dataOffset = off + 30 + nameLen + extraLen;
    out.push({ name, size, dataOffset, data: buf.subarray(dataOffset, dataOffset + size) });
    off = dataOffset + size;
  }
  return out;
}

/* ------------------------------- сценарии ------------------------------- */

let exception = null;
try {
  await waitReady();
  check("сервер поднялся на 7793", true);
  if (!adminPassword) throw new Error("в логе сервера нет пароля первого администратора");

  const admin = await login("admin", adminPassword);
  check("admin входит (200)", admin.res.status === 200 && Boolean(admin.cookie), `статус ${admin.res.status}`);
  if (!admin.cookie) throw new Error("без cookie админа проверять нечего");

  const page = await request("/");
  check(
    "страница содержит вкладку «Галерея» и кнопку ZIP",
    page.status === 200 && page.text.includes('data-page="gallery"') && page.text.includes('id="pageGallery"') && page.text.includes('id="downloadZip"'),
    `статус ${page.status}`
  );

  /* 1. галерея */
  const gallery = await request("/api/gallery?limit=50", { cookie: admin.cookie });
  check(
    "GET /api/gallery → список картинок",
    gallery.status === 200 && gallery.data.items?.length === 2 && gallery.data.total === 2,
    `статус ${gallery.status}, картинок ${gallery.data.items?.length}`
  );
  check(
    "у картинки есть id/file/prompt/model/cost/at/url",
    ["id", "file", "prompt", "model", "cost", "at", "url"].every((k) => gallery.data.items?.[0]?.[k] !== undefined && gallery.data.items?.[0]?.[k] !== null),
    JSON.stringify(gallery.data.items?.[0] ?? {})
  );
  check("url картинки ведёт в /studio/", String(gallery.data.items?.[0]?.url ?? "").startsWith("/studio/"));
  check("суммарная стоимость в галерее", Math.abs(Number(gallery.data.cost) - 0.05) < 1e-9, `$${gallery.data.cost}`);

  const defaultImg = gallery.data.items.find((i) => i.id === "img2") ?? gallery.data.items[0];
  // /studio/* закрыт сессией: браузер шлёт cookie и для <img>, проверка — тоже с cookie.
  const studioGet = await request(defaultImg.url, { cookie: admin.cookie });
  check("превью картинки отдаётся по /studio/<file> с сессией", studioGet.status === 200, `статус ${studioGet.status}`);

  /* 2. viewer: чтение можно, удаление/решения/дежурство — нельзя */
  const viewerPass = "viewer-pass-123";
  const createViewer = await request("/api/users", {
    method: "POST",
    cookie: admin.cookie,
    body: { login: "probe-viewer", password: viewerPass, role: "viewer" },
  });
  check("admin создаёт viewer", createViewer.status === 201, `статус ${createViewer.status}`);
  const viewer = await login("probe-viewer", viewerPass);
  check("viewer входит", viewer.res.status === 200 && Boolean(viewer.cookie));
  const viewerGallery = await request("/api/gallery", { cookie: viewer.cookie });
  check("viewer GET /api/gallery → 200", viewerGallery.status === 200);
  const viewerDelete = await request(`/api/images/${defaultImg.id}`, { method: "DELETE", cookie: viewer.cookie });
  check("viewer DELETE /api/images/:id → 403", viewerDelete.status === 403, `статус ${viewerDelete.status}`);
  const viewerDecision = await request(`/api/runs/${runId}/block/b1/decision`, {
    method: "POST",
    cookie: viewer.cookie,
    body: { decision: "accept", comment: "нельзя" },
  });
  check("viewer решение по блоку → 403", viewerDecision.status === 403, `статус ${viewerDecision.status}`);
  const viewerWatch = await request("/api/watch/start", { method: "POST", cookie: viewer.cookie, body: { everyMin: 1 } });
  check("viewer POST /api/watch/start → 403", viewerWatch.status === 403, `статус ${viewerWatch.status}`);

  /* 3. ZIP доступен и viewer */
  const viewerZip = await fetch(`${BASE}/api/runs/${runId}/export.zip`, {
    headers: { Cookie: viewer.cookie },
    signal: AbortSignal.timeout(20_000),
  });
  const viewerZipBuf = Buffer.from(await viewerZip.arrayBuffer());
  check("viewer GET export.zip → 200", viewerZip.status === 200 && viewerZipBuf.subarray(0, 2).toString() === "PK", `статус ${viewerZip.status}`);

  /* 4. удаление картинки админом */
  const target = gallery.data.items.find((i) => i.id === "img1");
  const del = await request(`/api/images/${target.id}`, { method: "DELETE", cookie: admin.cookie });
  check("DELETE /api/images/:id → 200", del.status === 200 && del.data.ok === true, `статус ${del.status} · ${JSON.stringify(del.data)}`);
  const afterDelete = await request("/api/gallery?limit=50", { cookie: admin.cookie });
  check(
    "после удаления в галерее одна картинка",
    afterDelete.status === 200 && afterDelete.data.items?.length === 1 && afterDelete.data.total === 1,
    `картинок ${afterDelete.data.items?.length}`
  );
  check("файл удалённой картинки исчез с диска", !fs.existsSync(path.join(studioDir, target.file)));
  check("файл второй картинки на месте", fs.existsSync(path.join(studioDir, defaultImg.file)));

  /* 5. ZIP проекта */
  const zipRes = await fetch(`${BASE}/api/runs/${runId}/export.zip`, {
    headers: { Cookie: admin.cookie },
    signal: AbortSignal.timeout(20_000),
  });
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  const disposition = zipRes.headers.get("content-disposition") ?? "";
  check("GET export.zip → 200", zipRes.status === 200, `статус ${zipRes.status}`);
  check("Content-Type: application/zip", /application\/zip/.test(zipRes.headers.get("content-type") ?? ""), zipRes.headers.get("content-type") ?? "");
  check("сигнатура архива PK", zipBuf.length > 4 && zipBuf.subarray(0, 2).toString() === "PK", zipBuf.subarray(0, 4).toString("hex"));
  check("Content-Disposition — вложение с именем проекта", /attachment/i.test(disposition) && /\.zip/i.test(disposition), disposition);

  const entries = zipEntries(zipBuf);
  const names = entries.map((e) => e.name);
  check("в архиве есть index.html", names.includes("index.html"), names.join(", "));
  check("в архиве есть styles.css", names.includes("styles.css"));
  check("в архиве есть README.md", names.includes("README.md"));
  check(
    "в архиве есть отчёты artifacts/**",
    names.some((n) => n.startsWith("artifacts/") && n.endsWith("spec.md")) && names.some((n) => n.endsWith("test-1.md")) && names.some((n) => n.endsWith("fix-1.md")),
    names.filter((n) => n.startsWith("artifacts/")).join(", ")
  );
  const readme = entries.find((e) => e.name === "README.md");
  const readmeText = readme ? zipBuf.toString("utf8", readme.dataOffset, readme.dataOffset + readme.size) : "";
  check("README.md описывает задачу и как открыть", readmeText.includes("Пробный проект") && readmeText.includes("## Как открыть"), readmeText.slice(0, 80).replace(/\n/g, " "));

  /* 6. ручной гейт по блокам */
  const decision = await request(`/api/runs/${runId}/block/b1/decision`, {
    method: "POST",
    cookie: admin.cookie,
    body: { decision: "accept", comment: "Принимаю вручную" },
  });
  check("POST /block/b1/decision accept → 200", decision.status === 200, `статус ${decision.status} · ${JSON.stringify(decision.data)}`);
  check("блок стал verified", decision.data.run?.blocks?.[0]?.status === "verified", decision.data.run?.blocks?.[0]?.status);
  check("все блоки приняты → прогон done", decision.data.run?.status === "done", decision.data.run?.status);
  check("ответ сообщает о завершении", decision.data.completed === true);

  const eventLines = fs
    .readFileSync(path.join(runsDir, runId, "events.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  check(
    "в событиях есть «принят вручную»",
    eventLines.some((e) => String(e.message ?? "").includes("принят вручную")),
    eventLines.map((e) => e.kind).join(", ")
  );
  check("прогон завершён обычной веткой engine (событие done)", eventLines.some((e) => e.kind === "done"));

  /* 7. дежурный + общий SSE-поток */
  const sseAbort = new AbortController();
  let sseText = "";
  const sseRes = await fetch(`${BASE}/api/events`, { headers: { Cookie: admin.cookie }, signal: sseAbort.signal });
  check("GET /api/events → 200 text/event-stream", sseRes.status === 200 && /text\/event-stream/.test(sseRes.headers.get("content-type") ?? ""), `${sseRes.status} · ${sseRes.headers.get("content-type")}`);
  const sseReader = sseRes.body.getReader();
  const ssePump = (async () => {
    try {
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await sseReader.read();
        if (done) break;
        sseText += decoder.decode(value, { stream: true });
        if (sseText.includes("event: watch")) break;
      }
    } catch {
      /* поток закрыли после проверки */
    }
  })();
  await sleep(100);

  const start = await request("/api/watch/start", { method: "POST", cookie: admin.cookie, body: { everyMin: 1 } });
  check(
    "POST /api/watch/start → работает, everyMin=1, lastRunAt есть",
    start.status === 200 && start.data.running === true && start.data.everyMin === 1 && Boolean(start.data.lastRunAt),
    `статус ${start.status} · ${JSON.stringify(start.data)}`
  );
  await Promise.race([ssePump, sleep(3000)]);
  check("SSE /api/events получает событие watch", sseText.includes("event: watch"), sseText.trim().slice(0, 120).replace(/\n/g, " | "));
  sseAbort.abort();
  const watchGet = await request("/api/watch", { cookie: admin.cookie });
  check("GET /api/watch → running=true", watchGet.status === 200 && watchGet.data.running === true);
  const mailbox = await request("/api/mailbox", { cookie: admin.cookie });
  check(
    "алерты дежурного попали в mailbox",
    mailbox.status === 200 && (mailbox.data.items ?? []).some((i) => i.kind === "watch"),
    `watch-сообщений: ${(mailbox.data.items ?? []).filter((i) => i.kind === "watch").length}`
  );
  const stop = await request("/api/watch/stop", { method: "POST", cookie: admin.cookie });
  check("POST /api/watch/stop → running=false", stop.status === 200 && stop.data.running === false, JSON.stringify(stop.data));
  const watchAfter = await request("/api/watch", { cookie: admin.cookie });
  check("GET /api/watch после стопа → running=false", watchAfter.status === 200 && watchAfter.data.running === false);
  check("время последней проверки сохранилось", Boolean(watchAfter.data.lastRunAt));
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
