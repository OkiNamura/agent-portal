import { chat, hasKey } from "./openrouter.mjs";
import { mockChat } from "./mock.mjs";

/** Mock when there is no key, or when the server was started with --mock / MOCK=1. */
export function isMock() {
  return process.env.MOCK === "1" || !hasKey();
}

const FALLBACK_MODEL = "google/gemini-2.5-flash-lite";

/**
 * Лимит ответа и таймаут по типу вызова. Инженеру (build/fix) нужно больше
 * 8000 токенов: полный HTML/CSS/JS-файл на 20–30k символов в них не влезает,
 * а обрезанный JSON с «хвостом» файла выглядит как заглушка/скелет.
 * 32000 — с запасом на reasoning-токены модели, 480 с — на длинный ответ.
 */
const DEFAULT_MAX_TOKENS = 8000;
const KIND_MAX_TOKENS = { build: 32000, fix: 32000, mockup: 16000 };
const DEFAULT_TIMEOUT_MS = 240_000;
const KIND_TIMEOUT_MS = { build: 480_000, fix: 480_000 };

export function maxTokensFor(kind, explicit) {
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return KIND_MAX_TOKENS[kind] ?? DEFAULT_MAX_TOKENS;
}

export async function complete({ agent, kind, system, user, meta, apiKey = null, maxTokens = null }) {
  if (isMock()) return mockChat({ kind, meta });
  const temperature = Number.isFinite(agent.temperature) ? agent.temperature : 0.3;
  const limit = maxTokensFor(kind, maxTokens);
  const timeoutMs = KIND_TIMEOUT_MS[kind] ?? DEFAULT_TIMEOUT_MS;
  try {
    return checkTruncated(
      await chat({ model: agent.model, system, user, apiKey, temperature, maxTokens: limit, timeoutMs }),
      limit
    );
  } catch (err) {
    // провайдер подвис или обрезал ответ (finish_reason=length) — один раз пробуем быструю модель
    const msg = String(err?.message || "");
    if (/Таймаут|Пустой ответ|finish_reason=length|обрезан/i.test(msg) && agent.model !== FALLBACK_MODEL) {
      const res = await chat({ model: FALLBACK_MODEL, system, user, apiKey, temperature, maxTokens: limit, timeoutMs });
      // (fallback) в model оставлен для старых отчётов; движок дополнительно видит флаг
      // fallback и originalModel и пишет их в события/состояние блока.
      return {
        ...checkTruncated(res, limit),
        model: `${res.model} (fallback)`,
        fallback: true,
        originalModel: agent.model,
        fallbackModel: res.model,
      };
    }
    throw err;
  }
}

/** Обрезанный ответ нельзя принимать молча: именно так в файлы попадали «скелеты». */
function checkTruncated(res, limit) {
  if (res?.finishReason === "length") {
    throw new Error(`Ответ обрезан: finish_reason=length при max_tokens=${limit} — файл не поместился в лимит`);
  }
  return res;
}

/** Pull the first JSON object/array out of a model reply (handles ```json fences and prose). */
export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Пустой ответ модели");
  const cleaned = text.replace(/^\uFEFF/, "");
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(cleaned);

  for (const c of candidates) {
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const slice = c.slice(start);
    const end = findBalancedEnd(slice);
    if (end < 0) continue;
    const body = slice.slice(0, end + 1);
    try {
      return JSON.parse(body);
    } catch {
      // try light repairs: trailing commas
      try {
        return JSON.parse(body.replace(/,\s*([}\]])/g, "$1"));
      } catch {
        /* next candidate */
      }
    }
  }
  throw new Error(
    `Ответ модели не содержит валидного JSON (${text.length} симв., начало: ${JSON.stringify(text.trim().slice(0, 160))})`
  );
}

function findBalancedEnd(s) {
  const open = s[0];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Complete + parse JSON, one repair attempt if the model wrapped it badly. */
export async function askJson({ agent, kind, system, user, meta, apiKey = null, maxTokens = null }) {
  const first = await complete({ agent, kind, system, user, meta, apiKey, maxTokens });
  try {
    return { ...first, data: extractJson(first.text) };
  } catch (err) {
    const second = await complete({
      agent,
      kind,
      meta,
      system,
      apiKey,
      maxTokens,
      user: `${user}\n\nВАЖНО: предыдущий ответ не удалось разобрать как JSON (${err.message}). Верни ТОЛЬКО валидный JSON, без markdown и пояснений.`,
    });
    return { ...second, data: extractJson(second.text) };
  }
}
