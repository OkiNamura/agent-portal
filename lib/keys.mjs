import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const mask = (k) => (k ? `${k.slice(0, 10)}…${k.slice(-4)}` : "—");
/** Ключи локальных провайдеров бывают короткими — не показываем их почти целиком. */
const maskProvider = (k) => (!k ? "—" : String(k).length <= 8 ? "••••" : `${String(k).slice(0, 4)}…${String(k).slice(-4)}`);

/**
 * Несколько ключей OpenRouter: метка, лимит, к какому агенту привязан.
 * Наружу отдаём только маску — полный ключ не покидает сервер.
 */
export class Keys {
  constructor(root) {
    // CONFIG_DIR используется проверками: временные ключи не должны попадать в боевой config/
    const configDir = process.env.CONFIG_DIR ? path.resolve(process.env.CONFIG_DIR) : path.join(root, "config");
    this.file = path.join(configDir, "keys.json");
    this.data = { keys: [], defaultKeyId: null, assign: {}, providers: {} };
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
      } catch {
        /* битый файл — восстановим из env */
      }
    }
    if (!this.data.providers || typeof this.data.providers !== "object") this.data.providers = {};
    if (!this.data.keys?.length) this.seedFromEnv();
  }

  seedFromEnv() {
    const envKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!envKey) return;
    const k = { id: "primary", label: "Основной (.env)", key: envKey, limitDaily: 0, createdAt: new Date().toISOString() };
    // providers — ключи сторонних провайдеров, они не должны потеряться при seed
    this.data = { keys: [k], defaultKeyId: k.id, assign: {}, providers: this.data.providers ?? {} };
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
      providerKeys: this.providerMasks(),
    };
  }

  /* --- ключи провайдеров: хранятся здесь, в providers.json их нет --- */

  providerMasks() {
    const out = {};
    for (const [id, key] of Object.entries(this.data.providers ?? {})) out[id] = maskProvider(key);
    return out;
  }

  providerKey(id) {
    const key = this.data.providers?.[id];
    return key ? String(key) : null;
  }

  /** Пустая строка удаляет сохранённый ключ провайдера (локальные могут жить без него). */
  setProviderKey(id, key) {
    const pid = String(id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_.-]{0,39}$/.test(pid)) throw new Error("Некорректный id провайдера");
    this.data.providers = this.data.providers ?? {};
    const value = String(key ?? "").trim();
    if (value) this.data.providers[pid] = value;
    else delete this.data.providers[pid];
    this.save();
    return this.providerMasks();
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
