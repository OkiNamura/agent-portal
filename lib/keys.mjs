import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const mask = (k) => (k ? `${k.slice(0, 10)}…${k.slice(-4)}` : "—");

/**
 * Несколько ключей OpenRouter: метка, лимит, к какому агенту привязан.
 * Наружу отдаём только маску — полный ключ не покидает сервер.
 */
export class Keys {
  constructor(root) {
    this.file = path.join(root, "config", "keys.json");
    this.data = { keys: [], defaultKeyId: null, assign: {} };
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
      } catch {
        /* битый файл — восстановим из env */
      }
    }
    if (!this.data.keys?.length) this.seedFromEnv();
  }

  seedFromEnv() {
    const envKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!envKey) return;
    const k = { id: "primary", label: "Основной (.env)", key: envKey, limitDaily: 0, createdAt: new Date().toISOString() };
    this.data = { keys: [k], defaultKeyId: k.id, assign: {} };
    this.save();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  list() {
    return {
      keys: (this.data.keys ?? []).map((k) => ({
        id: k.id,
        label: k.label,
        mask: mask(k.key),
        limitDaily: k.limitDaily ?? 0,
        createdAt: k.createdAt,
      })),
      defaultKeyId: this.data.defaultKeyId,
      assign: this.data.assign ?? {},
    };
  }

  add({ label, key, limitDaily = 0 }) {
    const value = String(key ?? "").trim();
    if (!/^sk-or-/.test(value)) throw new Error("Ключ OpenRouter начинается с sk-or-");
    const item = {
      id: crypto.randomBytes(3).toString("hex"),
      label: String(label || "Ключ").slice(0, 60),
      key: value,
      limitDaily: Number(limitDaily) || 0,
      createdAt: new Date().toISOString(),
    };
    this.data.keys.push(item);
    if (!this.data.defaultKeyId) this.data.defaultKeyId = item.id;
    this.save();
    return this.list();
  }

  remove(id) {
    if (this.data.keys.length <= 1) throw new Error("Нельзя удалить последний ключ");
    this.data.keys = this.data.keys.filter((k) => k.id !== id);
    if (this.data.defaultKeyId === id) this.data.defaultKeyId = this.data.keys[0].id;
    for (const [agent, keyId] of Object.entries(this.data.assign ?? {})) {
      if (keyId === id) delete this.data.assign[agent];
    }
    this.save();
    return this.list();
  }

  patch(id, patch) {
    const k = this.data.keys.find((x) => x.id === id);
    if (!k) throw new Error("Ключ не найден");
    if (patch.label != null) k.label = String(patch.label).slice(0, 60);
    if (patch.limitDaily != null) k.limitDaily = Number(patch.limitDaily) || 0;
    if (patch.key) {
      const v = String(patch.key).trim();
      if (!/^sk-or-/.test(v)) throw new Error("Ключ OpenRouter начинается с sk-or-");
      k.key = v;
    }
    this.save();
    return this.list();
  }

  assign(agentId, keyId) {
    this.data.assign = this.data.assign ?? {};
    if (keyId) this.data.assign[agentId] = keyId;
    else delete this.data.assign[agentId];
    this.save();
    return this.list();
  }

  setDefault(id) {
    if (id && !this.data.keys.some((k) => k.id === id)) throw new Error("Ключ не найден");
    this.data.defaultKeyId = id;
    this.save();
    return this.list();
  }

  /** Ключ для агента: назначенный → по умолчанию → первый. */
  resolve(agentId) {
    const assigned = this.data.assign?.[agentId];
    const byId = (id) => (this.data.keys ?? []).find((k) => k.id === id);
    const chosen = (assigned && byId(assigned)) || byId(this.data.defaultKeyId) || this.data.keys[0];
    return chosen ? { id: chosen.id, key: chosen.key, label: chosen.label, limitDaily: chosen.limitDaily ?? 0 } : null;
  }
}

export const PRESETS = {
  price: { title: "Дешевле", note: "самые недорогие модели для всех ролей" },
  speed: { title: "Быстрее", note: "лёгкие быстрые модели" },
  quality: { title: "Качественнее", note: "сильные модели там, где важно" },
};
