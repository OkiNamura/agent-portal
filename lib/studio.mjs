import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = "https://openrouter.ai/api/v1";

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey || process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    ...(process.env.OPENROUTER_REFERER ? { "HTTP-Referer": process.env.OPENROUTER_REFERER } : {}),
    ...(process.env.OPENROUTER_TITLE ? { "X-Title": process.env.OPENROUTER_TITLE } : {}),
  };
}

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

  threadFileFor(sessionId) {
    return path.join(this.threadsDir, `${sessionId || this.activeId}.json`);
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

  deleteSession(id) {
    if (this.sessions.length <= 1) throw new Error("Нельзя удалить последний чат");
    this.sessions = this.sessions.filter((s) => s.id !== id);
    try {
      fs.rmSync(this.threadFileFor(id), { force: true });
    } catch {
      /* уже нет */
    }
    if (this.activeId === id) this.activeId = this.sessions[0].id;
    this.saveSessions();
    return { sessions: this.listSessions(), activeId: this.activeId };
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

  clearThread(sessionId) {
    const sid = sessionId || this.activeId;
    this.writeThread(sid, []);
    return { thread: [] };
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

export async function generateImage({ model, prompt, aspectRatio, resolution, quality, references = [], apiKey = null }) {
  const body = { model, prompt };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (quality) body.quality = quality;
  if (references.length) {
    body.input_references = references.map((url) => ({ type: "image_url", image_url: { url } }));
  }

  const started = Date.now();
  const res = await fetch(`${BASE}/images`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message ?? j?.error ?? msg;
    } catch {
      /* не JSON */
    }
    throw new Error(`Картинка не сгенерировалась (${res.status}): ${msg}`);
  }

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

export async function listImageModels() {
  const res = await fetch(`${BASE}/images/models`, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Список моделей: ${res.status}`);
  const j = await res.json();
  return (j.data ?? []).map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    params: Object.keys(m.supported_parameters ?? {}),
  }));
}
