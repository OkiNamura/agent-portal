import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
import { collectAlerts, resumeWatch, saveWatchState } from "./lib/watch.mjs";
import { Studio, generateImage, listImageModels } from "./lib/studio.mjs";
import { buildPptx } from "./lib/pptx.mjs";
import { Library, normalizeView, parseRef, matchesView } from "./lib/library.mjs";
import { buildProjectZipEntries, zipStream } from "./lib/zip-pack.mjs";
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
/* Одноразовый (долгоживущий) токен для статики: /studio/x.png?token=... и /preview/...?token=... */
const PORTAL_TOKEN = String(process.env.PORTAL_TOKEN ?? "").trim();
const PUBLIC = path.join(ROOT, "public");
/* CONFIG_DIR можно переопределить для проверок: снимки и настройки не должны
   трогать боевой config/ во время прогона проб. */
const CONFIG_DIR = process.env.CONFIG_DIR ? path.resolve(process.env.CONFIG_DIR) : path.join(ROOT, "config");
/* Снимки состояния: по умолчанию <корень>/snapshots, для проб — временный каталог. */
const SNAPSHOTS_DIR = process.env.SNAPSHOTS_DIR ? path.resolve(process.env.SNAPSHOTS_DIR) : path.join(ROOT, "snapshots");

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

/**
 * Ручной возврат блока: комментарий заказчика кладём в block.userDefects,
 * а здесь дописываем его в промт следующего fix-вызова. Сам engine.mjs не
 * трогаем — обёртка живёт только в портале и не меняет остальные вызовы.
 */
const engineCall = engine.call.bind(engine);
engine.call = async function callWithUserDefects(run, agent, opts) {
  const userDefects = opts?.meta?.block?.userDefects ?? [];
  if (opts?.kind === "fix" && userDefects.length) {
    const extra = userDefects
      .slice(-5)
      .map((d, i) => `${i + 1}. [${d.severity ?? "major"}] ${d.where ?? "замечание заказчика"}: ${d.what}`)
      .join("\n");
    return engineCall(run, agent, {
      ...opts,
      user: `${opts.user}\n\nЗамечания заказчика из ручного возврата (обязательны к исправлению):\n${extra}`,
    });
  }
  return engineCall(run, agent, opts);
};

/** Ключ из настроек должен включать LIVE, даже если в .env его нет. */
function syncKeyToEnv() {
  const k = keys.resolve(null);
  if (k?.key) process.env.OPENROUTER_API_KEY = k.key;
}
syncKeyToEnv();

const mailbox = new Mailbox(ROOT);
const studio = new Studio(ROOT);
const library = new Library(studio.dir);

/* ------------------- классификация углового чата ------------------- */

/*
 * У каждой почты/алерта есть tab: critical | notice | chat.
 * Явное поле tab главнее; старые записи без него раскладываем по kind/level.
 * Ошибки прогонов и алерты уровня error/bad — в «Критичное», переписка —
 * в «Чат», всё остальное (гейты, завершения, предупреждения) — в «Оповещения».
 */
const MAIL_TABS = Object.freeze(["critical", "notice", "chat"]);
const CRITICAL_MAIL_KINDS = new Set(["error", "call_failed", "stop", "stopped", "fail", "failed", "crash", "crashed"]);

function classifyMailTab(item = {}) {
  if (MAIL_TABS.includes(item.tab)) return item.tab;
  const kind = String(item.kind ?? "").toLowerCase();
  const level = String(item.level ?? "").toLowerCase();
  if (CRITICAL_MAIL_KINDS.has(kind) || level === "error" || level === "bad") return "critical";
  if (kind === "chat" || ["user", "assistant", "harness"].includes(String(item.from ?? ""))) return "chat";
  return "notice";
}

/** Проставляет tab старым сообщениям и сохраняет файл, если что-то поменялось. */
function ensureMailTabs() {
  let changed = false;
  for (const item of mailbox.items) {
    const tab = classifyMailTab(item);
    if (item.tab !== tab) {
      item.tab = tab;
      changed = true;
    }
  }
  if (changed) mailbox.save();
}

/** Добавить сообщение сразу с классификацией. */
function addMail(fields) {
  const item = mailbox.add(fields);
  item.tab = classifyMailTab(item);
  mailbox.save();
  return item;
}

/** Счётчики по вкладкам: всего и непрочитанных. */
function mailTabSummary() {
  ensureMailTabs();
  const tabs = Object.fromEntries(MAIL_TABS.map((t) => [t, { total: 0, unread: 0 }]));
  for (const item of mailbox.items) {
    const tab = classifyMailTab(item);
    tabs[tab].total += 1;
    if (!item.read) tabs[tab].unread += 1;
  }
  return tabs;
}

function validMailTab(raw) {
  return MAIL_TABS.includes(raw) ? raw : null;
}

ensureMailTabs();


/* ------------------------- типы чатов и библиотека ------------------------- */

function sessionRef(id) {
  return `chat:${id}`;
}

function imageRef(id) {
  return `image:${id}`;
}

function docRef(id) {
  return `doc:${id}`;
}

/** Чат + его пометки из библиотеки (fav/archived/deletedAt/ref). */
function sessionWithLibrary(s) {
  return { ...s, ref: sessionRef(s.id), ...library.state(sessionRef(s.id)) };
}

/** Список чатов выбранного вида: all — активные, archive — архив, trash — корзина. */
function sessionsForView(rawView) {
  const view = normalizeView(rawView);
  return studio
    .listSessions()
    .map(sessionWithLibrary)
    .filter((s) => matchesView(s, view));
}

/** Активный чат, если он виден в текущем виде; иначе первый из списка. */
function activeIdForView(sessions) {
  if (studio.activeId && sessions.some((s) => s.id === studio.activeId)) return studio.activeId;
  return sessions[0]?.id ?? null;
}

/** Все сущности библиотеки: чаты, картинки и markdown-документы/спеки. */
function libraryCatalog() {
  const out = [];
  const seenDocs = new Set();

  for (const s of studio.sessions) {
    const msgs = studio.readThread(s.id);
    const state = library.state(sessionRef(s.id));
    out.push({
      ref: sessionRef(s.id),
      type: "chat",
      id: s.id,
      ...state,
      title: s.name,
      kind: s.kind,
      createdAt: s.createdAt ?? null,
      at: s.createdAt ?? null,
      messages: msgs.length,
      results: msgs.filter((m) => m.role === "result").length,
    });
    for (const m of msgs) {
      if (m.role !== "doc" || seenDocs.has(m.id)) continue;
      seenDocs.add(m.id);
      const stateDoc = library.state(docRef(m.id));
      out.push({
        ref: docRef(m.id),
        type: "doc",
        id: m.id,
        ...stateDoc,
        title: m.title || "Документ",
        sessionId: s.id,
        kind: m.spec ? "spec" : "doc",
        at: m.at ?? null,
      });
    }
  }

  for (const item of studio.items) {
    const state = library.state(imageRef(item.id));
    out.push({
      ref: imageRef(item.id),
      type: "image",
      id: item.id,
      ...state,
      title: item.prompt || item.file,
      prompt: item.prompt ?? "",
      file: item.file,
      url: `/studio/${item.file}`,
      model: item.model ?? null,
      mediaType: item.mediaType ?? null,
      cost: Number(item.cost ?? 0),
      at: item.at ?? null,
    });
  }

  out.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  return out;
}

function libraryEntries(rawView) {
  const view = normalizeView(rawView);
  return libraryCatalog().filter((entry) => matchesView(entry, view));
}

function libraryCounts() {
  const counts = { all: 0, fav: 0, archive: 0, trash: 0 };
  for (const entry of libraryCatalog()) {
    for (const view of ["all", "fav", "archive", "trash"]) if (matchesView(entry, view)) counts[view]++;
  }
  return counts;
}

/** Существует ли объект, на который указывает ссылка библиотеки. */
function refExists(ref) {
  const { type, id } = parseRef(ref);
  if (type === "chat") return studio.sessions.some((s) => s.id === id);
  if (type === "image") return Boolean(studio.get(id));
  const found = studio.findMessage(id);
  return Boolean(found && found.message.role === "doc");
}

/** Физическое удаление по ссылке библиотеки. */
function purgeRef(ref) {
  const { type, id } = parseRef(ref);

  if (type === "chat") {
    const session = studio.sessions.find((s) => s.id === id);
    if (session) {
      // документы и спеки этого чата больше нигде не нужны — чистим и их пометки
      for (const m of studio.readThread(id)) {
        if (m.role === "doc") library.remove(docRef(m.id));
      }
      studio.removeSession(id);
      const visible = sessionsForView("all");
      if (!visible.some((s) => s.id === studio.activeId)) {
        studio.activeId = visible[0]?.id ?? null;
        studio.saveSessions();
      }
    }
    library.remove(ref);
    return { ref, type, removed: Boolean(session), activeId: studio.activeId };
  }

  if (type === "image") {
    const item = studio.get(id);
    let removed = false;
    if (item) {
      const file = path.resolve(studio.filePath(item));
      const dir = path.resolve(studio.dir) + path.sep;
      if (!file.startsWith(dir)) throw new Error("Файл картинки вне каталога студии");
      try {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } catch (err) {
        throw new Error(`Файл не удалился: ${String(err?.message || err)}`);
      }
      studio.items = studio.items.filter((i) => i.id !== item.id);
      studio.save();
      removed = true;
    }
    library.remove(ref);
    return { ref, type, removed };
  }

  // doc
  const found = studio.findMessage(id);
  let removed = false;
  if (found && found.message.role === "doc") {
    studio.removeMessage(id, found.session.id);
    removed = true;
  }
  library.remove(ref);
  return { ref, type, removed };
}

