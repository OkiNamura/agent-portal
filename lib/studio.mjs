import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = "https://openrouter.ai/api/v1";

function headers() {
  return {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
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

    this.threadFile = path.join(this.dir, "thread.json");
    this.thread = [];
    if (fs.existsSync(this.threadFile)) {
      try {
        this.thread = JSON.parse(fs.readFileSync(this.threadFile, "utf8").replace(/^\uFEFF/, "")).messages ?? [];
      } catch {
        this.thread = [];
      }
    }
  }

  threadList(limit = 60) {
    return this.thread.slice(-limit);
  }

  threadAdd(entry) {
    const msg = { id: crypto.randomBytes(4).toString("hex"), at: new Date().toISOString(), ...entry };
    this.thread.push(msg);
    if (this.thread.length > 200) this.thread.splice(0, this.thread.length - 200);
    const tmp = `${this.threadFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ messages: this.thread }, null, 2), "utf8");
    fs.renameSync(tmp, this.threadFile);
    return msg;
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

export async function generateImage({ model, prompt, aspectRatio, resolution, quality, references = [] }) {
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
    headers: headers(),
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
