/**
 * Клиент моделей: OpenRouter и любой OpenAI-совместимый провайдер.
 *
 * Провайдер приходит из lib/providers.mjs (config/providers.json).
 * Без provider используется default — так старые скрипты (models.mjs, ping.mjs)
 * продолжают работать как раньше.
 */
import {
  getProviders,
  resolveBaseUrl,
  headersFor,
  apiKeyFor,
  providerHttpError,
  fetchModels,
} from "./providers.mjs";

export class LlmError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
  }
}

/** Обратная совместимость: есть ли рабочий провайдер (для OpenRouter — с ключом). */
export function hasKey() {
  const p = getProviders().defaultProvider();
  return Boolean(apiKeyFor(p));
}

/**
 * POST {baseUrl}/{path} с ретраями. Таймаут не повторяем: провайдер уже
 * медленный, повтор только утроит ожидание.
 */
async function request(provider, path, init, { retries = 2, timeoutMs = 240_000 } = {}) {
  const base = resolveBaseUrl(provider);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, { ...init, signal: ac.signal });
      const text = await res.text();
      if (!res.ok) {
        const retriable = res.status === 429 || res.status >= 500;
        if (retriable && attempt < retries) {
          await sleep(1200 * (attempt + 1));
          continue;
        }
        const err = providerHttpError(provider, res.status, text, path);
        throw new LlmError(err.message, { status: err.status, body: err.body });
      }
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new LlmError(`Провайдер «${provider.name}» вернул не JSON на ${path}: ${truncate(text, 200)}`);
      }
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError") {
        throw new LlmError(
          `Таймаут ${Math.round(timeoutMs / 1000)} с: «${provider.name}» не ответил на ${path}`
        );
      }
      if (err instanceof LlmError) throw err;
      if (attempt < retries && (err?.name === "TypeError" || err?.name === "FetchError")) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      throw err instanceof LlmError
        ? err
        : new LlmError(`Не удалось подключиться к «${provider.name}» (${base}): ${String(err?.message || err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new LlmError("Неизвестная ошибка запроса");
}

function contentOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? part?.content ?? ""))
      .join("")
      .trim();
  }
  return "";
}

/**
 * @returns {{text: string, usage: {prompt:number, completion:number, cost:number}, model: string}}
 */
export async function chat({
  model,
  system,
  user,
  temperature = 0.3,
  maxTokens = 8000,
  apiKey = null,
  timeoutMs = 240_000,
  provider = null,
}) {
  const p = provider ?? getProviders().defaultProvider();
  // Для OpenRouter явный ключ агента (keys.assign) важнее; для openai-провайдера
  // ключ берём только у него самого — чужой ключ OpenRouter туда не отправляем.
  const key = p.kind === "openrouter" && apiKey ? String(apiKey).trim() : apiKeyFor(p);
  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
  };
  // usage.include — расширение OpenRouter; сторонние шлюзы могут его не знать.
  if (p.kind === "openrouter") body.usage = { include: true };

  const data = await request(
    p,
    "/chat/completions",
    {
      method: "POST",
      headers: headersFor(p, key),
      body: JSON.stringify(body),
    },
    { timeoutMs }
  );

  const choice = data?.choices?.[0];
  const text = contentOf(choice?.message);
  const finishReason = choice?.finish_reason ?? null;
  if (!text) {
    throw new LlmError(`Пустой ответ модели ${model} (finish_reason=${finishReason})`);
  }
  const u = data?.usage ?? {};
  return {
    text,
    model: data?.model ?? model,
    finishReason,
    usage: {
      prompt: Number(u.prompt_tokens ?? 0),
      completion: Number(u.completion_tokens ?? 0),
      cost: Number(u.cost ?? 0),
    },
  };
}

/** Модели провайдера (OpenAI-совместимый GET /models). */
export async function listModels({ provider = null, timeoutMs = 30_000 } = {}) {
  const p = provider ?? getProviders().defaultProvider();
  const { models } = await fetchModels(p, { timeoutMs });
  return models
    .map((m) => {
      const id = String(m.id ?? m.name);
      return {
        id,
        name: String(m.name ?? id),
        context: m.context_length ?? m.context_window ?? m.max_context_length ?? null,
        promptPrice: Number(m.pricing?.prompt ?? m.promptPrice ?? 0),
        completionPrice: Number(m.pricing?.completion ?? m.completionPrice ?? 0),
      };
    })
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));