function sessionKindOf(sid) {
  return studio.sessions.find((s) => s.id === sid)?.kind ?? "images";
}

/* ---------------------- новые типы чатов: спеки и промты ---------------------- */

const PROMPT_ENGINEER_SYSTEM =
  "Ты — промт-инженер для текстовых задач (НЕ для картинок). Заказчик пишет по-русски поверхностно: " +
  "превращаешь это в готовый промт для языковой модели или другого ИИ: роль, цель, контекст, входные данные, " +
  "ограничения, формат ответа, критерии качества. Если задача неясна — сначала задай 1–3 коротких вопроса в поле questions. " +
  "Промт пиши так, чтобы его можно было скопировать и вставить как есть. Если заказчик просит доработать — сохраняй удачное " +
  "из прошлой версии и меняй только то, о чём попросили. Отвечай строго JSON.";

function specPromptFor(previous, request) {
  const base = previous
    ? `Текущая версия спеки (её нужно доработать, а не писать с нуля):\n"""\n${previous}\n"""\n\n`
    : "";
  return `${base}Запрос заказчика: ${request}\n\nВерни СТРОГО JSON: {"title":"короткое название спеки по-русски","markdown":"полная спека в markdown: что входит, чего не входит, критерии приёмки, зависимости, открытые вопросы","reasoning":"2–4 предложения по-русски, что уточнил и почему"}`;
}

function textPromptFor(previous, request) {
  const hist = previous
    ? `Предыдущая версия промта:\n"""\n${previous}\n"""\n\nЗапрос на доработку: ${request}`
    : `Запрос заказчика: ${request}`;
  return `${hist}\n\nВерни СТРОГО JSON: {"title":"короткое название промта по-русски","prompt":"готовый промт целиком, в markdown","reasoning":"2–4 предложения по-русски, как понял задачу и что уточнить","questions":["необязательные уточняющие вопросы"]}`;
}

function lastDocMarkdown(sid) {
  const thread = studio.threadList(sid, 60);
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (m.role === "doc") return String(m.markdown ?? "");
  }
  return "";
}

function lastPromptText(sid) {
  const thread = studio.threadList(sid, 80);
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (m.role === "prompt") return String(m.text ?? "");
  }
  return "";
}

/** Заглушка спеки для MOCK: проверка структуры без ключа и без трат. */
function mockSpecCard(text) {
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "Спека";
  const title = `Спека (MOCK): ${first.slice(0, 60)}`;
  return {
    title,
    markdown: `# ${title}\n\n## Цель\n${first}\n\n## Что входит\n- Минимальная версия по описанию заказчика.\n\n## Чего НЕ входит\n- Всё, что не описано явно.\n\n## Критерии приёмки\n- [ ] Поведение соответствует описанию.\n\n## Открытые вопросы\n- MOCK-режим: реальная модель не вызывалась.\n`,
    reasoning: "MOCK-режим: архитектор не вызывался, показана заглушка структуры спеки.",
  };
}

/** Заглушка текстового промта для MOCK. */
function mockPromptCard(text) {
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "Задача";
  return {
    title: `Промт (MOCK): ${first.slice(0, 60)}`,
    prompt: `Ты — помощник, который решает задачу заказчика.\n\n## Задача\n${first}\n\n## Контекст\n(опиши входные данные)\n\n## Ограничения\n- Не выдумывай факты.\n- Если данных не хватает — задай вопрос.\n\n## Формат ответа\nКороткий ответ, затем обоснование списком.\n\n<!-- MOCK: реальная модель не вызывалась -->`,
    reasoning: "MOCK-режим: промт-инженер не вызывался, показана заглушка готового промта.",
  };
}

/* ---------- презентации: структура слайдов и .pptx ---------- */

const DECK_SLIDES_MAX = 20;

/** Последняя презентация чата — её архитектор правит при повторном сообщении. */
function lastDeckCard(sid) {
  const thread = studio.threadList(sid, 80);
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (m.role === "deck" && Array.isArray(m.slides)) return { title: m.title ?? "", slides: m.slides };
  }
  return null;
}

/** Сколько слайдов просили (необязательная подсказка, а не жёсткий лимит ответа модели). */
function requestedSlideCount(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const v = Math.floor(n);
  return v >= 2 && v <= DECK_SLIDES_MAX ? v : null;
}

/** Заглушка презентации для MOCK: всегда ровно 2 слайда, но файл собирается по-настоящему. */
function mockDeckCard(text) {
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "Презентация";
  return {
    title: `Презентация (MOCK): ${first.slice(0, 60)}`,
    slides: [
      {
        title: "Титульный слайд",
        bullets: [first.slice(0, 180), "MOCK-режим: архитектор не вызывался, структура — заглушка"],
        notes: "Проверка портала без ключа и без трат.",
      },
      {
        title: "Что внутри",
        bullets: [
          "Два слайда-заглушки, как в задании",
          "Файл .pptx собирается по-настоящему",
          "Повторное сообщение в том же чате — доработка",
        ],
      },
    ],
  };
}

/** Промт архитектору: структура JSON, доработка идёт от текущей презентации. */
function deckPromptFor(previous, request, slideCount) {
  const base = previous?.slides?.length
    ? `Текущая презентация (её нужно доработать, а не писать с нуля; удачное сохрани):\n"""\n${JSON.stringify(previous, null, 2)}\n"""\n\n`
    : "";
  const count = slideCount
    ? `Слайдов должно быть ${slideCount}.`
    : "Слайдов 3–10, если заказчик не просит иначе.";
  return `${base}Запрос заказчика: ${request}\n\n${count} Пиши по-русски. Верни СТРОГО JSON без markdown и пояснений: {"title":"название презентации","slides":[{"title":"заголовок слайда","bullets":["пункт","пункт"],"notes":"необязательные заметки"}]}`;
}

