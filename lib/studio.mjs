import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  getProviders,
  resolveBaseUrl,
  headersFor,
  apiKeyFor,
  providerHttpError,
  fetchModels,
} from "./providers.mjs";

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };

export class Studio {
  constructor(root) {
    this.dir = process.env.STUDIO_DIR ? path.resolve(process.env.STUDIO_DIR) : path.join(root, "studio");
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexFile = path.join(this.dir, "index.json");
    this.items = [];
    if (fs.existsSync(this.indexFile)) {
      try {
        this.items = JSON.parse(fs.readFileSync(this.indexFile, "utf8").replace(/^\uFEFF/, "")).items ?? [];
      } catch {
        this.items = [];
      }
    }

    // сессии: каждая со своим чатом (картинки / документы / презентации)
    this.sessionsFile = path.join(this.dir, "sessions.json");
    this.threadsDir = path.join(this.dir, "threads");
    fs.mkdirSync(this.threadsDir, { recursive: true });

    this.sessions = [];
    this.activeId = null;
    if (fs.existsSync(this.sessionsFile)) {
      try {
        const j = JSON.parse(fs.readFileSync(this.sessionsFile, "utf8").replace(/^\uFEFF/, ""));
        this.sessions = j.sessions ?? [];
        this.activeId = j.activeId ?? null;
      } catch {
        this.sessions = [];
      }
    }

    // миграция старого одиночного чата
    const legacy = path.join(this.dir, "thread.json");
    if (!this.sessions.length && fs.existsSync(legacy)) {
      let messages = [];
      try {
        messages = JSON.parse(fs.readFileSync(legacy, "utf8").replace(/^\uFEFF/, "")).messages ?? [];
      } catch {
        messages = [];
      }
      const s = { id: "main", name: "Картинки", kind: "images", createdAt: new Date().toISOString() };
      this.sessions.push(s);
      this.activeId = s.id;
      this.writeThread(s.id, messages);
      this.saveSessions();
    }

    if (!this.sessions.length) {
      const s = { id: crypto.randomBytes(3).toString("hex"), name: "Картинки", kind: "images", createdAt: new Date().toISOString() };
      this.sessions.push(s);
      this.activeId = s.id;
      this.saveSessions();
    }
    if (!this.activeId || !this.sessions.some((s) => s.id === this.activeId)) this.activeId = this.sessions[0].id;

    this.threadFile = path.join(this.threadsDir, `${this.activeId}.json`);
  }

