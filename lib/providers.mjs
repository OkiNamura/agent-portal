/**
 * Провайдеры моделей.
 *
 * config/providers.json — только описание провайдера (id, имя, baseUrl, kind,
 * enabled, apiKeyEnv). Ключи сюда НЕ пишутся: они живут в config/keys.json
 * (блок providers) или в переменных окружения.
 *
 * kind:
 *   openrouter — текущее поведение: OpenRouter-заголовки и учёт цены;
 *   openai     — любой OpenAI-совместимый шлюз (LM Studio, Ollama, vLLM,
 *                llama.cpp, сторонний прокси): /models, /chat/completions,
 *                /images/generations. Ключ может быть пустым.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const KINDS = Object.freeze(["openrouter", "openai"]);

/** Встроенный провайдер: работает, даже если config/providers.json ещё нет. */
export const OPENROUTER_DEFAULT = Object.freeze({
  id: "openrouter",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  kind: "openrouter",
  apiKeyEnv: "OPENROUTER_API_KEY",
  enabled: true,
});

export const DEFAULT_CONFIG = Object.freeze({
  providers: [OPENROUTER_DEFAULT],
  default: "openrouter",
});

function activeConfigDir() {
  return process.env.CONFIG_DIR ? path.resolve(process.env.CONFIG_DIR) : path.join(ROOT, "config");
}

export function providersFile() {
  return path.join(activeConfigDir(), "providers.json");
}

export function keysFile() {
  return path.join(activeConfigDir(), "keys.json");
}

const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

