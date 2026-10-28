/**
 * Агенты портала: ручное создание/правка/копия/удаление и помощник настройки.
 *
 * Здесь нет HTTP и нет состояния: только нормализация, проверки, атомарная
 * запись config/agents.json и сборка промтов для модели-помощника.
 * Модуль намеренно не импортирует providers.mjs — экземпляр провайдеров
 * передаёт сервер, чтобы в проверках можно было подставить свой каталог.
 */
import fs from "node:fs";
import path from "node:path";

/** id агента: латиница, цифры и дефис; первый символ — буква или цифра. */
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Транслитерация для slug из русского имени. */
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Ошибка с HTTP-статусом: сервер отдаёт её как есть. */
export class AgentError extends Error {
  constructor(message, status = 400, extra = null) {
    super(message);
    this.name = "AgentError";
    this.status = status;
    if (extra && typeof extra === "object") Object.assign(this, extra);
  }
}

/** «Тестовый агент» → «testovyy-agent»; всегда валидный непустой id. */
export function slugifyAgentName(name, max = 40) {
  const base = String(name ?? "")
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => TRANSLIT[ch] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return base || "agent";
}

/** Свободный id: base, затем base-2, base-3… */
export function uniqueAgentId(candidate, existingIds = []) {
  const base = slugifyAgentName(candidate);
  const used = new Set((Array.isArray(existingIds) ? existingIds : []).map(String));
  if (!used.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const stem = base.slice(0, 40 - suffix.length).replace(/-+$/g, "");
    const id = `${stem}${suffix}`;
    if (!used.has(id)) return id;
  }
  return `agent-${Date.now().toString(36)}`;
}

function textField(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new AgentError(`${label}: не может быть пустым`);
  return text;
}

function temperatureField(value) {
  if (value === "" || value === null) throw new AgentError("temperature: укажи число от 0 до 2");
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new AgentError("temperature: число от 0 до 2");
  return n;
}

function providerField(value, providers) {
  const id = String(value ?? "").trim();
  if (!id) return null;
  if (!providers || typeof providers.get !== "function" || !providers.get(id)) {
    throw new AgentError(`Провайдер «${id}» не найден`);
  }
  return id;
}

/** Собрать нового агента; дубликат id — 409. */
export function buildAgentForCreate(body, { providers = null, existingIds = [] } = {}) {
  if (!body || typeof body !== "object") throw new AgentError("Нужно тело запроса");
  const ids = new Set((existingIds ?? []).map(String));
  let id;
  if (body.id !== undefined && String(body.id).trim() !== "") {
    id = String(body.id).trim();
    if (!AGENT_ID_RE.test(id)) {
      throw new AgentError("id: латиница (a-z), цифры и дефис, до 40 символов");
    }
    if (ids.has(id)) throw new AgentError(`Агент с id «${id}» уже существует`, 409);
  } else {
    id = uniqueAgentId(body.name, ids);
  }

  const agent = {
    id,
    name: textField(body.name, "Имя"),
    role: String(body.role ?? "").trim(),
    kind: String(body.kind ?? "llm").trim() || "llm",
    model: textField(body.model, "Модель"),
    temperature: temperatureField(body.temperature),
    prompt: textField(body.prompt, "Промт"),
  };
  const provider = providerField(body.provider, providers);
  if (provider) agent.provider = provider;
  return agent;
}

/** Частичная правка: возвращает только присланные поля; provider:null — удалить. */
export function buildAgentPatch(body, { providers = null, current = null } = {}) {
  if (!current) throw new AgentError("Агент не найден", 404);
  if (!body || typeof body !== "object") throw new AgentError("Нужно тело запроса");
  if (body.id !== undefined && String(body.id).trim() && String(body.id).trim() !== current.id) {
    throw new AgentError("id менять нельзя");
  }

  const patch = {};
  if (body.name !== undefined) patch.name = textField(body.name, "Имя");
  if (body.role !== undefined) patch.role = String(body.role ?? "").trim();
  if (body.kind !== undefined) patch.kind = String(body.kind ?? "").trim() || String(current.kind ?? "llm");
  if (body.model !== undefined) patch.model = textField(body.model, "Модель");
  if (body.temperature !== undefined) patch.temperature = temperatureField(body.temperature);
  if (body.prompt !== undefined) patch.prompt = textField(body.prompt, "Промт");
  if (body.provider !== undefined) patch.provider = providerField(body.provider, providers);
  return patch;
}

/** Применить patch; provider:null означает «убрать поле, использовать default». */
export function applyAgentPatch(current, patch) {
  const next = { ...current, ...patch };
  if (patch && patch.provider === null) delete next.provider;
  return next;
}

/** Копия: имя «<имя> (копия)» и новый свободный id. */
export function buildAgentCopy(source, existingIds = []) {
  if (!source || typeof source !== "object") throw new AgentError("Агент не найден", 404);
  return {
    ...source,
    id: uniqueAgentId(`${source.id}-copy`, existingIds),
    name: `${source.name} (копия)`,
  };
}