  saveSessions() {
    const tmp = `${this.sessionsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessions: this.sessions, activeId: this.activeId }, null, 2), "utf8");
    fs.renameSync(tmp, this.sessionsFile);
  }

  /** Проверка id сессии: только своё, только из списка. Иначе можно уехать в ../../config/keys */
  assertSession(id) {
    const sid = id ?? this.activeId;
    if (!/^[\w-]{1,32}$/.test(String(sid))) throw new Error("Некорректный id чата");
    if (!this.sessions.some((s) => s.id === sid)) throw new Error("Чат не найден");
    return sid;
  }

  threadFileFor(sessionId) {
    const sid = this.assertSession(sessionId);
    return path.join(this.threadsDir, `${sid}.json`);
  }

  readThread(sessionId) {
    const file = this.threadFileFor(sessionId);
    if (!fs.existsSync(file)) return [];
    try {
      return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")).messages ?? [];
    } catch {
      return [];
    }
  }

  writeThread(sessionId, messages) {
    const file = this.threadFileFor(sessionId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ messages }, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  listSessions() {
    return this.sessions.map((s) => ({
      ...s,
      messages: this.readThread(s.id).length,
      results: this.readThread(s.id).filter((m) => m.role === "result").length,
    }));
  }

  createSession({ name, kind = "images" }) {
    const s = {
      id: crypto.randomBytes(3).toString("hex"),
      name: String(name || "Новый чат").slice(0, 80),
      kind,
      createdAt: new Date().toISOString(),
    };
    this.sessions.push(s);
    this.activeId = s.id;
    this.writeThread(s.id, []);
    this.saveSessions();
    return s;
  }

  renameSession(id, name) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error("Чат не найден");
    s.name = String(name || s.name).slice(0, 80);
    this.saveSessions();
    return s;
  }

  /**
   * Физическое удаление чата вместе с его перепиской.
   * Вызывается только из purge библиотеки: обычное «удалить» в студии теперь
   * помещает чат в корзину (см. lib/library.mjs и server.mjs).
   */
  removeSession(id) {
    const sid = this.assertSession(id);
    this.sessions = this.sessions.filter((s) => s.id !== sid);
    try {
      fs.rmSync(path.join(this.threadsDir, `${sid}.json`), { force: true });
    } catch {
      /* уже нет */
    }
    if (this.activeId === sid) this.activeId = this.sessions[0]?.id ?? null;
    this.saveSessions();
    return { sessions: this.listSessions(), activeId: this.activeId };
  }

  /** Старое жёсткое удаление оставлено для совместимости внутренних вызовов. */
  deleteSession(id) {
    if (this.sessions.length <= 1) throw new Error("Нельзя удалить последний чат");
    return this.removeSession(id);
  }

  threadList(sessionId, limit = 60) {
    return this.readThread(sessionId).slice(-limit);
  }

  threadAdd(entry, sessionId) {
    const sid = sessionId || entry.sessionId || this.activeId;
    const messages = this.readThread(sid);
    const msg = { id: crypto.randomBytes(4).toString("hex"), at: new Date().toISOString(), ...entry };
    delete msg.sessionId;
    messages.push(msg);
    if (messages.length > 200) messages.splice(0, messages.length - 200);
    this.writeThread(sid, messages);
    return msg;
  }

  truncateFrom(id, sessionId) {
    const sid = sessionId || this.activeId;
    const messages = this.readThread(sid);
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) throw new Error("Сообщение не найдено");
    const removed = messages.length - idx;
    const kept = messages.slice(0, idx);
    this.writeThread(sid, kept);
    return { removed, thread: kept };
  }

  editMessage(id, patch, sessionId) {
    const sid = sessionId || this.activeId;
    const messages = this.readThread(sid);
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) throw new Error("Сообщение не найдено");
    const msg = messages[idx];
    Object.assign(msg, patch, { editedAt: new Date().toISOString() });
    const removed = messages.length - idx - 1;
    const kept = messages.slice(0, idx + 1);
    this.writeThread(sid, kept);
    return { removed, message: msg, thread: kept };
  }

  /** Правка карточки на месте: без отката следующих сообщений (в отличие от editMessage). */
  patchMessage(id, patch, sessionId) {
    const sid = sessionId || this.activeId;
    const messages = this.readThread(sid);
    const msg = messages.find((m) => m.id === id);
    if (!msg) throw new Error("Сообщение не найдено");
    Object.assign(msg, patch, { editedAt: new Date().toISOString() });
    this.writeThread(sid, messages);
    return { message: msg, thread: messages };
  }

  /** Удалить одно сообщение и оставить остальную переписку. */
  removeMessage(id, sessionId) {
    const sid = sessionId || this.activeId;
    const messages = this.readThread(sid);
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) throw new Error("Сообщение не найдено");
    const [removed] = messages.splice(idx, 1);
    this.writeThread(sid, messages);
    return { removed, thread: messages };
  }

  clearThread(sessionId) {
    const sid = sessionId || this.activeId;
    this.writeThread(sid, []);
    return { thread: [] };
  }

  /** Найти сообщение по id во всех чатах — нужно для скачивания документов. */
  findMessage(id) {
    for (const s of this.sessions) {
      const msgs = this.readThread(s.id);
      const m = msgs.find((x) => x.id === id);
      if (m) return { message: m, session: s };
    }
    return null;
  }

  save() {
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), "utf8");
    fs.renameSync(tmp, this.indexFile);
  }

  list(limit = 60) {
    return this.items.slice(-limit).reverse();
  }

  get(id) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  filePath(item) {
    return path.join(this.dir, item.file);
  }

  /**
   * Файл презентации в студии. Имя приходит из переписки, поэтому проверяем
   * и шаблон, и что итоговый путь не вылез за каталог студии.
   */
  deckPath(file) {
    const name = String(file ?? "");
    if (!/^deck-[A-Za-z0-9_-]{1,40}\.pptx$/.test(name)) throw new Error("Некорректное имя файла презентации");
    const dir = path.resolve(this.dir) + path.sep;
    const full = path.resolve(path.join(this.dir, name));
    if (!full.startsWith(dir)) throw new Error("Файл презентации вне каталога студии");
    return full;
  }

  /** Записать собранный .pptx рядом с картинками. */
  saveDeck(file, buffer) {
    const full = this.deckPath(file);
    fs.writeFileSync(full, buffer);
    return { file, size: buffer.length };
  }

  /** Картинка как data URL — для input_references. */
  dataUrl(item) {
    const p = this.filePath(item);
    if (!fs.existsSync(p)) throw new Error("Файл картинки не найден");
    return `data:${item.mediaType};base64,${fs.readFileSync(p).toString("base64")}`;
  }

  add({ prompt, model, aspectRatio, quality, mediaType, b64, cost, ms, refId }) {
    const id = crypto.randomBytes(5).toString("hex");
    const file = `${id}.${EXT[mediaType] ?? "png"}`;
    fs.writeFileSync(path.join(this.dir, file), Buffer.from(b64, "base64"));
    const item = {
      id,
      at: new Date().toISOString(),
      prompt,
      model,
      aspectRatio: aspectRatio ?? null,
      quality: quality ?? null,
      mediaType,
      file,
      size: fs.statSync(path.join(this.dir, file)).size,
      cost: Number(cost ?? 0),
      ms: Number(ms ?? 0),
      ref: refId ?? null,
    };
    this.items.push(item);
    if (this.items.length > 300) this.items.splice(0, this.items.length - 300);
    this.save();
    return item;
  }
}

/** Размер для OpenAI-совместимых image API: они принимают size, а не aspect_ratio. */
function sizeFor(aspectRatio) {
  const map = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "4:3": "1024x768",
    "3:4": "768x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
  };
  return map[String(aspectRatio ?? "1:1")] ?? "1024x1024";
}

function imageProvider({ agent = null, provider = null } = {}) {
  if (provider) {
    const p = typeof provider === "string" ? getProviders().get(provider) : provider;
    if (!p) throw new Error(`Провайдер «${provider}» не найден`);
    if (p.enabled === false) throw new Error(`Провайдер «${p.name}» выключен — включи его в разделе «Ключи» → «Провайдеры».`);
    return p;
  }
  if (agent) return getProviders().forAgent(agent);
  return getProviders().defaultProvider();
}

function imageError(provider, status, text, endpoint) {
  let detail = String(text ?? "").slice(0, 300);
  try {
    const j = JSON.parse(text);
    detail = j?.error?.message ?? j?.error ?? detail;
  } catch {
    /* не JSON */
  }
  if ([404, 405, 501].includes(status) || /not (supported|found)|unsupported|unimplemented/i.test(String(detail))) {
    return new Error(
      `Провайдер «${provider.name}» не поддерживает генерацию изображений (${status} ${endpoint}): ${detail}. ` +
        `Выбери другого провайдера с /images/generations или kind=openrouter.`
    );
  }
  const err = providerHttpError(provider, status, text, endpoint);
  return new Error(`Картинка не сгенерировалась: ${err.message}`);
}

async function parseImageError(res, provider, endpoint) {
  return imageError(provider, res.status, await res.text(), endpoint);
}

function imageNetworkError(provider, err, endpoint) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new Error(`Таймаут: провайдер «${provider.name}» не ответил на ${endpoint} за 180 с`);
  }
  return new Error(`Не удалось подключиться к «${provider.name}» (${endpoint}): ${String(err?.message || err)}`);
}

/**
 * Картинка через провайдера агента (agent.provider) или явного провайдера.
 * openrouter — /images (как раньше), openai — /images/generations с {model,prompt,size}.
 * Ответ: data[0].b64_json или data[0].url (url скачиваем сами).
 */
export async function generateImage({
  model,
  prompt,
  aspectRatio,
  resolution,
  quality,
  references = [],
  apiKey = null,
  agent = null,
  provider = null,
}) {
  const p = imageProvider({ agent, provider });
  const base = resolveBaseUrl(p);
  // Для OpenRouter сохраняем старый приоритет: назначенный ключ агента важнее.
  const key = p.kind === "openrouter" && apiKey ? String(apiKey).trim() : apiKeyFor(p);
  const started = Date.now();

  if (p.kind === "openai") {
    const body = { model, prompt, size: sizeFor(aspectRatio) };
    if (quality && String(quality) !== "auto") body.quality = String(quality);

    let res;
    try {
      res = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: headersFor(p, key),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      throw imageNetworkError(p, err, "/images/generations");
    }
    if (!res.ok) throw await parseImageError(res, p, "/images/generations");

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Провайдер «${p.name}» вернул не JSON на /images/generations`);
    }
    const first = data?.data?.[0] ?? data?.images?.[0] ?? null;
    let b64 = first?.b64_json ?? null;
    let mediaType = first?.media_type ?? "image/png";

    // некоторые шлюзы кладут data URL прямо в b64_json
    if (typeof b64 === "string" && b64.startsWith("data:")) {
      const m = b64.match(/^data:([^;,]+);base64,([\s\S]*)$/);
      if (m) {
        mediaType = m[1];
        b64 = m[2];
      }
    }

    if (!b64 && first?.url) {
      const url = String(first.url);
      const absolute = url.startsWith("/") ? new URL(url, base).toString() : url;
      // чужому origin (CDN) ключ провайдера не отправляем
      let downloadHeaders = {};
      try {
        if (new URL(absolute).origin === new URL(base).origin) downloadHeaders = headersFor(p, key, { json: false });
      } catch {
        /* data: URL — заголовки не нужны */
      }
      let file;
      try {
        file = await fetch(absolute, { headers: downloadHeaders, signal: AbortSignal.timeout(120_000) });
      } catch (err) {
        throw imageNetworkError(p, err, "url картинки");
      }
      if (!file.ok) throw new Error(`Ссылка на картинку не открылась (${file.status}): ${absolute}`);
      mediaType = (file.headers.get("content-type") || "image/png").split(";")[0].trim();
      b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    }
    if (!b64) throw new Error(`Провайдер «${p.name}» не вернул изображение (ни b64_json, ни url)`);
    return { b64, mediaType, cost: Number(data?.usage?.cost ?? 0), ms: Date.now() - started };
  }

  const body = { model, prompt };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (quality) body.quality = quality;
  if (references.length) {
    body.input_references = references.map((url) => ({ type: "image_url", image_url: { url } }));
  }

  let res;
  try {
    res = await fetch(`${base}/images`, {
      method: "POST",
      headers: headersFor(p, key),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw imageNetworkError(p, err, "/images");
  }
  const text = await res.text();
  if (!res.ok) throw imageError(p, res.status, text, "/images");

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Ответ картинки не разобрался как JSON");
  }
  const first = data?.data?.[0];
  if (!first?.b64_json) throw new Error("В ответе нет изображения");

  return {
    b64: first.b64_json,
    mediaType: first.media_type ?? "image/png",
    cost: Number(data?.usage?.cost ?? 0),
    ms: Date.now() - started,
  };
}

/** Модели картинок: у openai-провайдера их нет отдельно — берём его /models. */
export async function listImageModels({ provider = null, agent = null } = {}) {
  const p = imageProvider({ agent, provider });
  const base = resolveBaseUrl(p);
  if (p.kind === "openai") {
    const { models } = await fetchModels(p, { timeoutMs: 30_000 });
    return models
      .map((m) => {
        const id = String(m.id ?? m.name);
        return { id, name: String(m.name ?? id), params: [] };
      })
      .filter((m) => m.id);
  }
  const res = await fetch(`${base}/images/models`, {
    headers: headersFor(p, apiKeyFor(p), { json: false }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = providerHttpError(p, res.status, text, "/images/models");
    throw new Error(`Список моделей картинок: ${err.message}`);
  }
  const j = await res.json();
  return (j.data ?? []).map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    params: Object.keys(m.supported_parameters ?? {}),
  }));
}
