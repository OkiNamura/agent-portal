/**
 * Thin OpenRouter client.
 * Docs: POST https://openrouter.ai/api/v1/chat/completions
 */

const BASE = "https://openrouter.ai/api/v1";

export class LlmError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
  }
}

export function hasKey() {
  return Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim());
}

function headers(apiKey) {
  const h = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey || process.env.OPENROUTER_API_KEY}`,
  };
  if (process.env.OPENROUTER_REFERER) h["HTTP-Referer"] = process.env.OPENROUTER_REFERER;
  if (process.env.OPENROUTER_TITLE) h["X-Title"] = process.env.OPENROUTER_TITLE;
  return h;
}

async function request(path, init, { retries = 2, timeoutMs = 180_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(BASE + path, { ...init, signal: ac.signal });
      const text = await res.text();
      if (!res.ok) {
        const retriable = res.status === 429 || res.status >= 500;
        if (retriable && attempt < retries) {
          await sleep(1200 * (attempt + 1));
          continue;
        }
        const hint =
          res.status === 401 || res.status === 403
            ? " — ключ OpenRouter отклонён. Проверь OPENROUTER_API_KEY в agent-portal/.env: возможно, он отозван или заблокирован."
            : res.status === 402
              ? " — на ключе закончились деньги. Пополни баланс OpenRouter."
              : "";
        throw new LlmError(`OpenRouter ${res.status}${hint}: ${truncate(text, 300)}`, {
          status: res.status,
          body: text,
        });
      }
      return text ? JSON.parse(text) : {};
    } catch (err) {
      lastErr = err;
      const aborted = err?.name === "AbortError";
      if (attempt < retries && (aborted || err?.name === "TypeError" || err?.name === "FetchError")) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      if (aborted) throw new LlmError(`Таймаут ${timeoutMs} мс на запрос к ${path}`);
      throw err instanceof LlmError ? err : new LlmError(String(err?.message || err));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new LlmError("Неизвестная ошибка запроса");
}

/**
 * @returns {{text: string, usage: {prompt:number, completion:number, cost:number}, model: string}}
 */
export async function chat({ model, system, user, temperature = 0.3, maxTokens = 8000, apiKey = null }) {
  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    usage: { include: true },
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
  };
  const data = await request("/chat/completions", {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  const choice = data?.choices?.[0];
  const text = choice?.message?.content ?? "";
  if (!text) {
    throw new LlmError(`Пустой ответ модели ${model} (finish_reason=${choice?.finish_reason})`);
  }
  const u = data?.usage ?? {};
  return {
    text,
    model: data?.model ?? model,
    usage: {
      prompt: Number(u.prompt_tokens ?? 0),
      completion: Number(u.completion_tokens ?? 0),
      cost: Number(u.cost ?? 0),
    },
  };
}

export async function listModels() {
  const data = await request("/models", { method: "GET", headers: headers() }, { retries: 1, timeoutMs: 30_000 });
  return (data?.data ?? [])
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      context: m.context_length ?? null,
      promptPrice: Number(m.pricing?.prompt ?? 0),
      completionPrice: Number(m.pricing?.completion ?? 0),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