/** Записать config/agents.json атомарно (tmp + rename). */
export function writeAgentsFileAtomic(configDir, data) {
  const file = path.join(configDir, "agents.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* нечего убирать */
    }
    throw err;
  }
  return data;
}

/**
 * Где агент уже занят. Стадии конвейера берём из config/pipeline.json,
 * вызовы из кода — из таблицы ниже (это ровно те id, которые портал
 * запрашивает у engine/config напрямую).
 */
export const CODE_AGENT_USES = Object.freeze({
  assistant: "ассистент портала (server.mjs: assistantAnswer)",
  artist: "художник студии и картинок (server.mjs: /api/studio/prompt, /api/images)",
  scribe: "редактор документов (server.mjs: /api/studio/doc)",
  promptmaster: "мастер промтов (server.mjs: /api/studio/prompt)",
  architect: "архитектор студии — спеки и презентации (server.mjs)",
  security: "аудитор безопасности (lib/engine.mjs)",
});

/** Массив мест использования: [{ kind: "stage"|"code", text }]. */
export function agentUsage(id, pipeline, codeUses = CODE_AGENT_USES) {
  const uses = [];
  for (const stage of pipeline?.stages ?? []) {
    if (stage?.agent === id) {
      uses.push({
        kind: "stage",
        id: stage.id ?? null,
        title: stage.title ?? stage.id ?? id,
        text: `стадия конвейера «${stage.title ?? stage.id ?? id}»${stage.id ? ` (${stage.id})` : ""}`,
      });
    }
  }
  if (codeUses?.[id]) {
    uses.push({ kind: "code", id, text: `код портала: ${codeUses[id]}` });
  }
  // Если в конвейере нет стадии сборки, движок всё равно ищет агента coder.
  if (id === "coder" && !uses.some((u) => u.kind === "stage")) {
    uses.push({ kind: "code", id, text: "код портала: запасной id сборщика в lib/engine.mjs (findCoderId)" });
  }
  return uses;
}

export function usageConflictMessage(id, uses) {
  return `Агент «${id}» занят: ${uses.map((u) => u.text).join("; ")}. Удаление запрещено — сначала переназначь место использования.`;
}

/* --------------------------- помощник настройки --------------------------- */

export const ASSIST_JSON_SYSTEM = [
  "Ты помогаешь настроить агента локального портала разработки.",
  "Верни СТРОГО JSON без markdown и пояснений:",
  '{"name":"имя агента","role":"короткая роль","id":"латиница-цифры-дефис","model":"id модели","provider":"id провайдера","temperature":0.3,"prompt":"системный промт","note":"1–2 фразы по-русски: что ты предложил и почему"}',
  "name и prompt не должны быть пустыми. temperature — число от 0 до 2. id — латиница, цифры и дефис.",
  "Если переданы текущие настройки — предлагай улучшение именно их, а не новый набор с нуля; меняй только то, что действительно нужно.",
  "Пиши по-русски, кратко и по делу. Никакого кода.",
].join("\n");

export const ASSIST_ASK_SYSTEM = [
  "Ты — консультант по настройке агентов локального портала разработки.",
  "Отвечай по-русски, коротко и по делу, без JSON и без markdown-таблиц.",
  "Объясняй на примерах: что даёт параметр, когда его менять, чем рискуешь.",
  "Если вопрос про температуру, роль, провайдера, модель или промт — отвечай применительно к настройке агента.",
  "Не выдумывай факты о портале, которых не знаешь.",
].join("\n");

function providerLabel(providers) {
  try {
    const list = providers?.list?.() ?? [];
    return list.map((p) => `${p.id} (${p.name}${p.enabled === false ? ", выключен" : ""})`).join(", ");
  } catch {
    return "";
  }
}

