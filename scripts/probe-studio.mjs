/**
 * Проверка студии и общей библиотеки.
 *
 * Поднимает server.mjs на PORT=7795 с временными RUNS_DIR / PROJECTS_FILE /
 * MAILBOX_FILE / USERS_FILE / STUDIO_DIR и MOCK=1, логинится admin, проверяет:
 *   - чаты specs/prompts создаются, группы в списке содержат kind;
 *   - сообщение в spec/prompt возвращает структуру карточки (200 или 501 в MOCK);
 *   - видео-чат отвечает понятной ошибкой;
 *   - библиотека: избранное/архив/корзина, restore, purge (физическое удаление);
 *   - картинка в корзине исчезает из /api/gallery и /api/images;
 *   - viewer только читает.
 *
 * Запуск: node scripts/probe-studio.mjs  (Exit 1 при любом провале)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const PORT = 7795;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
};

/* ------------------------------ временные данные ------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-studio-"));
const runsDir = path.join(tmp, "runs");
const projectsFile = path.join(tmp, "projects.json");
const mailboxFile = path.join(tmp, "mailbox.json");
const usersFile = path.join(tmp, "users.json");
const studioDir = path.join(tmp, "studio");
const serverLogFile = path.join(tmp, "server.log");
const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex"
);

fs.mkdirSync(runsDir, { recursive: true });
fs.mkdirSync(studioDir, { recursive: true });
fs.writeFileSync(path.join(studioDir, "img1.png"), png);
fs.writeFileSync(
  path.join(studioDir, "index.json"),
  JSON.stringify(
    {
      items: [
        {
          id: "img1",
          at: new Date().toISOString(),
          prompt: "красный кот на подоконнике",
          model: "test/model",
          aspectRatio: "1:1",
          quality: "auto",
          mediaType: "image/png",
          file: "img1.png",
          size: png.length,
          cost: 0.02,
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

const hasKind = (list, kind) => (list ?? []).filter((s) => s.kind === kind);

/* ------------------------------- сценарии ------------------------------- */