/** Привести ответ модели к структуре сообщения; мусор и пустоту заменяем безопасным дефолтом. */
function normalizeDeckReply(data, request, slideCount) {
  const first = String(request ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() ?? "Презентация";
  const rawSlides = Array.isArray(data?.slides) ? data.slides : [];
  const slides = rawSlides.slice(0, DECK_SLIDES_MAX).map((s, i) => {
    const bullets = (Array.isArray(s?.bullets) ? s.bullets : [])
      .map((b) => String(b ?? "").replace(/\s*\r?\n\s*/g, " ").trim())
      .filter(Boolean)
      .slice(0, 12);
    const slide = {
      title: String(s?.title ?? "").trim().slice(0, 160) || `Слайд ${i + 1}`,
      bullets,
    };
    if (s?.notes) slide.notes = String(s.notes).slice(0, 2000);
    return slide;
  });
  if (slideCount && slides.length > slideCount) slides.length = slideCount;
  if (!slides.length) slides.push({ title: first.slice(0, 120), bullets: [first.slice(0, 300)] });
  return {
    title: String(data?.title ?? "").trim().slice(0, 160) || first.slice(0, 120) || "Презентация",
    slides,
  };
}


let harness = readJson(path.join(CONFIG_DIR, "harness.json"));

/* ---------- дежурный: состояние переживает рестарт (runs/watch.state.json) ---------- */
const watch = { running: false, everyMin: 10, lastRunAt: null, lastAlerts: [], timer: null };

/** Один таймер дежурного: старый гасим, чтобы не плодить параллельные проверки. */
function startWatchTimer(everyMin = watch.everyMin) {
  if (watch.timer) clearInterval(watch.timer);
  watch.everyMin = Math.min(1440, Math.max(1, Math.floor(Number(everyMin) || 10)));
  watch.timer = setInterval(runWatchCheck, watch.everyMin * 60_000);
  watch.timer.unref?.();
  return watch.timer;
}

// при старте возвращаем сохранённое состояние; если дежурный был включён — сразу поднимаем таймер
try {
  const saved = resumeWatch({ runsDir: store.runsDir });
  Object.assign(watch, saved);
  if (watch.running) startWatchTimer(watch.everyMin);
} catch (err) {
  console.error("[watch] не удалось восстановить состояние:", String(err?.message || err));
}

/* ---------- что будит Харнесса: события портала → почтовый ящик ---------- */
bus.on("event", ({ runId, entry }) => {
  const t = harness.triggers ?? {};
  const project = projects.byRun(runId);
  const name = project?.name ?? runId;
  const push = (text, kind, level) => addMail({ from: "system", text, kind, level, runId, projectId: project?.id ?? null });

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

/* ------------------------- ограничение попыток входа ------------------------- */

/*
 * Память процесса: ip → массив меток времени неудачных попыток.
 * Успешный вход стирает запись целиком, поэтому после него снова доступны все
 * попытки. Просроченные метки (старше часа) вычищаются при каждой проверке и
 * по таймеру — Map не растёт от простаивающих адресов.
 */
const LOGIN_WINDOW_5M = 5 * 60 * 1000;
const LOGIN_WINDOW_1H = 60 * 60 * 1000;
const LOGIN_MAX_5M = Math.max(1, Number(process.env.LOGIN_MAX_5M || 5) || 5);
const LOGIN_MAX_1H = Math.max(1, Number(process.env.LOGIN_MAX_1H || 20) || 20);
const loginFailures = new Map();

/** IP клиента: x-forwarded-for учитываем только при TRUST_PROXY=1 (иначе его подделает кто угодно). */
function clientIp(req) {
  const trustProxy = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY ?? "").trim());
  if (trustProxy) {
    const header = req?.headers?.["x-forwarded-for"];
    const raw = Array.isArray(header) ? header[0] : String(header ?? "");
    const first = raw.split(",")[0].trim();
    if (first) return first.replace(/^::ffff:/i, "").toLowerCase();
  }
  return String(req?.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/i, "").toLowerCase();
}

/** Убирает метки старше часа и пустые записи. */
function pruneLoginFailures(now = Date.now()) {
  for (const [ip, times] of loginFailures) {
    const fresh = times.filter((t) => Number.isFinite(t) && now - t < LOGIN_WINDOW_1H);
    if (fresh.length) loginFailures.set(ip, fresh);
    else loginFailures.delete(ip);
  }
}

/**
 * Можно ли пускать этот IP к форме входа.
 * @returns {{ blocked: boolean, retryAfter?: number, minutes?: number }}
 *   retryAfter — секунды для заголовка Retry-After, minutes — для текста ошибки.
 */
function loginGate(ip, now = Date.now()) {
  pruneLoginFailures(now);
  const times = loginFailures.get(ip) ?? [];
  const within5m = times.filter((t) => now - t < LOGIN_WINDOW_5M);
  const within1h = times.filter((t) => now - t < LOGIN_WINDOW_1H);

  let waitMs = 0;
  if (within5m.length >= LOGIN_MAX_5M) {
    waitMs = Math.max(waitMs, within5m[0] + LOGIN_WINDOW_5M - now);
  }
  if (within1h.length >= LOGIN_MAX_1H) {
    waitMs = Math.max(waitMs, within1h[0] + LOGIN_WINDOW_1H - now);
  }
  if (!waitMs) return { blocked: false };

  const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
  return { blocked: true, retryAfter, minutes: Math.max(1, Math.ceil(retryAfter / 60)) };
}

/** Неудачная попытка: записываем метку (blocked-попытки сюда не попадают). */
function recordLoginFailure(ip, now = Date.now()) {
  const times = (loginFailures.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_1H);
  times.push(now);
  loginFailures.set(ip, times);
  // Страховка от вала неудач с одного адреса — не копим больше лимита за час.
  if (times.length > LOGIN_MAX_1H) times.splice(0, times.length - LOGIN_MAX_1H);
}

function resetLoginFailures(ip) {
  loginFailures.delete(ip);
}

const loginPruneTimer = setInterval(() => pruneLoginFailures(), 10 * 60 * 1000);
loginPruneTimer.unref?.();

/* ------------------------------ защита статики ------------------------------ */

/** Постоянное сравнение: длина и содержимое не дают тайминговой утечки токена. */
function tokenMatches(given) {
  if (!PORTAL_TOKEN || typeof given !== "string" || !given) return false;
  const a = crypto.createHash("sha256").update(given, "utf8").digest();
  const b = crypto.createHash("sha256").update(PORTAL_TOKEN, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Кто смотрит /preview/** и /studio/**: сессия из cookie либо PORTAL_TOKEN в query.
 * @returns {{ login: string, role: string, viaToken?: boolean } | null}
 */
function staticUser(req, url) {
  const user = requireUser(req);
  if (user) return user;
  if (tokenMatches(url?.searchParams?.get("token") ?? "")) {
    return { login: "portal-token", role: "viewer", viaToken: true };
  }
  return null;
}

/** Пишет чанк ZIP-потока с учётом backpressure; рвётся, если клиент ушёл. */
function writeChunk(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.reject(new Error("соединение с клиентом закрыто"));
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("соединение с клиентом закрыто"));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    res.on("drain", onDrain);
    res.on("close", onClose);
    res.on("error", onError);
  });
}