/** Пользовательская часть промта для предложения (JSON). */
export function assistUserPrompt(text, current = null, providers = null) {
  const query = String(text ?? "").trim();
  const providerList = providerLabel(providers);
  const currentJson = current && typeof current === "object" ? JSON.stringify(current, null, 2) : "";
  return [
    currentJson ? `Текущие настройки агента:\n${currentJson}\n\nЗадача заказчика: ${query}` : `Опиши агента по запросу заказчика: ${query}`,
    currentJson ? "Предложи улучшение текущих настроек, сохранив то, что уже работает." : "",
    providerList ? `Доступные провайдеры: ${providerList}.` : "",
    "Верни только JSON указанной структуры.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function assistAskPrompt(question, current = null) {
  const q = String(question ?? "").trim();
  const currentJson = current && typeof current === "object" ? JSON.stringify(current, null, 2) : "";
  return [currentJson ? `Текущие настройки агента:\n${currentJson}` : "", `Вопрос заказчика: ${q}`]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Привести ответ модели к полной структуре предложения.
 * Невалидный id заменяем slug'ом имени, температуру зажимаем в 0..2,
 * несуществующего провайдера — на default.
 */
export function normalizeAssistProposal(raw, { current = null, providers = null, defaultProvider = null } = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const cur = current && typeof current === "object" ? current : null;
  const name = String(src.name ?? cur?.name ?? "").trim() || "Новый агент";
  const role = String(src.role ?? cur?.role ?? "").trim() || "Помощник";
  let id = String(src.id ?? cur?.id ?? "").trim().toLowerCase();
  if (!AGENT_ID_RE.test(id)) id = slugifyAgentName(name);

  let provider = String(src.provider ?? cur?.provider ?? "").trim();
  if (provider && providers && typeof providers.get === "function" && !providers.get(provider)) provider = "";
  if (!provider) provider = String(defaultProvider ?? "").trim();

  const rawTemp = Number(src.temperature ?? cur?.temperature ?? 0.3);
  const temperature = Number.isFinite(rawTemp) ? Math.min(2, Math.max(0, rawTemp)) : 0.3;
  const prompt =
    String(src.prompt ?? cur?.prompt ?? "").trim() ||
    `Ты — ${role.toLowerCase()}. Помогай заказчику по его задаче. Отвечай по-русски, кратко и по делу.`;
  const note = String(src.note ?? "").trim() || "Предложение сформировано автоматически — проверь поля перед применением.";

  return { name, role, id, model: String(src.model ?? cur?.model ?? "").trim() || "deepseek/deepseek-v3.2", provider, temperature, prompt, note };
}

/** Детерминированная MOCK-заглушка: та же структура, что у живой модели. */
export function mockAssistProposal(text, { current = null, defaultProvider = "openrouter" } = {}) {
  const query = String(text ?? "").trim();
  const cur = current && typeof current === "object" ? current : null;
  const name = String(cur?.name ?? "").trim() || "Новый агент";
  const role = String(cur?.role ?? "").trim() || "Помощник";
  const id = String(cur?.id ?? "").trim() || uniqueAgentId(name, []);
  const model = String(cur?.model ?? "").trim() || "deepseek/deepseek-v3.2";
  const provider = String(cur?.provider ?? "").trim() || defaultProvider;
  const temperature = Number.isFinite(Number(cur?.temperature)) ? Number(cur.temperature) : 0.3;
  const prompt = String(cur?.prompt ?? "").trim()
    ? `${String(cur.prompt).trim()}\n\nУточнение заказчика: ${query || "без дополнительных требований"}`
    : `Ты — ${role.toLowerCase()}. ${query ? `Задача: ${query}.` : "Помогай заказчику по его задаче."} Отвечай по-русски, кратко и по делу.`;
  const note = cur
    ? `MOCK: сохранил текущие настройки «${name}» и добавил уточнение из запроса в промт.`
    : `MOCK: собрал агента «${name}» с ролью «${role}» и температурой ${temperature}.`;
  return normalizeAssistProposal({ name, role, id, model, provider, temperature, prompt, note }, { current: cur });
}

/** Детерминированный MOCK-ответ на свободный вопрос. */
export function mockAssistAnswer(question) {
  const q = String(question ?? "").trim().toLowerCase();
  if (/температур/.test(q)) {
    return "Температура управляет разнообразием ответа. 0.1–0.2 — стабильно и предсказуемо: код, проверки, извлечение фактов. 0.7–1.0 — живее и свободнее: тексты, идеи, промты для картинок. Выше 1.0 ответы становятся менее предсказуемыми, поэтому для рабочих агентов лучше оставаться в 0–0.8.";
  }
  if (/роль|role/.test(q)) {
    return "Роль — короткое название задачи агента для человека: «Ревьюер», «Помощник по документам». Она не заменяет промт, но помогает быстро понять, за что агент отвечает, и не перепутать его с соседним. Пиши 2–4 слова, без общих слов вроде «специалист».";
  }
  if (/провайдер|provider|модель|model/.test(q)) {
    return "Провайдер — шлюз, куда уходит запрос, модель — конкретный id внутри него. Меняй провайдера, если нужен локальный шлюз или другой ключ; модель выбирай по задаче: быстрая и дешёвая для разбора, сильная для кода и длинных текстов. После смены проверь один пробный вызов.";
  }
  if (/промт|prompt/.test(q)) {
    return "Промт задаёт рамку: кто агент, что делает, чего не делает и в каком виде отвечает. Начни с одного абзаца: роль, задача, ограничения, формат ответа. Не перечисляй всё сразу — добавь правило, когда увидишь конкретную ошибку.";
  }
  return `MOCK-ответ на вопрос «${String(question ?? "").trim() || "настройки агента"}»: настраивай агента от задачи. Сначала роль и промт, потом модель и температура. После изменения сделай один пробный вызов и проверь, что ответ соответствует формату.`;
}
