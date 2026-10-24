import { chat, hasKey } from "./openrouter.mjs";
import { mockChat } from "./mock.mjs";

/** Mock when there is no key, or when the server was started with --mock / MOCK=1. */
export function isMock() {
  return process.env.MOCK === "1" || !hasKey();
}

export async function complete({ agent, kind, system, user, meta }) {
  if (isMock()) return mockChat({ kind, meta });
  return chat({
    model: agent.model,
    system,
    user,
    temperature: Number.isFinite(agent.temperature) ? agent.temperature : 0.3,
  });
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
  throw new Error("Ответ модели не содержит валидного JSON");
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
export async function askJson({ agent, kind, system, user, meta }) {
  const first = await complete({ agent, kind, system, user, meta });
  try {
    return { ...first, data: extractJson(first.text) };
  } catch (err) {
    const second = await complete({
      agent,
      kind,
      meta,
      system,
      user: `${user}\n\nВАЖНО: предыдущий ответ не удалось разобрать как JSON (${err.message}). Верни ТОЛЬКО валидный JSON, без markdown и пояснений.`,
    });
    return { ...second, data: extractJson(second.text) };
  }
}