/** Пометки блока из engine: подмены модели, повторная проверка, авто-приём, целостность. */
function blockStateFields(b = {}) {
  return {
    fallbacks: Number(b.fallbacks ?? 0),
    needsRecheck: b.needsRecheck === true,
    autoAccepted: b.autoAccepted === true,
    integrityWarnings: Array.isArray(b.integrityWarnings) ? b.integrityWarnings.slice(-5) : [],
    rechecks: Number(b.rechecks ?? 0),
  };
}

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
    paused: run.paused === true,
    pausedAt: run.pausedAt ?? null,
    pausedStage: run.pausedStage ?? null,
    pausedStatus: run.pausedStatus ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    stageIndex: run.stageIndex,
    awaiting: run.awaiting,
    plan: run.plan,
    fallbacks: Number(run.fallbacks ?? 0),
    blocks: (run.blocks ?? []).map((b) => ({
      id: b.id,
      title: b.title,
      goal: b.goal,
      status: b.status,
      acceptance: b.acceptance,
      deps: b.deps,
      manual: b.manual ?? null,
      userDefects: (b.userDefects ?? []).length,
      test: b.test ? { verdict: b.test.verdict, summary: b.test.summary, defects: b.test.defects, round: b.test.round } : null,
      fixCount: b.fixes?.length ?? 0,
      files: (b.files ?? []).map((f) => f.path),
      ...blockStateFields(b),
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

/** Один и тот же список алертов для /api/alerts и для дежурного. */
function collectPortalAlerts() {
  const runs = allRuns();
  return collectAlerts({
    runs,
    metrics: { agents: agentMetrics(runs) },
    harness,
    projects: projects.list(),
    stages: config.pipeline.stages,
  });
}

function watchSnapshot() {
  return {
    running: watch.running,
    everyMin: watch.everyMin,
    lastRunAt: watch.lastRunAt,
    lastAlerts: watch.lastAlerts,
  };
}

/** Один круг дежурного: алерты → mailbox (без повторов) + SSE-событие watch. */
function runWatchCheck() {
  let alerts = [];
  try {
    alerts = collectPortalAlerts();
  } catch (err) {
    console.error("[watch]", String(err?.message || err));
  }

  const known = new Set(mailbox.items.filter((i) => i.kind === "watch").map((i) => i.text));
  const added = [];
  for (const a of alerts) {
    if (known.has(a.text)) continue;
    known.add(a.text);
    try {
      added.push(
        addMail({
          from: "system",
          text: a.text,
          kind: "watch",
          level: a.level ?? "info",
          runId: a.runId ?? null,
          projectId: a.projectId ?? null,
        })
      );
    } catch (err) {
      console.error("[watch] mailbox:", String(err?.message || err));
    }
  }

  watch.lastRunAt = new Date().toISOString();
  watch.lastAlerts = alerts.map((a) => ({
    level: a.level ?? "info",
    text: a.text,
    runId: a.runId ?? null,
    projectId: a.projectId ?? null,
  }));
  // состояние дежурного переживает рестарт: сохраняем после каждого круга
  saveWatchState(watch, { runsDir: store.runsDir });

  bus.emit("watch", { ...watchSnapshot(), added: added.length, lastAdded: added.slice(-5) });
  return added.length;
}

function stopWatch() {
  if (watch.timer) clearInterval(watch.timer);
  watch.timer = null;
  watch.running = false;
  saveWatchState(watch, { runsDir: store.runsDir });
  return watchSnapshot();
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

/** Текущая стадия прогона с учётом выключенных стадий пайплайна. */
function currentStage(run) {
  const stages = config.pipeline.stages.filter((s) => s.enabled !== false);
  return stages[run?.stageIndex ?? -1] ?? null;
}

/* ---------------------------- пауза проекта ---------------------------- */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function projectForRun(run) {
  return projects.byRun(run.id) ?? (run.projectId ? projects.get(run.projectId) : null);
}

function clearProjectPause(project) {
  if (!project) return;
  project.paused = false;
  project.pausedAt = null;
  project.pausedStage = null;
  project.pausedRunId = null;
  project.updatedAt = new Date().toISOString();
}

/**
 * Мягкая пауза: движок не прерываем посреди вызова модели — даём стадии
 * доиграть, а сами сразу показываем paused. После завершения активного
 * прогона фиксируем стадию, на которой остановились.
 */
async function settlePause(runId) {
  const started = Date.now();
  while (engine.active.has(runId) && Date.now() - started < 5 * 60_000) await delay(150);
  let run;
  try {
    run = store.load(runId);
  } catch {
    return;
  }
  if (!run?.paused) return;
  const project = projectForRun(run);
  if (["done", "failed", "cancelled"].includes(run.status)) {
    // прогон успел закончиться сам — пауза уже не имеет смысла
    run.paused = false;
    run.pausedAt = null;
    run.pausedStage = null;
    run.pausedStatus = null;
    store.save(run);
    if (project) {
      clearProjectPause(project);
      projects.save();
    }
    bus.emit("state", { runId, run });
    return;
  }
  if (run.status === "awaiting" && run.awaiting) run.pausedStatus = "awaiting";
  else if (run.status === "awaiting_plan") run.pausedStatus = "awaiting_plan";
  const stageId = run.awaiting?.stageId ?? currentStage(run)?.id ?? run.pausedStage ?? null;
  run.status = "paused";
  run.paused = true;
  run.pausedStage = stageId;
  store.save(run);
  if (project) {
    project.paused = true;
    project.pausedAt = project.pausedAt ?? run.pausedAt ?? new Date().toISOString();
    project.pausedStage = stageId;
    project.pausedRunId = run.id;
    projects.save();
  }
  bus.emit("state", { runId, run });
}

/** Остановить прогон «мягко»: статус paused + отметки в проекте. */
function pauseRun(run) {
  const now = new Date().toISOString();
  const stageId = run.awaiting?.stageId ?? currentStage(run)?.id ?? null;
  run.paused = true;
  run.pausedStatus = run.status;
  run.pausedAt = now;
  run.pausedStage = stageId;
  run.status = "paused";
  store.save(run);
  const project = projectForRun(run);
  if (project) {
    project.paused = true;
    project.pausedAt = now;
    project.pausedStage = stageId;
    project.pausedRunId = run.id;
    project.updatedAt = now;
    projects.save();
  }
  bus.emit("state", { runId: run.id, run });
  settlePause(run.id).catch((err) => console.error("[pause]", String(err?.message || err)));
  return { run, project };
}

/**
 * Продолжить с той же стадии. Если пауза застала гейт — возвращаем awaiting
 * (пользователь сам примет решение), иначе отдаём прогон движку.
 */
function resumePausedRun(run) {
  let was = run.pausedStatus ?? "running";
  // Движок мог успеть перевести стадию в awaiting/awaiting_plan, пока пауза
  // фиксировалась: уважаем его актуальный статус, а не только снимок на момент клика.
  if (run.status === "awaiting" && run.awaiting) was = "awaiting";
  else if (run.status === "awaiting_plan") was = "awaiting_plan";
  else if (["done", "failed", "cancelled"].includes(run.status)) was = run.status;
  const project = projectForRun(run);
  run.paused = false;
  run.pausedAt = null;
  run.pausedStage = null;
  run.pausedStatus = null;
  if (project) {
    clearProjectPause(project);
    projects.save();
  }
  if (was === "done" || was === "failed" || was === "cancelled") {
    // прогон закончился сам, пока шла пауза — продолжать нечего
    store.save(run);
    bus.emit("state", { runId: run.id, run });
    return { resumed: was };
  }
  if (was === "awaiting" && run.awaiting) {
    run.status = "awaiting";
    store.save(run);
    bus.emit("state", { runId: run.id, run });
    return { resumed: "awaiting" };
  }
  if (was === "awaiting_plan") {
    run.status = "awaiting_plan";
    store.save(run);
    bus.emit("state", { runId: run.id, run });
    return { resumed: "awaiting_plan" };
  }
  engine.resume(run).catch((err) => console.error("[engine]", err));
  return { resumed: "running" };
}


/** Ручные решения по блокам доступны только на стадии «Проверка». */
function inVerification(run) {
  if (!run) return false;
  if (["done", "cancelled"].includes(run.status)) return false;
  return currentStage(run)?.kind === "verify" || run.awaiting?.stageId === "verify";
}

/**
 * Все блоки приняты вручную → прогон должен завершиться.
 * Не дублируем завершение: выставляем stageIndex за последнюю стадию и отдаём
 * прогон обычному engine.tick, где уже есть ветка `stageIndex >= stages.length`.
 */
async function completeIfAllBlocksAccepted(run) {
  if (!run.blocks?.length) return false;
  // Завершаем только когда КАЖДЫЙ блок принят именно вручную: авто-verified
  // ещё не значит, что заказчик посмотрел блок на гейте.
  if (run.blocks.some((b) => b.status !== "verified" || b.manual?.decision !== "accept")) return false;
  const stages = config.pipeline.stages.filter((s) => s.enabled !== false);
  run.awaiting = null;
  run.cancelled = false;
  run.stageIndex = stages.length;
  run.status = "running";
  store.save(run);
  await engine.start(run);
  return run.status === "done";
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

/* ------------------------- снимки состояния портала ------------------------- */

const SNAPSHOT_ID_RE = /^[\w.-]+$/;

function snapshotSlug(raw) {
  const map = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  const text = String(raw ?? "").trim().toLowerCase();
  let out = "";
  for (const ch of text) out += map[ch] ?? ch;
  out = out.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return out || "manual";
}

function snapshotStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Файлы, которые входят в снимок: относительный путь в снимке → реальный путь. */
function snapshotSources() {
  const out = [{ rel: "projects.json", abs: projects.file }];
  for (const name of ["agents.json", "pipeline.json", "harness.json"]) {
    out.push({ rel: `config/${name}`, abs: path.join(CONFIG_DIR, name) });
  }
  out.push({ rel: "studio/sessions.json", abs: studio.sessionsFile });
  out.push({ rel: "studio/library.json", abs: library.file });
  if (fs.existsSync(store.runsDir)) {
    for (const id of fs.readdirSync(store.runsDir)) {
      if (!SNAPSHOT_ID_RE.test(id)) continue;
      const rel = `runs/${id}/state.json`;
      const abs = path.join(store.runDir(id), "state.json");
      if (fs.existsSync(abs)) out.push({ rel, abs });
    }
  }
  return out;
}

/** Обратное отображение: путь в снимке → путь, который можно перезаписать при restore. */
function snapshotTarget(rel) {
  const norm = String(rel ?? "").replace(/\\/g, "/");
  if (norm === "projects.json") return projects.file;
  if (/^config\/[A-Za-z0-9._-]+\.json$/.test(norm)) return path.join(CONFIG_DIR, path.basename(norm));
  if (norm === "studio/sessions.json") return studio.sessionsFile;
  if (norm === "studio/library.json") return library.file;
  const runMatch = norm.match(/^runs\/([\w.-]+)\/state\.json$/);
  if (runMatch) return path.join(store.runDir(runMatch[1]), "state.json");
  return null;
}

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* файл исчез — не считаем */
      }
    }
  }
  return total;
}

function snapshotInfo(id) {
  const dir = path.join(SNAPSHOTS_DIR, id);
  let manifest = null;
  try {
    manifest = readJson(path.join(dir, "manifest.json"));
  } catch {
    manifest = null;
  }
  const stat = fs.statSync(dir);
  const runs = manifest?.runs ?? (fs.existsSync(path.join(dir, "runs")) ? fs.readdirSync(path.join(dir, "runs")).length : 0);
  return {
    id,
    name: manifest?.name ?? id,
    createdAt: manifest?.createdAt ?? stat.mtime.toISOString(),
    size: manifest?.size ?? dirSize(dir),
    runs,
    files: manifest?.files?.length ?? null,
  };
}

function listSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SNAPSHOT_ID_RE.test(entry.name)) continue;
    if (!fs.existsSync(path.join(SNAPSHOTS_DIR, entry.name, "manifest.json"))) continue;
    try {
      out.push(snapshotInfo(entry.name));
    } catch {
      /* битый снимок — пропускаем */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Создать снимок: копирует файлы, повторяя структуру исходного портала. */
function createSnapshot(rawName) {
  const name = String(rawName ?? "").trim().slice(0, 120) || "снимок";
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const base = `${snapshotStamp()}-${snapshotSlug(name)}`;
  let id = base;
  for (let n = 2; fs.existsSync(path.join(SNAPSHOTS_DIR, id)); n++) id = `${base}-${n}`;
  const dir = path.join(SNAPSHOTS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  let runs = 0;
  for (const src of snapshotSources()) {
    if (!fs.existsSync(src.abs) || fs.statSync(src.abs).isDirectory()) continue;
    const target = path.join(dir, src.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src.abs, target);
    const size = fs.statSync(target).size;
    files.push({ rel: src.rel, size });
    if (src.rel.startsWith("runs/")) runs++;
  }
  const manifest = {
    version: 1,
    id,
    name,
    createdAt: new Date().toISOString(),
    runs,
    size: dirSize(dir),
    files,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

function snapshotDir(id) {
  const value = String(id ?? "");
  if (!SNAPSHOT_ID_RE.test(value)) throw new Error("Некорректный id снимка");
  const dir = path.resolve(SNAPSHOTS_DIR, value);
  const root = path.resolve(SNAPSHOTS_DIR);
  if (dir !== path.join(root, value) || !dir.startsWith(root + path.sep)) throw new Error("Снимок вне каталога снимков");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Снимок ${value} не найден`);
  return dir;
}

/** Перечитать то, что могло измениться на диске после restore. */
function reloadAfterRestore() {
  try {
    config = readConfig();
    engine.config = config;
  } catch (err) {
    console.error("[snapshot] config не перечитался:", String(err?.message || err));
  }
  try {
    harness = readJson(path.join(CONFIG_DIR, "harness.json"));
  } catch {
    /* оставим прежний */
  }
  try {
    const raw = readJson(projects.file);
    projects.items = Array.isArray(raw.projects) ? raw.projects : [];
  } catch {
    projects.items = [];
  }
  store.cache.clear();
  try {
    if (fs.existsSync(studio.sessionsFile)) {
      const raw = readJson(studio.sessionsFile);
      studio.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
      studio.activeId = raw.activeId ?? studio.sessions[0]?.id ?? null;
    }
  } catch {
    /* студия останется как была */
  }
  try {
    library.load();
  } catch {
    /* пометки библиотеки не критичны */
  }
}

/** Восстановить файлы снимка; сначала обязательно снимок текущего состояния. */
function restoreSnapshot(id) {
  const dir = snapshotDir(id);
  const manifest = readJson(path.join(dir, "manifest.json"));
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  if (!entries.length) throw new Error("В снимке нет файлов");
  const before = createSnapshot("before-restore");
  let restored = 0;
  const skipped = [];
  for (const entry of entries) {
    const target = snapshotTarget(entry.rel);
    if (!target) {
      skipped.push(entry.rel);
      continue;
    }
    const source = path.join(dir, entry.rel);
    if (!fs.existsSync(source)) {
      skipped.push(entry.rel);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    restored++;
  }
  reloadAfterRestore();
  return { snapshot: snapshotInfo(id), before, restored, skipped };
}

function deleteSnapshot(id) {
  const dir = snapshotDir(id);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return { ok: true, id };
}


function serveFile(res, file, cacheSeconds = 0) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: "not found" });
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": body.length,
    // private: файлы за входом не должны попадать в общие кэши (в т.ч. при ?token=)
    "Cache-Control": cacheSeconds ? `private, max-age=${cacheSeconds}` : "no-store",
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
function servePreview(res, pathname, token = null) {
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
  // редирект на точку входа не должен терять ?token= (иначе браузер без cookie получит 401)
  const query = token ? `?token=${encodeURIComponent(token)}` : "";

  if (kind === "mockup") return serveFile(res, path.join(base, "artifacts", "mockup.html"));

  if (kind === "app") {
    if (!rest.length) {
      const entry = findEntry(run);
      if (!entry) return json(res, 404, { error: "в проекте нет html-файлов" });
      res.writeHead(302, { Location: `/preview/${run.id}/app/${entry}${query}` });
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
    // статика прогонов и студии — только по сессии (или ?token=PORTAL_TOKEN)
    if (pathname.startsWith("/studio/") || pathname.startsWith("/preview/")) {
      if (!staticUser(req, url)) return json(res, 401, { error: "нужен вход" });
    }
    if (pathname.startsWith("/studio/")) {
      const file = pathname.slice("/studio/".length);
      const item = studio.items.find((i) => i.file === file);
      if (!item) return json(res, 404, { error: "not found" });
      return serveFile(res, studio.filePath(item), 3600);
    }
    if (pathname.startsWith("/preview/")) return servePreview(res, pathname, url.searchParams.get("token"));
    if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname);

    /* ------------------------------ авторизация ------------------------------ */

    const method = req.method ?? "GET";

    // публичные маршруты входа/выхода
    if (pathname === "/api/login") {
      if (method === "GET") return json(res, 200, { ok: true, login: "/api/login (POST)" });
      if (method === "POST") {
        const ip = clientIp(req);
        const body = await readBody(req);
        // Сначала проверяем пару: верный пароль всегда пускает и обнуляет счётчик,
        // а лимит считает только неудачи (заблокировать себя опечаткой нельзя).
        const user = verify(body.login, body.password);
        if (!user) {
          const gate = loginGate(ip);
          if (gate.blocked) {
            res.setHeader("Retry-After", String(gate.retryAfter));
            return json(res, 429, { error: `слишком много попыток входа, попробуй через ${gate.minutes} минут` });
          }
          recordLoginFailure(ip);
          return json(res, 401, { error: "неверный логин или пароль" });
        }
        resetLoginFailures(ip);
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

    /* ---------- общий поток: сейчас это события дежурного ---------- */
    if (pathname === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ watch: watchSnapshot() })}\n\n`);
      const onWatch = (payload) => res.write(`event: watch\ndata: ${JSON.stringify(payload)}\n\n`);
      bus.on("watch", onWatch);
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ping);
        bus.off("watch", onWatch);
      });
      return;
    }

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
      // к сводке прогона добавляем пометки блоков: UI и проверки видят fallbacks/recheck/auto/integrity
      const runs = store.list().map((r) => {
        try {
          const full = store.load(r.id);
          return {
            ...r,
            fallbacks: Number(full.fallbacks ?? 0),
            blocks: (full.blocks ?? []).map((b) => ({ id: b.id, ...blockStateFields(b) })),
          };
        } catch {
          return { ...r, fallbacks: 0, blocks: [] };
        }
      });
      return json(res, 200, {
        mode: isMock() ? "mock" : "live",
        port: PORT,
        agents: config.agents,
        pipeline: config.pipeline,
        runs,
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
      if (projectId) {
        const proj = projects.get(projectId);
        if (proj?.paused) {
          return json(res, 409, {
            error: `Проект «${proj.name}» на паузе — сначала продолжите прогон${proj.pausedStage ? ` (стадия «${proj.pausedStage}»)` : ""}`,
            project: withRuns(proj),
          });
        }
      }
      if (!projectId) projectId = projects.create({ name: task.slice(0, 80), task }).id;

      const run = store.create(task, { base, change, projectId });
      projects.attach(projectId, run.id);
      if (harness.triggers?.projectStart) {
        const proj = projects.get(projectId);
        addMail({
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
          return ["running", "awaiting", "awaiting_plan", "paused"].includes(store.load(id).status);
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

    /* ------------------------------ снимки ------------------------------ */

    if (pathname === "/api/snapshots" && method === "GET") {
      return json(res, 200, { snapshots: listSnapshots(), dir: SNAPSHOTS_DIR });
    }

    if (pathname === "/api/snapshots" && method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      try {
        const manifest = createSnapshot(body.name);
        return json(res, 201, { snapshot: snapshotInfo(manifest.id), snapshots: listSnapshots() });
      } catch (err) {
        return json(res, 500, { error: `Снимок не создался: ${String(err?.message || err)}` });
      }
    }

    const snm = pathname.match(/^\/api\/snapshots\/([\w.-]+)(?:\/(restore))?$/);
    if (snm) {
      const [, snapshotId, action] = snm;
      if (action === "restore" && method === "POST") {
        if (user.role !== "admin") return json(res, 403, { error: "восстанавливать снимки может только администратор" });
        try {
          const result = restoreSnapshot(snapshotId);
          return json(res, 200, { ok: true, ...result, snapshots: listSnapshots() });
        } catch (err) {
          return json(res, 400, { error: `Не удалось восстановить: ${String(err?.message || err)}` });
        }
      }
      if (!action && method === "DELETE") {
        try {
          deleteSnapshot(snapshotId);
          return json(res, 200, { ok: true, id: snapshotId, snapshots: listSnapshots() });
        } catch (err) {
          return json(res, 404, { error: String(err?.message || err) });
        }
      }
      if (!action && method === "GET") {
        try {
          snapshotDir(snapshotId);
          return json(res, 200, { snapshot: snapshotInfo(snapshotId) });
        } catch (err) {
          return json(res, 404, { error: String(err?.message || err) });
        }
      }
    }

    /*
     * «Очистить несуществующие»: у проекта нет ни одного живого прогона на
     * диске (state.json) и нет своего каталога projects/<id> (если такой
     * каталог вообще используется). Проекты с живыми прогонами не трогаем.
     */
    if (pathname === "/api/projects/cleanup" && req.method === "POST") {
      const projectsRoot = path.join(ROOT, "projects");
      const hasProjectDirs = fs.existsSync(projectsRoot) && fs.statSync(projectsRoot).isDirectory();
      const liveIdsFor = (project) =>
        (project.runIds ?? []).filter((id) => /^[\w.-]+$/.test(String(id)) && fs.existsSync(path.join(store.runDir(id), "state.json")));
      const removed = [];
      const kept = [];
      for (const project of projects.list()) {
        const live = liveIdsFor(project);
        const hasDir = hasProjectDirs && fs.existsSync(path.join(projectsRoot, project.id));
        if (live.length || hasDir) {
          kept.push({ id: project.id, name: project.name, liveRuns: live.length });
          continue;
        }
        removed.push({ id: project.id, name: project.name, runs: project.runIds?.length ?? 0 });
      }
      if (removed.length) {
        const gone = new Set(removed.map((p) => p.id));
        projects.items = projects.items.filter((p) => !gone.has(p.id));
        projects.save();
      }
      return json(res, 200, {
        ok: true,
        removed: removed.length,
        kept: kept.length,
        projects: removed,
        projectDirs: hasProjectDirs ? "checked" : "runs-only",
      });
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
          if (!["running", "awaiting", "awaiting_plan", "interrupted", "paused"].includes(r.status)) continue;
          const stage = config.pipeline.stages[r.stageIndex];
          const pausedStage = r.pausedStage ? config.pipeline.stages.find((s) => s.id === r.pausedStage) : null;
          tasks.push({
            runId: r.id,
            projectId: p.id,
            project: p.name,
            status: r.status,
            stage: (r.status === "paused" ? pausedStage?.title : stage?.title) ?? "—",
            awaiting: r.status === "paused" ? "на паузе" : r.awaiting?.title ?? null,
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
        .filter((i) => !library.isDeleted(imageRef(i.id)))
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
      const alerts = collectPortalAlerts().map((a) => ({
        ...a,
        tab: a.level === "bad" || a.level === "error" ? "critical" : "notice",
      }));
      return json(res, 200, { alerts });
    }

    /* ------------------------------ дежурный ------------------------------ */

    if (pathname === "/api/watch" && method === "GET") {
      return json(res, 200, watchSnapshot());
    }

    if (pathname === "/api/watch/start" && method === "POST") {
      if (user.role !== "admin") return json(res, 403, { error: "дежурного включает администратор" });
      const body = await readBody(req).catch(() => ({}));
      const raw = Number(body.everyMin ?? watch.everyMin);
      // минимум 1 минута; нечисловое значение — текущий интервал
      const base = Number.isFinite(raw) ? Math.floor(raw) : watch.everyMin;
      const everyMin = Math.min(1440, Math.max(1, base));
      watch.everyMin = everyMin;
      watch.running = true;
      runWatchCheck(); // первый круг сразу — иначе непонятно, жив ли дежурный
      startWatchTimer(everyMin);
      saveWatchState(watch, { runsDir: store.runsDir }); // интервал и running — на диск
      return json(res, 200, watchSnapshot());
    }

    if (pathname === "/api/watch/stop" && method === "POST") {
      if (user.role !== "admin") return json(res, 403, { error: "дежурного выключает администратор" });
      return json(res, 200, stopWatch());
    }

    if (pathname === "/api/mailbox" && req.method === "GET") {
      ensureMailTabs();
      const tab = validMailTab(url.searchParams.get("tab"));
      const limitRaw = Number(url.searchParams.get("limit") ?? 100);
      const limit = Number.isFinite(limitRaw) ? Math.min(400, Math.max(1, Math.floor(limitRaw))) : 100;
      const source = tab ? mailbox.items.filter((i) => classifyMailTab(i) === tab) : mailbox.items;
      return json(res, 200, {
        items: source.slice(-limit),
        unread: mailbox.unread(),
        tabs: mailTabSummary(),
        filter: tab,
      });
    }

    if (pathname === "/api/mailbox" && req.method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "Пустое сообщение" });
      const from = body.from === "harness" ? "harness" : body.from === "system" ? "system" : body.from === "assistant" ? "assistant" : "user";
      const item = addMail({ from, text, kind: "chat" });
      return json(res, 200, { item, unread: mailbox.unread(), tabs: mailTabSummary() });
    }

    if (pathname === "/api/mailbox/read" && req.method === "POST") {
      const body = await readBody(req);
      ensureMailTabs();
      const tab = validMailTab(body.tab);
      if (body.all === true) {
        mailbox.markRead([], true);
      } else if (tab) {
        // «прочитать всё» на вкладке: только сообщения этой вкладки
        const ids = mailbox.items.filter((i) => classifyMailTab(i) === tab && !i.read).map((i) => i.id);
        mailbox.markRead(ids);
      } else {
        mailbox.markRead(Array.isArray(body.ids) ? body.ids : []);
      }
      return json(res, 200, { ok: true, unread: mailbox.unread(), tabs: mailTabSummary() });
    }

    if (pathname === "/api/mailbox/clear" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      ensureMailTabs();
      const tab = validMailTab(body.tab);
      if (!tab) return json(res, 400, { error: "Неизвестная вкладка: нужна critical, notice или chat" });
      const before = mailbox.items.length;
      mailbox.items = mailbox.items.filter((i) => classifyMailTab(i) !== tab);
      const removed = before - mailbox.items.length;
      mailbox.save();
      return json(res, 200, { ok: true, tab, removed, unread: mailbox.unread(), tabs: mailTabSummary() });
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

    /* ---------- библиотека: избранное / архив / корзина ---------- */

    if (pathname === "/api/library" && method === "GET") {
      const view = normalizeView(url.searchParams.get("view"));
      return json(res, 200, { view, items: libraryEntries(view), counts: libraryCounts() });
    }

    const markRef = (body) => {
      const { ref } = parseRef(body.ref);
      if (!refExists(ref)) throw Object.assign(new Error("Объект не найден"), { code: 404 });
      return ref;
    };

    if (pathname === "/api/library/mark" && method === "POST") {
      const body = await readBody(req);
      try {
        const ref = markRef(body);
        if (body.fav === undefined && body.archived === undefined) return json(res, 400, { error: "Укажи fav или archived" });
        const patch = {};
        if (body.fav !== undefined) patch.fav = Boolean(body.fav);
        if (body.archived !== undefined) patch.archived = Boolean(body.archived);
        const state = library.mark(ref, patch);
        return json(res, 200, { ok: true, ref, item: { ref, ...state } });
      } catch (err) {
        return json(res, err.code ?? 400, { error: String(err.message) });
      }
    }

    if (pathname === "/api/library/trash" && method === "POST") {
      const body = await readBody(req);
      try {
        const ref = markRef(body);
        const state = library.trash(ref);
        return json(res, 200, { ok: true, ref, item: { ref, ...state } });
      } catch (err) {
        return json(res, err.code ?? 400, { error: String(err.message) });
      }
    }

    if (pathname === "/api/library/restore" && method === "POST") {
      const body = await readBody(req);
      try {
        const ref = markRef(body);
        const state = library.restore(ref);
        return json(res, 200, { ok: true, ref, item: { ref, ...state } });
      } catch (err) {
        return json(res, err.code ?? 400, { error: String(err.message) });
      }
    }

    if (pathname === "/api/library/purge" && method === "DELETE") {
      const body = await readBody(req).catch(() => ({}));
      try {
        const { ref } = parseRef(body.ref);
        const out = purgeRef(ref);
        return json(res, 200, { ok: true, ...out });
      } catch (err) {
        return json(res, err.code ?? 400, { error: String(err.message) });
      }
    }

    if (pathname === "/api/studio/sessions" && req.method === "GET") {
      const view = normalizeView(url.searchParams.get("view"));
      const sessions = sessionsForView(view);
      return json(res, 200, { sessions, activeId: activeIdForView(sessions), view, counts: libraryCounts() });
    }

    if (pathname === "/api/studio/sessions" && req.method === "POST") {
      const body = await readBody(req);
      const kind = String(body.kind ?? "images");
      if (kind === "video") return json(res, 400, { error: "Видео ещё не подключено — такой тип чата пока не работает." });
      if (!["images", "docs", "specs", "prompts", "decks"].includes(kind)) return json(res, 400, { error: `Неизвестный тип чата: ${kind}` });
      const session = studio.createSession({ name: body.name, kind });
      return json(res, 200, { session: sessionWithLibrary(session), sessions: sessionsForView("all"), activeId: studio.activeId, view: "all" });
    }

    if (pathname === "/api/studio/thread" && req.method === "GET") {
      const sid = url.searchParams.get("session") ?? undefined;
      try {
        const thread = studio.threadList(sid, 80); // внутри проверяется существование чата
        if (sid) studio.activeId = sid;
        const session = studio.sessions.find((s) => s.id === (sid ?? studio.activeId)) ?? null;
        return json(res, 200, { thread, activeId: studio.activeId, session: session ? sessionWithLibrary(session) : null });
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
      }
    }

    const sm = pathname.match(/^\/api\/studio\/sessions\/([\w-]+)$/);
    if (sm && req.method === "POST") {
      const body = await readBody(req);
      try {
        const session = studio.renameSession(sm[1], body.name);
        return json(res, 200, { session: sessionWithLibrary(session), sessions: sessionsForView("all") });
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
      }
    }
    if (sm && req.method === "DELETE") {
      // обычное «удалить» в студии теперь мягкое: чат уезжает в корзину библиотеки
      try {
        const id = studio.assertSession(sm[1]);
        const state = library.trash(sessionRef(id));
        const sessions = sessionsForView("all");
        const activeId = activeIdForView(sessions);
        if (studio.activeId === id) {
          studio.activeId = activeId;
          studio.saveSessions();
        }
        return json(res, 200, { ok: true, trashed: true, ref: sessionRef(id), deletedAt: state.deletedAt, sessions, activeId });
      } catch (err) {
        return json(res, 400, { error: String(err.message) });
      }
    }

    if (pathname === "/api/studio/doc" && req.method === "POST") {
      const body = await readBody(req, 2_000_000);
      const text = String(body.text ?? "").trim();
      if (text.length < 2) return json(res, 400, { error: "Пустой текст" });

      let sid;
      try {
        sid = studio.assertSession(body.sessionId ?? undefined);
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
      }
      if (sessionKindOf(sid) !== "docs") return json(res, 409, { error: "Этот чат не для документов — создайте чат «Документы»" });
      if (library.isDeleted(sessionRef(sid))) return json(res, 409, { error: "Чат в корзине — сначала восстановите его" });
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

    /* ---------- презентации: архитектор пишет структуру, сервер собирает .pptx ---------- */

    if (pathname === "/api/studio/deck" && req.method === "POST") {
      const body = await readBody(req, 2_000_000);
      const text = String(body.text ?? "").trim();
      if (text.length < 2) return json(res, 400, { error: "Пустой текст" });

      let sid;
      try {
        sid = studio.assertSession(body.sessionId ?? undefined);
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
      }
      if (sessionKindOf(sid) !== "decks") return json(res, 409, { error: "Этот чат не для презентаций — создайте чат «Презентации»" });
      if (library.isDeleted(sessionRef(sid))) return json(res, 409, { error: "Чат в корзине — сначала восстановите его" });

      const slideCount = requestedSlideCount(body.slideCount);
      // повторное сообщение — доработка: текущую структуру передаём архитектору в промт
      const previous = lastDeckCard(sid);
      studio.threadAdd({ role: "user", text }, sid);

      const mock = isMock();
      let deck;
      let cost = 0;
      let model = null;
      let ms = 0;
      const started = Date.now();

      if (mock) {
        deck = mockDeckCard(text);
      } else {
        try {
          const agent = engine.agent("architect");
          const out = await chat({
            model: agent.model,
            temperature: Number(agent.temperature ?? 0.2),
            maxTokens: 6000,
            apiKey: keys.resolve(agent.id)?.key ?? null,
            system: `${agent.prompt}\n\nТы собираешь структуру презентации: только JSON, без markdown. Заголовки и пункты — по-русски, пункты короткие.`,
            user: deckPromptFor(previous, text, slideCount),
          });
          deck = normalizeDeckReply(extractJson(out.text), text, slideCount);
          cost = Number(out.usage?.cost ?? 0);
          model = out.model ?? agent.model;
          ms = Date.now() - started;
        } catch (err) {
          return json(res, 502, { error: String(err?.message || err), thread: studio.threadList(sid, 80) });
        }
      }

      const filename = `deck-${crypto.randomBytes(6).toString("hex")}.pptx`;
      try {
        const buf = buildPptx(deck);
        studio.saveDeck(filename, buf);
        const msg = studio.threadAdd(
          {
            role: "deck",
            title: deck.title,
            slides: deck.slides,
            file: filename,
            size: buf.length,
            mock,
            cost,
            model,
            ms,
          },
          sid
        );
        return json(res, 200, { message: msg, thread: studio.threadList(sid, 80), mock, file: filename, slides: deck.slides });
      } catch (err) {
        return json(res, 500, { error: `Не удалось собрать .pptx: ${String(err?.message || err)}`, thread: studio.threadList(sid, 80) });
      }
    }

    /* ---------- спеки: архитектор пишет и дорабатывает ТЗ ---------- */

    if (pathname === "/api/studio/spec" && req.method === "POST") {
      const body = await readBody(req, 2_000_000);
      const text = String(body.text ?? "").trim();
      if (text.length < 2) return json(res, 400, { error: "Пустой текст" });

      let sid;
      try {
        sid = studio.assertSession(body.sessionId ?? undefined);
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
      }
      if (sessionKindOf(sid) !== "specs") return json(res, 409, { error: "Этот чат не для спек — создайте чат «Спеки»" });
      if (library.isDeleted(sessionRef(sid))) return json(res, 409, { error: "Чат в корзине — сначала восстановите его" });

      // предыдущая спека нужна для доработки: архитектор правит её, а не пишет с нуля
      const previous = lastDocMarkdown(sid);
      studio.threadAdd({ role: "user", text }, sid);

      if (isMock()) {
        const stub = mockSpecCard(text);
        const msg = studio.threadAdd(
          { role: "doc", spec: true, mock: true, title: stub.title, markdown: stub.markdown, reasoning: stub.reasoning, cost: 0, ms: 0 },
          sid
        );
        return json(res, 200, { message: msg, thread: studio.threadList(sid, 80), mock: true });
      }

      const started = Date.now();
      try {
        const agent = engine.agent("architect");
        const out = await chat({
          model: agent.model,
          temperature: Number(agent.temperature ?? 0.2),
          maxTokens: 6000,
          apiKey: keys.resolve(agent.id)?.key ?? null,
          system: `${agent.prompt}\n\nТы пишешь не код, а спеку-договор в markdown по описанию заказчика. Пиши по-русски.`,
          user: specPromptFor(previous, text),
        });
        let data;
        try {
          data = extractJson(out.text);
        } catch {
          data = { markdown: out.text };
        }
        const markdown = String(data.markdown ?? "").trim() || String(out.text).trim();
        const msg = studio.threadAdd(
          {
            role: "doc",
            spec: true,
            title: String(data.title ?? "Спека").slice(0, 120),
            markdown,
            reasoning: String(data.reasoning ?? ""),
            cost: out.usage.cost,
            model: out.model,
            ms: Date.now() - started,
          },
          sid
        );
        return json(res, 200, { message: msg, thread: studio.threadList(sid, 80) });
      } catch (err) {
        return json(res, 502, { error: String(err?.message || err), thread: studio.threadList(sid, 80) });
      }
    }

    /* ---------- промты: промт-инженер для текстовых задач ---------- */

    if (pathname === "/api/studio/prompt" && req.method === "POST") {
      const body = await readBody(req, 2_000_000);
      const text = String(body.text ?? "").trim();
      if (text.length < 2) return json(res, 400, { error: "Пустой текст" });

      let sid;
      try {
        sid = studio.assertSession(body.sessionId ?? undefined);
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
      }
      if (sessionKindOf(sid) !== "prompts") return json(res, 409, { error: "Этот чат не для промтов — создайте чат «Промты»" });
      if (library.isDeleted(sessionRef(sid))) return json(res, 409, { error: "Чат в корзине — сначала восстановите его" });

      const previous = lastPromptText(sid);
      studio.threadAdd({ role: "user", text }, sid);

      if (isMock()) {
        const stub = mockPromptCard(text);
        const msg = studio.threadAdd(
          { role: "prompt", mock: true, title: stub.title, text: stub.prompt, reasoning: stub.reasoning, cost: 0, ms: 0 },
          sid
        );
        return json(res, 200, { message: msg, thread: studio.threadList(sid, 80), mock: true, agent: "artist" });
      }

      const started = Date.now();
      try {
        // отдельный системный промт в server.mjs, модель берём у художника (ключ тот же)
        const artist = engine.agent("artist");
        const out = await chat({
          model: artist.model,
          temperature: Number(artist.temperature ?? 0.4),
          maxTokens: 4000,
          apiKey: keys.resolve(artist.id)?.key ?? null,
          system: PROMPT_ENGINEER_SYSTEM,
          user: textPromptFor(previous, text),
        });
        let data;
        try {
          data = extractJson(out.text);
        } catch {
          const fenced = String(out.text).match(/```(?:markdown|md|text)?\s*([\s\S]*?)```/i);
          data = { prompt: fenced ? fenced[1] : out.text, reasoning: "" };
        }
        const promptText = String(data.prompt ?? "").trim() || String(out.text).trim();
        const msg = studio.threadAdd(
          {
            role: "prompt",
            title: String(data.title ?? "Промт").slice(0, 120),
            text: promptText,
            reasoning: String(data.reasoning ?? ""),
            questions: Array.isArray(data.questions) ? data.questions.map(String).slice(0, 5) : [],
            cost: out.usage.cost,
            model: out.model,
            ms: Date.now() - started,
          },
          sid
        );
        return json(res, 200, { message: msg, thread: studio.threadList(sid, 80), agent: "artist" });
      } catch (err) {
        return json(res, 502, { error: String(err?.error || err?.message || err), thread: studio.threadList(sid, 80) });
      }
    }

    if (pathname === "/api/studio/message/patch" && req.method === "POST") {
      const body = await readBody(req, 2_000_000);
      const id = String(body.id ?? "");
      if (!id) return json(res, 400, { error: "Не указано сообщение" });
      const patch = {};
      if (typeof body.title === "string") patch.title = body.title.slice(0, 200);
      if (typeof body.markdown === "string") patch.markdown = body.markdown.slice(0, 200_000);
      if (typeof body.text === "string") patch.text = body.text.slice(0, 200_000);
      if (!Object.keys(patch).length) return json(res, 400, { error: "Нечего менять" });
      try {
        const sid = studio.assertSession(body.sessionId ?? undefined);
        const message = studio.patchMessage(id, patch, sid);
        return json(res, 200, { message, thread: studio.threadList(sid, 80) });
      } catch (err) {
        return json(res, 404, { error: String(err.message) });
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

    const dkm = pathname.match(/^\/api\/studio\/deck\/([\w-]+)\.pptx$/);
    if (dkm && req.method === "GET") {
      const found = studio.findMessage(dkm[1]);
      if (!found || found.message.role !== "deck") return json(res, 404, { error: "Презентация не найдена" });
      const deck = found.message;
      let buf;
      try {
        // основной путь — готовый файл в студии; если его убрали руками, честно пересобираем
        const file = studio.deckPath(deck.file);
        buf = fs.existsSync(file) ? fs.readFileSync(file) : buildPptx({ title: deck.title, slides: deck.slides });
      } catch {
        try {
          buf = buildPptx({ title: deck.title, slides: deck.slides });
        } catch (err) {
          return json(res, 500, { error: `Не удалось собрать .pptx: ${String(err?.message || err)}` });
        }
      }
      const name =
        String(deck.title ?? "presentation")
          .replace(/[^\wа-яА-Я\d _-]+/gi, "")
          .trim()
          .slice(0, 60) || "presentation";
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.pptx`,
        "Content-Length": buf.length,
        "Cache-Control": "no-store",
      });
      return res.end(buf);
    }

    if (pathname === "/api/studio/say" && req.method === "POST") {
      const body = await readBody(req, 14_000_000);
      const sid = body.sessionId ?? undefined;
      const text = String(body.text ?? "").trim();
      if (text.length < 2) return json(res, 400, { error: "Пустой запрос" });
      const sess = studio.sessions.find((s) => s.id === (sid ?? studio.activeId));
      if (sess && sess.kind !== "images") return json(res, 501, { error: `Чат типа «${sess.kind}» не принимает такие сообщения — используйте раздел этого типа` });
      if (sess && library.isDeleted(sessionRef(sess.id))) return json(res, 409, { error: "Чат в корзине — сначала восстановите его" });
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
      const chatId = sid ?? studio.activeId;
      if (chatId && library.isDeleted(sessionRef(chatId))) return json(res, 409, { error: "Чат в корзине — сначала восстановите его" });
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
      const chatId = body.sessionId ?? studio.activeId;
      if (chatId && library.isDeleted(sessionRef(chatId))) return json(res, 409, { error: "Чат в корзине — сначала восстановите его" });

      const references = [];
      let refId = null;
      let refItem = null;
      if (body.referenceId) {
        refItem = studio.get(String(body.referenceId));
        if (!refItem) return json(res, 404, { error: "Референс не найден" });
        if (library.isDeleted(imageRef(refItem.id))) return json(res, 409, { error: "Референс в корзине — сначала восстановите его" });
      }
      if (isMock()) return json(res, 502, { error: "MOCK-режим: картинки не генерируются без ключа" });
      if (refItem) {
        references.push(studio.dataUrl(refItem));
        refId = refItem.id;
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
      const view = normalizeView(url.searchParams.get("view") ?? "all");
      const items = studio
        .list(300)
        .map((i) => ({ ...i, ref: imageRef(i.id), ...library.state(imageRef(i.id)) }))
        .filter((i) => matchesView(i, view))
        .slice(0, limit);
      return json(res, 200, { items, view });
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
        if (library.isDeleted(imageRef(item.id))) return json(res, 409, { error: "Референс в корзине — сначала восстановите его" });
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

    /* ------------------------------ галерея ------------------------------ */

    if (pathname === "/api/gallery" && method === "GET") {
      const q = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
      const view = normalizeView(url.searchParams.get("view") ?? "all");
      const raw = Number(url.searchParams.get("limit") ?? 200);
      const limit = Math.max(1, Math.min(Number.isFinite(raw) ? Math.floor(raw) : 200, 300));
      const all = studio
        .list(300) // индекс студии и так не длиннее 300 записей
        .map((i) => ({ ...i, ref: imageRef(i.id), ...library.state(imageRef(i.id)) }))
        .filter((i) => matchesView(i, view));
      const filtered = q ? all.filter((i) => `${i.prompt ?? ""} ${i.model ?? ""}`.toLowerCase().includes(q)) : all;
      const items = filtered.slice(0, limit).map((i) => ({
        id: i.id,
        ref: i.ref,
        file: i.file,
        prompt: i.prompt ?? "",
        model: i.model ?? null,
        cost: Number(i.cost ?? 0),
        at: i.at ?? null,
        url: `/studio/${i.file}`,
        mediaType: i.mediaType ?? null,
        aspectRatio: i.aspectRatio ?? null,
        fav: i.fav,
        archived: i.archived,
        deletedAt: i.deletedAt,
      }));
      return json(res, 200, {
        items,
        total: filtered.length,
        cost: filtered.reduce((sum, i) => sum + Number(i.cost ?? 0), 0),
        limit,
        view,
        counts: libraryCounts(),
      });
    }

    const im = pathname.match(/^\/api\/images\/([\w-]+)$/);
    if (im && method === "DELETE") {
      const item = studio.get(im[1]);
      if (!item) return json(res, 404, { error: "Картинка не найдена" });
      const file = path.resolve(studio.filePath(item));
      const dir = path.resolve(studio.dir) + path.sep;
      if (!file.startsWith(dir)) return json(res, 403, { error: "forbidden" });
      try {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } catch (err) {
        return json(res, 409, { error: `Файл не удалился: ${String(err?.message || err)}` });
      }
      studio.items = studio.items.filter((i) => i.id !== item.id);
      studio.save();
      library.remove(imageRef(item.id));
      return json(res, 200, { ok: true, id: item.id, removed: item.file });
    }

    if (pathname === "/api/assistant" && req.method === "POST") {
      const body = await readBody(req);
      const question = String(body.question ?? "").trim();
      if (!question) return json(res, 400, { error: "Пустой вопрос" });
      const answer = await assistantAnswer(question, Array.isArray(body.history) ? body.history : []);
      return json(res, 200, answer);
    }

    /* ---------- ручное решение по блоку на стадии проверки ---------- */

    const bm = pathname.match(/^\/api\/runs\/([\w.-]+)\/block\/([\w-]+)\/decision$/);
    if (bm && method === "POST") {
      const [, runId, blockId] = bm;
      let run;
      try {
        run = store.load(runId);
      } catch {
        return json(res, 404, { error: "Прогон не найден" });
      }
      if (!inVerification(run)) {
        return json(res, 409, { error: "Решения по блокам доступны только на стадии проверки" });
      }
      const body = await readBody(req);
      const decision = String(body.decision ?? "");
      if (!["accept", "rework"].includes(decision)) return json(res, 400, { error: "decision: accept или rework" });
      const block = (run.blocks ?? []).find((b) => b.id === blockId);
      if (!block) return json(res, 404, { error: `Блок ${blockId} не найден` });
      const comment = String(body.comment ?? "").trim().slice(0, 2000);
      const at = new Date().toISOString();
      block.history = block.history ?? [];

      if (decision === "accept") {
        block.status = "verified";
        block.manual = { decision: "accept", at, by: user.login, comment };
        block.history.push({ at, action: "manual-accept", notes: comment });
        engine.emit(run, "approve", `Блок ${block.id} принят вручную${comment ? `: ${comment}` : ""}`, {
          block: block.id,
          agent: user.login,
          manual: true,
        });
        const completed = await completeIfAllBlocksAccepted(run);
        if (!completed) {
          store.save(run);
          bus.emit("state", { runId: run.id, run });
        }
        return json(res, 200, { run: snapshot(run), completed });
      }

      if (!comment) return json(res, 400, { error: "Для возврата в доработку нужен комментарий — что поправить" });
      block.status = "built";
      block.manual = { decision: "rework", at, by: user.login, comment };
      const defect = {
        severity: "major",
        where: "замечание заказчика",
        what: comment,
        criterion: "требование заказчика",
        source: "user",
        at,
      };
      // Пользовательские дефекты копим отдельно: следующий fix-вызов получит их
      // даже после того, как тестировщик перезапишет block.test.defects.
      block.userDefects = [...(block.userDefects ?? []), defect].slice(-5);
      block.test = block.test ?? {};
      block.test.verdict = "fail";
      block.test.defects = [...(block.test.defects ?? []), defect];
      block.history.push({ at, action: "manual-rework", notes: comment });
      // Существующий механизм feedback для стадии build — на случай повторной сборки.
      run.stageMeta = run.stageMeta ?? {};
      const prev = run.stageMeta.build?.feedback ?? "";
      run.stageMeta.build = { feedback: [prev, comment].filter(Boolean).join("\n") };
      engine.emit(run, "reject", `Блок ${block.id} возвращён в доработку: ${comment}`, {
        block: block.id,
        agent: user.login,
        manual: true,
        comment,
      });
      store.save(run);
      bus.emit("state", { runId: run.id, run });
      return json(res, 200, { run: snapshot(run), completed: false });
    }

    const m = pathname.match(/^\/api\/runs\/([\w.-]+)(?:\/(events|approve|cancel|resume|pause|artifact|plan|diff|export\.zip))?$/);
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

      if (action === "export.zip" && req.method === "GET") {
        let built;
        try {
          const project = projects.byRun(run.id);
          built = buildProjectZipEntries({ run, store, project });
        } catch (err) {
          return json(res, 500, { error: `ZIP не собрался: ${String(err?.message || err)}` });
        }
        const { entries, name, ascii } = built;
        const encoded = encodeURIComponent(name).replace(/['()]/g, (c) => (c === "'" ? "%27" : c === "(" ? "%28" : "%29"));
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        // Архив уходит в ответ по частям: заголовок → данные файла → central directory → EOCD.
        // Content-Length не ставим — размер заранее неизвестен (chunked), память не растёт.
        try {
          for await (const chunk of zipStream(entries)) await writeChunk(res, chunk);
          res.end();
        } catch (err) {
          console.error(`[zip] ${String(err?.message || err)}`);
          res.destroy();
        }
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

      if (action === "pause" && req.method === "POST") {
        if (run.status === "paused") return json(res, 200, { run: snapshot(run), project: projectForRun(run) ? withRuns(projectForRun(run)) : null });
        if (!["running", "awaiting", "awaiting_plan"].includes(run.status)) {
          return json(res, 409, { error: `Нельзя поставить на паузу прогон в статусе «${run.status}»` });
        }
        const { project } = pauseRun(run);
        return json(res, 200, { run: snapshot(run), project: project ? withRuns(project) : null });
      }

      if (action === "cancel" && req.method === "POST") {
        // отмена снимает и паузу проекта: иначе проект останется заперт
        const project = projectForRun(run);
        if (run.paused && project) {
          clearProjectPause(project);
          projects.save();
        }
        run.paused = false;
        run.pausedAt = null;
        run.pausedStage = null;
        run.pausedStatus = null;
        engine.cancel(run);
        bus.emit("state", { runId: id, run });
        return json(res, 200, { run: snapshot(run) });
      }

      if (action === "resume" && req.method === "POST") {
        if (run.paused || run.status === "paused") {
          const { resumed } = resumePausedRun(run);
          const project = projectForRun(run);
          const payload = { run: snapshot(run), resumed, project: project ? withRuns(project) : null };
          if (resumed === "awaiting" || resumed === "awaiting_plan") return json(res, 200, payload);
          if (resumed === "done" || resumed === "failed" || resumed === "cancelled") return json(res, 200, payload);
          return json(res, 202, payload);
        }
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
  if (refItem && library.isDeleted(imageRef(refItem.id))) return { error: "Референс в корзине — сначала восстановите его" };
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
    if (watch.timer) clearInterval(watch.timer);
    watch.timer = null;
    watch.running = false;
    server.close(() => process.exit(0));
    // SSE-потоки (прогоны и дежурный) держат соединения — иначе процесс не выйдет
    server.closeAllConnections?.();
  });
}

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", String(err?.message || err));
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", String(err?.message || err));
});