export function normalizeId(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function validId(id) {
  return ID_RE.test(String(id ?? ""));
}

function slugId(name) {
  const base = String(name ?? "")
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => ({ а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" }[ch] ?? ""))
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (validId(base)) return base;
  return `p-${crypto.randomBytes(3).toString("hex")}`;
}

/** baseUrl: добавляем http://, если схему забыли, и убираем хвостовые слэши. */
export function normalizeBaseUrl(value) {
  let raw = String(value ?? "").trim();
  if (!raw) throw new Error("Не указан baseUrl провайдера");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Некорректный baseUrl: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("baseUrl должен начинаться с http:// или https://");
  if (!url.hostname) throw new Error(`Некорректный baseUrl: ${value}`);
  return raw.replace(/\/+$/, "");
}

/** Итоговый адрес API: объект провайдера или его id. */
export function resolveBaseUrl(providerOrId) {
  const p =
    typeof providerOrId === "string"
      ? getProviders().get(providerOrId)
      : providerOrId;
  if (!p) throw new Error(`Провайдер «${providerOrId}» не найден`);
  const raw = String(p.baseUrl ?? "").trim() || OPENROUTER_DEFAULT.baseUrl;
  return normalizeBaseUrl(raw);
}

function pickProvider(input = {}) {
  return {
    id: normalizeId(input.id),
    name: String(input.name ?? "").trim() || normalizeId(input.id) || "Провайдер",
    baseUrl: normalizeBaseUrl(input.baseUrl ?? ""),
    kind: KINDS.includes(String(input.kind ?? "")) ? String(input.kind) : "openai",
    apiKeyEnv: String(input.apiKeyEnv ?? "").trim(),
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
  };
}

function defaultApiKeyEnv(p) {
  return p.kind === "openrouter" ? "OPENROUTER_API_KEY" : `${String(p.id).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/** Сериализуемое описание провайдера (без ключей — их здесь и нет). */
function publicProvider(p) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    kind: p.kind,
    apiKeyEnv: p.apiKeyEnv || "",
    enabled: p.enabled !== false,
  };
}

/* --------------------------- ключи (config/keys.json) --------------------------- */

let keysCache = { file: null, stamp: "", data: null };

function readKeysData() {
  const file = keysFile();
  let stamp = "";
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    keysCache = { file, stamp: "", data: null };
    return null;
  }
  if (keysCache.file === file && keysCache.stamp === stamp) return keysCache.data;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    data = null;
  }
  keysCache = { file, stamp, data };
  return data;
}

function storedProviderKeys() {
  const data = readKeysData();
  const map = data?.providers;
  return map && typeof map === "object" ? map : {};
}

/**
 * Ключ провайдера: сначала явный ключ из config/keys.json (providers.<id>),
 * затем переменная окружения из apiKeyEnv. Для openrouter — OPENROUTER_API_KEY.
 * Для локальных openai-провайдеров пустой ключ — норма.
 */
export function apiKeyFor(provider) {
  if (!provider) return "";
  const stored = storedProviderKeys()[provider.id];
  const storedKey = typeof stored === "string" ? stored : stored?.key;
  if (String(storedKey ?? "").trim()) return String(storedKey).trim();
  const envName = provider.apiKeyEnv || (provider.kind === "openrouter" ? "OPENROUTER_API_KEY" : "");
  const envKey = envName ? process.env[envName] : "";
  return String(envKey ?? "").trim();
}

export function hasKey(provider) {
  return Boolean(apiKeyFor(provider));
}

/** Заголовки запроса. Для openrouter сохраняем HTTP-Referer / X-Title. */
export function headersFor(provider, apiKey = null, { json = true } = {}) {
  const key = apiKey === null || apiKey === undefined ? apiKeyFor(provider) : String(apiKey).trim();
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  if (key) headers.Authorization = `Bearer ${key}`;
  if (provider?.kind === "openrouter") {
    if (process.env.OPENROUTER_REFERER) headers["HTTP-Referer"] = process.env.OPENROUTER_REFERER;
    if (process.env.OPENROUTER_TITLE) headers["X-Title"] = process.env.OPENROUTER_TITLE;
  }
  return headers;
}

/* ------------------------------- ошибки ------------------------------- */

const truncate = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));

/**
 * Понятная ошибка ответа провайдера: 401/403 — ключ, 404 — baseUrl,
 * 402 — деньги (только OpenRouter), остальное — как ответил сервер.
 */
export function providerHttpError(provider, status, text, endpoint = "") {
  const name = provider?.name || provider?.id || "Провайдер";
  const body = truncate(text, 300);
  let hint = "";
  if (status === 401 || status === 403) {
    hint =
      provider?.kind === "openrouter"
        ? " — ключ OpenRouter отклонён. Проверь OPENROUTER_API_KEY или ключ в разделе «Ключи»."
        : ` — ключ провайдера «${name}» отклонён. Проверь apiKeyEnv или ключ в разделе «Ключи».`;
  } else if (status === 402) {
    hint = provider?.kind === "openrouter" ? " — на ключе закончились деньги. Пополни баланс OpenRouter." : " — провайдер просит оплату.";
  } else if (status === 404) {
    hint = " — эндпоинт не найден. Проверь baseUrl: он должен указывать на корень API (обычно заканчивается на /v1).";
  } else if (status === 405 || status === 501) {
    hint = " — этот эндпоинт провайдером не поддерживается.";
  }
  return Object.assign(new Error(`${name} ${status}${hint}${endpoint ? ` [${endpoint}]` : ""}: ${body}`), {
    status,
    body,
    providerId: provider?.id ?? null,
  });
}

/* ------------------------------- модели ------------------------------- */

/**
 * GET {baseUrl}/models. Возвращает массив сырых моделей (OpenAI-совместимый
 * ответ: {data:[...]} или {models:[...]}, на всякий случай — просто массив).
 */
export async function fetchModels(provider, { timeoutMs = 30_000, pathSuffix = "/models" } = {}) {
  const p = provider ?? getProviders().defaultProvider();
  const base = resolveBaseUrl(p);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(base + pathSuffix, {
      method: "GET",
      headers: headersFor(p, apiKeyFor(p), { json: false }),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw providerHttpError(p, res.status, text, pathSuffix);
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Провайдер «${p.name}» вернул не JSON на ${pathSuffix}`);
    }
    const arr = Array.isArray(data)
      ? data
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : [];
    return { models: arr.filter((m) => m && (m.id || m.name)), ms: Date.now() - started };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw Object.assign(new Error(`Таймаут ${Math.round(timeoutMs / 1000)} с: провайдер «${p.name}» не ответил на GET ${pathSuffix}`), {
        timeout: true,
        status: null,
        providerId: p.id,
      });
    }
    if (err?.name === "TypeError") {
      throw Object.assign(
        new Error(`Не удалось подключиться к «${p.name}» (${base}). Проверь, что сервер запущен и baseUrl верный.`),
        { status: null, providerId: p.id }
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Проверка связи для API: {ok, models:[id...50], ms} или {ok:false, error, status}. */
export async function testProvider(provider, { timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  try {
    const { models } = await fetchModels(provider, { timeoutMs });
    return {
      ok: true,
      models: models.slice(0, 50).map((m) => String(m.id ?? m.name)),
      total: models.length,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      status: err?.status ?? null,
      timeout: Boolean(err?.timeout),
      ms: Date.now() - started,
    };
  }
}

/* ------------------------------ хранилище ------------------------------ */

export class Providers {
  constructor({ file = providersFile() } = {}) {
    this.file = file;
    this.data = { providers: [], default: null };
    this.stamp = "";
    this.load();
  }

  stampOf() {
    try {
      const st = fs.statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "";
    }
  }

  load() {
    this.stamp = this.stampOf();
    let parsed = null;
    try {
      if (fs.existsSync(this.file)) parsed = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      this.data = { providers: [{ ...OPENROUTER_DEFAULT }], default: OPENROUTER_DEFAULT.id };
      return this;
    }
    const providers = [];
    for (const raw of Array.isArray(parsed.providers) ? parsed.providers : []) {
      try {
        const p = pickProvider(raw);
        if (!validId(p.id)) continue;
        if (providers.some((x) => x.id === p.id)) continue;
        providers.push(p);
      } catch {
        /* битая запись — пропускаем, остальные работают */
      }
    }
    if (!providers.length) providers.push({ ...OPENROUTER_DEFAULT });
    const def = normalizeId(parsed.default);
    this.data = {
      providers,
      default: providers.some((p) => p.id === def) ? def : providers[0].id,
    };
    return this;
  }

  /** Подхватить правки файла, сделанные руками или другим процессом. */
  ensureFresh() {
    if (this.stampOf() !== this.stamp) this.load();
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const payload = {
      providers: this.data.providers.map(publicProvider),
      default: this.data.default,
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
    this.stamp = this.stampOf();
    return this;
  }

  list() {
    this.ensureFresh();
    const def = this.defaultId();
    return this.data.providers.map((p) => ({
      ...publicProvider(p),
      hasKey: hasKey(p),
      requiresKey: p.kind === "openrouter",
      isDefault: p.id === def,
    }));
  }

  defaultId() {
    this.ensureFresh();
    const def = this.data.default;
    if (def && this.data.providers.some((p) => p.id === def)) return def;
    return this.data.providers[0]?.id ?? OPENROUTER_DEFAULT.id;
  }

  defaultProvider() {
    const p = this.get(this.defaultId());
    return p ?? { ...OPENROUTER_DEFAULT };
  }

  get(id) {
    this.ensureFresh();
    const key = normalizeId(id);
    return this.data.providers.find((p) => p.id === key) ?? null;
  }

  require(id) {
    const p = this.get(id);
    if (!p) throw new Error(`Провайдер «${id}» не найден в config/providers.json`);
    return p;
  }

  /** Провайдер агента: agent.provider → default. Выключенный провайдер — ошибка. */
  forAgent(agent) {
    const id = String(agent?.provider ?? "").trim() || this.defaultId();
    const p = this.require(id);
    if (p.enabled === false) throw new Error(`Провайдер «${p.name}» выключен — включи его в разделе «Ключи» → «Провайдеры».`);
    return p;
  }

  add(input = {}) {
    this.ensureFresh();
    const src = { ...input };
    if (!normalizeId(src.id)) src.id = slugId(src.name);
    const p = pickProvider(src);
    if (!validId(p.id)) throw new Error("id провайдера: 1–40 символов, латиница/цифры/-/_/.");
    if (this.data.providers.some((x) => x.id === p.id)) throw new Error(`Провайдер «${p.id}» уже есть`);
    if (!p.apiKeyEnv) p.apiKeyEnv = defaultApiKeyEnv(p);
    this.data.providers.push(p);
    if (!this.data.default) this.data.default = p.id;
    this.save();
    return { provider: { ...publicProvider(p), hasKey: hasKey(p) }, providers: this.list(), default: this.defaultId() };
  }

  update(id, patch = {}) {
    this.ensureFresh();
    const p = this.require(id);
    const patchFields = pickPatch(patch);
    const kindChanged = patchFields.kind !== undefined && String(patchFields.kind) !== p.kind;
    const next = pickProvider({ ...publicProvider(p), ...patchFields, id: p.id });
    // при смене типа API старый env-имя обычно больше не подходит
    if (kindChanged && patchFields.apiKeyEnv === undefined) next.apiKeyEnv = defaultApiKeyEnv(next);
    Object.assign(p, next);
    this.save();
    return { provider: { ...publicProvider(p), hasKey: hasKey(p) }, providers: this.list(), default: this.defaultId() };
  }

  remove(id) {
    this.ensureFresh();
    const p = this.require(id);
    if (this.data.providers.length <= 1) throw new Error("Нельзя удалить последнего провайдера — добавь другого и переключи default");
    this.data.providers = this.data.providers.filter((x) => x.id !== p.id);
    if (this.data.default === p.id) this.data.default = this.data.providers[0].id;
    this.save();
    return { removed: p.id, providers: this.list(), default: this.defaultId() };
  }
}

/** Для update: undefined-поля не должны затирать текущие значения. */
function pickPatch(patch) {
  const out = {};
  for (const key of ["name", "baseUrl", "kind", "apiKeyEnv", "enabled"]) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  return out;
}

/* ------------------------------- singleton ------------------------------- */

let shared = null;

/** Один экземпляр на процесс (его видят server, llm и studio). */
export function getProviders() {
  const file = providersFile();
  if (!shared || shared.file !== file) shared = new Providers({ file });
  else shared.ensureFresh();
  return shared;
}

/** Есть ли включённый провайдер, способный работать (у openai ключ не обязателен). */
export function hasReadyProvider() {
  return getProviders()
    .list()
    .some((p) => p.enabled && (p.kind === "openai" || p.hasKey));
}