let exception = null;
try {
  await waitReady();
  check("сервер поднялся на 7795", true);
  if (!adminPassword) throw new Error("в логе сервера нет пароля первого администратора");

  const admin = await login("admin", adminPassword);
  check("admin входит (200)", admin.res.status === 200 && Boolean(admin.cookie), `статус ${admin.res.status}`);
  if (!admin.cookie) throw new Error("без cookie админа проверять нечего");
  const cookie = admin.cookie;

  /* 0. исходный чат картинок и галерея */
  const initial = await request("/api/studio/sessions", { cookie });
  check("GET /api/studio/sessions → 200", initial.status === 200, `статус ${initial.status}`);
  check("у каждого чата в списке есть kind", (initial.data.sessions ?? []).every((s) => typeof s.kind === "string"));
  const imagesChat = (initial.data.sessions ?? []).find((s) => s.kind === "images");
  check("студия стартует с чатом картинок", Boolean(imagesChat), imagesChat?.id);

  /* 1. новый тип «Спеки» */
  const specCreate = await request("/api/studio/sessions", {
    method: "POST",
    cookie,
    body: { name: "ТЗ на личный кабинет", kind: "specs" },
  });
  check("создание чата specs → 200", specCreate.status === 200 && specCreate.data.session?.kind === "specs", `статус ${specCreate.status}`);
  const specId = specCreate.data.session?.id;

  const specSay = await request("/api/studio/spec", {
    method: "POST",
    cookie,
    body: { sessionId: specId, text: "Нужен личный кабинет с историей заказов и фильтром по датам" },
  });
  check(
    "POST /api/studio/spec → 200/501 (в MOCK заглушка)",
    [200, 501].includes(specSay.status),
    `статус ${specSay.status}`
  );
  if (specSay.status === 200) {
    const msg = specSay.data.message;
    check(
      "спека вернулась markdown-карточкой",
      msg?.role === "doc" && msg?.spec === true && typeof msg?.markdown === "string" && msg.markdown.length > 20,
      JSON.stringify({ role: msg?.role, spec: msg?.spec, len: msg?.markdown?.length })
    );
    check("в ответе есть thread", Array.isArray(specSay.data.thread) && specSay.data.thread.length >= 2);
  } else {
    check("501 объясняет причину", typeof specSay.data.error === "string" && specSay.data.error.length > 3, specSay.data.error);
  }

  /* доработка спеки: второе сообщение не должно падать */
  const specRefine = await request("/api/studio/spec", {
    method: "POST",
    cookie,
    body: { sessionId: specId, text: "Добавь требование к экспорту заказов в CSV" },
  });
  check("доработка спеки → 200/501", [200, 501].includes(specRefine.status), `статус ${specRefine.status}`);

  /* библиотека знает и документы/спеки: ref = doc:<messageId> */
  const specMessageId = specSay.status === 200 ? specSay.data.message?.id : null;
  if (specMessageId) {
    const docsLibrary = await request("/api/library?view=all", { cookie });
    check("GET /api/library?view=all содержит doc:<messageId>", (docsLibrary.data.items ?? []).some((i) => i.ref === `doc:${specMessageId}`));
    const mdDownload = await request(`/api/studio/doc/${specMessageId}.md`, { cookie });
    check("спеку можно скачать как .md", mdDownload.status === 200 && mdDownload.text.includes("# "), `статус ${mdDownload.status}`);
    const docxFetched = await fetch(`${BASE}/api/studio/doc/${specMessageId}.docx`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(20_000) });
    check("спеку можно скачать как .docx", docxFetched.status === 200, `статус ${docxFetched.status}`);
    const docFav = await request("/api/library/mark", { method: "POST", cookie, body: { ref: `doc:${specMessageId}`, fav: true } });
    check("документ можно добавить в избранное", docFav.status === 200 && docFav.data.item?.fav === true);
    const docTrash = await request("/api/library/trash", { method: "POST", cookie, body: { ref: `doc:${specMessageId}` } });
    check("документ уезжает в корзину", docTrash.status === 200 && Boolean(docTrash.data.item?.deletedAt));
    const docRestore = await request("/api/library/restore", { method: "POST", cookie, body: { ref: `doc:${specMessageId}` } });
    check("документ восстанавливается из корзины", docRestore.status === 200 && docRestore.data.item?.deletedAt === null);
  } else {
    check("пропуск проверки doc-ref: MOCK вернул 501 без id", true);
  }

  /* 2. новый тип «Промты» */
  const promptCreate = await request("/api/studio/sessions", {
    method: "POST",
    cookie,
    body: { name: "Промты для поддержки", kind: "prompts" },
  });
  check("создание чата prompts → 200", promptCreate.status === 200 && promptCreate.data.session?.kind === "prompts", `статус ${promptCreate.status}`);
  const promptId = promptCreate.data.session?.id;

  const promptSay = await request("/api/studio/prompt", {
    method: "POST",
    cookie,
    body: { sessionId: promptId, text: "Нужен промт, который переписывает ответы поддержки вежливо и коротко" },
  });
  check(
    "POST /api/studio/prompt → 200/501 (в MOCK заглушка)",
    [200, 501].includes(promptSay.status),
    `статус ${promptSay.status}`
  );
  if (promptSay.status === 200) {
    const msg = promptSay.data.message;
    check(
      "промт вернулся готовым блоком кода",
      msg?.role === "prompt" && typeof msg?.text === "string" && msg.text.length > 20,
      JSON.stringify({ role: msg?.role, len: msg?.text?.length })
    );
    check("в ответе есть thread", Array.isArray(promptSay.data.thread) && promptSay.data.thread.length >= 2);
  } else {
    check("501 объясняет причину", typeof promptSay.data.error === "string" && promptSay.data.error.length > 3, promptSay.data.error);
  }

  const promptRefine = await request("/api/studio/prompt", {
    method: "POST",
    cookie,
    body: { sessionId: promptId, text: "Сделай короче и добавь формат ответа списком" },
  });
  check("доработка промта → 200/501", [200, 501].includes(promptRefine.status), `статус ${promptRefine.status}`);

  /* 3. документы не сломались */
  const docsCreate = await request("/api/studio/sessions", {
    method: "POST",
    cookie,
    body: { name: "Документы", kind: "docs" },
  });
  check("создание чата docs → 200", docsCreate.status === 200 && docsCreate.data.session?.kind === "docs", `статус ${docsCreate.status}`);

  /* 4. группы: список содержит все нужные kind */
  const grouped = await request("/api/studio/sessions?view=all", { cookie });
  const kinds = new Set((grouped.data.sessions ?? []).map((s) => s.kind));
  check("в GET /api/studio/sessions есть kind у всех чатов", (grouped.data.sessions ?? []).length > 0 && (grouped.data.sessions ?? []).every((s) => typeof s.kind === "string"));
  check(
    "в списке есть группы images/docs/specs/prompts",
    ["images", "docs", "specs", "prompts"].every((k) => kinds.has(k)),
    [...kinds].join(", ")
  );
  check("группы видео нет, пока нет видео-чатов", !kinds.has("video"));

  /* 5. видео-чат: понятная ошибка, остальные чаты целы */
  const beforeVideo = (grouped.data.sessions ?? []).length;
  const video = await request("/api/studio/sessions", { method: "POST", cookie, body: { name: "Видео", kind: "video" } });
  check("создание видео-чата → 400", video.status === 400, `статус ${video.status}`);
  check(
    "ошибка видео понятная",
    /видео ещё не подключено/i.test(String(video.data.error ?? "")),
    String(video.data.error ?? "")
  );
  const afterVideo = await request("/api/studio/sessions?view=all", { cookie });
  check("после ошибки список чатов не изменился", (afterVideo.data.sessions ?? []).length === beforeVideo);

  /* 6. библиотека: избранное, архив, корзина чата */
  const chatRef = `chat:${specId}`;
  const fav = await request("/api/library/mark", { method: "POST", cookie, body: { ref: chatRef, fav: true } });
  check("POST /api/library/mark fav → 200", fav.status === 200 && fav.data.item?.fav === true, `статус ${fav.status}`);
  const favView = await request("/api/library?view=fav", { cookie });
  check("GET /api/library?view=fav содержит чат", (favView.data.items ?? []).some((i) => i.ref === chatRef));
  const favSessions = await request("/api/studio/sessions?view=fav", { cookie });
  check("GET /api/studio/sessions?view=fav содержит чат", (favSessions.data.sessions ?? []).some((s) => s.id === specId));

  const archive = await request("/api/library/mark", { method: "POST", cookie, body: { ref: chatRef, archived: true, fav: false } });
  check("POST /api/library/mark archived → 200", archive.status === 200 && archive.data.item?.archived === true);
  const allAfterArchive = await request("/api/studio/sessions?view=all", { cookie });
  check("архивный чат скрыт из обычного списка", !(allAfterArchive.data.sessions ?? []).some((s) => s.id === specId));
  const archiveSessions = await request("/api/studio/sessions?view=archive", { cookie });
  check("архивный чат виден в archive", (archiveSessions.data.sessions ?? []).some((s) => s.id === specId));
  const libraryArchive = await request("/api/library?view=archive", { cookie });
  check("GET /api/library?view=archive содержит чат", (libraryArchive.data.items ?? []).some((i) => i.ref === chatRef));
  await request("/api/library/mark", { method: "POST", cookie, body: { ref: chatRef, archived: false } });

  const trash = await request("/api/library/trash", { method: "POST", cookie, body: { ref: chatRef } });
  check("POST /api/library/trash → 200", trash.status === 200 && Boolean(trash.data.item?.deletedAt), `статус ${trash.status}`);
  const allAfterTrash = await request("/api/studio/sessions?view=all", { cookie });
  check("чат в корзине скрыт из обычного списка", !(allAfterTrash.data.sessions ?? []).some((s) => s.id === specId));
  const trashSessions = await request("/api/studio/sessions?view=trash", { cookie });
  const trashedChat = (trashSessions.data.sessions ?? []).find((s) => s.id === specId);
  check("чат в корзине виден в trash с датой удаления", Boolean(trashedChat?.deletedAt), trashedChat?.deletedAt ?? "нет");
  const libraryTrash = await request("/api/library?view=trash", { cookie });
  check("GET /api/library?view=trash содержит чат", (libraryTrash.data.items ?? []).some((i) => i.ref === chatRef && i.deletedAt));

  const restore = await request("/api/library/restore", { method: "POST", cookie, body: { ref: chatRef } });
  check("POST /api/library/restore → 200", restore.status === 200 && restore.data.item?.deletedAt === null);
  const allAfterRestore = await request("/api/studio/sessions?view=all", { cookie });
  check("restore возвращает чат в обычный список", (allAfterRestore.data.sessions ?? []).some((s) => s.id === specId));

  /* 7. purge чата: физическое удаление */
  await request("/api/library/trash", { method: "POST", cookie, body: { ref: chatRef } });
  const purge = await request("/api/library/purge", { method: "DELETE", cookie, body: { ref: chatRef } });
  check("DELETE /api/library/purge чата → 200", purge.status === 200 && purge.data.ok === true, `статус ${purge.status} · ${JSON.stringify(purge.data)}`);
  const afterPurgeAll = await request("/api/studio/sessions?view=all", { cookie });
  const afterPurgeTrash = await request("/api/studio/sessions?view=trash", { cookie });
  check("после purge чата нет ни в all, ни в trash", ![afterPurgeAll, afterPurgeTrash].some((r) => (r.data.sessions ?? []).some((s) => s.id === specId)));
  const deadThread = await request(`/api/studio/thread?session=${encodeURIComponent(specId)}`, { cookie });
  check("после purge чат не читается (404)", deadThread.status === 404, `статус ${deadThread.status}`);
  check(
    "после purge файл переписки удалён физически",
    !fs.existsSync(path.join(studioDir, "threads", `${specId}.json`))
  );

  /* 8. мягкое удаление через старый DELETE /api/studio/sessions/:id */
  const docs2 = await request("/api/studio/sessions", { method: "POST", cookie, body: { name: "Временный чат документов", kind: "docs" } });
  const docs2Id = docs2.data.session?.id;
  const soft = await request(`/api/studio/sessions/${docs2Id}`, { method: "DELETE", cookie });
  check("DELETE /api/studio/sessions/:id → 200 (в корзину)", soft.status === 200 && soft.data.trashed === true, `статус ${soft.status}`);
  const allSoft = await request("/api/studio/sessions?view=all", { cookie });
  check("после DELETE чат скрыт из обычного списка", !(allSoft.data.sessions ?? []).some((s) => s.id === docs2Id));
  const trashSoft = await request("/api/library?view=trash", { cookie });
  check("после DELETE чат виден в корзине", (trashSoft.data.items ?? []).some((i) => i.ref === `chat:${docs2Id}`));
  const purgeSoft = await request("/api/library/purge", { method: "DELETE", cookie, body: { ref: `chat:${docs2Id}` } });
  check("purge мягко удалённого чата → 200", purgeSoft.status === 200 && purgeSoft.data.ok === true);

  /* 9. картинки: корзина скрывает из галереи и выбора референса */
  const gallery = await request("/api/gallery?limit=50", { cookie });
  check("GET /api/gallery до корзины → 1 картинка", gallery.status === 200 && gallery.data.total === 1, `total ${gallery.data.total}`);
  const imageRef = "image:img1";
  const imageTrash = await request("/api/library/trash", { method: "POST", cookie, body: { ref: imageRef } });
  check("картинка уезжает в корзину", imageTrash.status === 200 && Boolean(imageTrash.data.item?.deletedAt));
  const galleryAfter = await request("/api/gallery?limit=50", { cookie });
  check("картинка в корзине не видна в /api/gallery", galleryAfter.status === 200 && galleryAfter.data.total === 0, `total ${galleryAfter.data.total}`);
  const galleryTrash = await request("/api/gallery?limit=50&view=trash", { cookie });
  check(
    "картинка в корзине видна в gallery?view=trash с датой",
    galleryTrash.data.total === 1 && Boolean(galleryTrash.data.items?.[0]?.deletedAt)
  );
  const imagesAfter = await request("/api/images?limit=50", { cookie });
  check("картинка в корзине не видна в /api/images (выбор референса)", (imagesAfter.data.items ?? []).length === 0);
  const refDenied = await request("/api/studio/generate", {
    method: "POST",
    cookie,
    body: { prompt: "попробуй взять референс из корзины", referenceId: "img1", sessionId: imagesChat?.id },
  });
  check("сервер не берёт референс из корзины", refDenied.status === 409, `статус ${refDenied.status}`);

  const imageRestore = await request("/api/library/restore", { method: "POST", cookie, body: { ref: imageRef } });
  check("restore картинки → 200", imageRestore.status === 200 && imageRestore.data.item?.deletedAt === null);
  const galleryRestored = await request("/api/gallery?limit=50", { cookie });
  check("после restore картинка снова в галерее", galleryRestored.data.total === 1);

  await request("/api/library/trash", { method: "POST", cookie, body: { ref: imageRef } });
  const imagePurge = await request("/api/library/purge", { method: "DELETE", cookie, body: { ref: imageRef } });
  check("purge картинки → 200", imagePurge.status === 200 && imagePurge.data.ok === true, `статус ${imagePurge.status}`);
  const galleryPurged = await request("/api/gallery?limit=50&view=trash", { cookie });
  check("после purge картинки нет в корзине", galleryPurged.data.total === 0);
  check("после purge файл картинки удалён физически", !fs.existsSync(path.join(studioDir, "img1.png")));

  /* 10. роли: viewer только смотрит */
  const viewerPass = "viewer-pass-123";
  const createViewer = await request("/api/users", {
    method: "POST",
    cookie,
    body: { login: "probe-viewer", password: viewerPass, role: "viewer" },
  });
  check("admin создаёт viewer", createViewer.status === 201, `статус ${createViewer.status}`);
  const viewer = await login("probe-viewer", viewerPass);
  check("viewer входит", viewer.res.status === 200 && Boolean(viewer.cookie));
  const viewerLibrary = await request("/api/library?view=all", { cookie: viewer.cookie });
  check("viewer GET /api/library → 200", viewerLibrary.status === 200, `статус ${viewerLibrary.status}`);
  const viewerMark = await request("/api/library/mark", { method: "POST", cookie: viewer.cookie, body: { ref: `chat:${promptId}`, fav: true } });
  check("viewer POST /api/library/mark → 403", viewerMark.status === 403, `статус ${viewerMark.status}`);
  const viewerTrash = await request("/api/library/trash", { method: "POST", cookie: viewer.cookie, body: { ref: `chat:${promptId}` } });
  check("viewer POST /api/library/trash → 403", viewerTrash.status === 403, `статус ${viewerTrash.status}`);
  const viewerPurge = await request("/api/library/purge", { method: "DELETE", cookie: viewer.cookie, body: { ref: `chat:${promptId}` } });
  check("viewer DELETE /api/library/purge → 403", viewerPurge.status === 403, `статус ${viewerPurge.status}`);

  check("MOCK не сломал чат промтов (после проверок он на месте)", (await request("/api/studio/sessions?view=all", { cookie })).data.sessions?.some((s) => s.id === promptId));
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
