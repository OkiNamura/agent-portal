/** Prompt builders. Every stage gets: task + only the artifacts it actually needs. */

/**
 * Лимиты — в СИМВОЛАХ, не в токенах.
 *
 * Большие проекты: отдавать весь код в каждый промт нельзя. 30 файлов по 10k —
 * это 300k символов: дорого, и в конец контекста всё равно ничего не влезает.
 * Поэтому renderFiles умеет отбирать файлы по приоритету (см. renderSmart),
 * а раздел файлов ограничен 60k. Старое поведение сохранено для вызова без
 * опций: renderFiles(files) / renderFiles(files, { withContent: false }) —
 * 80k на файл, 200k суммарно, файлы целиком, без баннера отбора.
 *
 * Умный режим включается, когда передан block/spec/stage/defects:
 *   1) файлы текущего блока (block.files) — целиком;
 *   2) файлы, упомянутые в спеке/дефектах;
 *   3) остальные — шапка (первые 40 строк) + список экспортируемых имён;
 *   4) для stage=fix большой файл (>20k) с дефектом `файл:строка` — фрагмент
 *      ±60 строк вокруг дефекта, а не весь файл;
 *   5) для stage=test полный код получают только файлы блока, остальные —
 *      сигнатуры с пометкой.
 * Всё вместе не больше PROJECT_BUDGET; в промте всегда есть явная пометка,
 * что и почему показано частично.
 */
const LIMIT = 200_000;
const FILE_LIMIT = 80_000;

/** Умный отбор файлов. */
const PROJECT_BUDGET = 60_000; // бюджет раздела файлов
const MAX_PROMPT_CHARS = 60_000; // бюджет всего промта стадии
const SIG_HEAD_LINES = 40;
const SIG_MAX_CHARS = 2_000;
const MIN_SIG_CHARS = 240;
const BIG_FILE_CHARS = 20_000;
const FIX_CONTEXT_LINES = 60;
const FILES_SLOT = "\u0000FILES\u0000";

const cut = (s = "", n = LIMIT) =>
  s.length > n ? s.slice(0, n) + `\n…[обрезано: показаны первые ${n} из ${s.length} символов]` : s;

/** Жёсткая обрезка, которая гарантирует длину <= n (в отличие от cut). */
function hardCut(s, n) {
  const text = String(s ?? "");
  const limit = Math.max(0, Number(n) || 0);
  if (text.length <= limit) return text;
  if (limit <= 60) return text.slice(0, limit);
  const note = "\n…[обрезано по лимиту отбора]";
  return text.slice(0, limit - note.length) + note;
}

const normPath = (p = "") =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();

const baseName = (p = "") => normPath(p).split("/").pop() ?? "";

/** Имена, которые файл отдаёт наружу. Для немодулей — объявления верхнего уровня. */
function exportedNames(content = "") {
  const names = new Set();
  let explicit = false;
  const add = (raw) => {
    const name = String(raw ?? "").trim();
    if (name && names.size < 40) names.add(name);
  };
  const patterns = [
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bexports\.([A-Za-z_$][\w$]*)\s*=/g,
  ];
  for (const re of patterns) {
    for (const m of content.matchAll(re)) {
      explicit = true;
      add(m[1]);
    }
  }
  for (const m of content.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    explicit = true;
    for (const piece of m[1].split(",")) add(piece.trim().split(/\s+as\s+/).pop());
  }
  for (const m of content.matchAll(/\bmodule\.exports\s*=\s*\{([^}]*)\}/g)) {
    explicit = true;
    for (const piece of m[1].split(",")) {
      const key = piece.trim().split(":")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) add(key);
    }
  }
  if (!names.size) {
    // обычный script.js без модулей: полезнее имена функций, чем пустой список
    for (const re of [
      /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*class\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
    ]) {
      for (const m of content.matchAll(re)) add(m[1]);
    }
  }
  return { names: [...names], explicit };
}

/** "src/app.js:120" / "app.js:120-140" -> {path, from, to}. */
function parseWhere(where) {
  const s = String(where ?? "").trim();
  const m = s.match(/^(.*?):(\d+)(?:\s*[-–]\s*(\d+))?$/);
  if (!m) return null;
  const from = Number(m[2]);
  const to = Number(m[3] ?? m[2]);
  if (!Number.isFinite(from) || from < 1) return null;
  return { path: normPath(m[1]), from, to: Number.isFinite(to) && to >= from ? to : from };
}

const samePath = (a, b) => {
  const x = normPath(a).toLowerCase();
  const y = normPath(b).toLowerCase();
  if (!x || !y) return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
};

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Фрагмент вокруг строк дефектов: ±60 строк, с номерами строк. */
function fragmentEntry(f, lineNumbers, room, defectRefs) {
  const header = `--- ${f.path} ---`;
  const lines = String(f.content ?? "").split("\n");
  const total = lines.length;
  const ranges = mergeRanges(
    [...lineNumbers]
      .map((n) => Math.max(1, Math.min(total, Number(n) || 1)))
      .sort((a, b) => a - b)
      .map((n) => [Math.max(1, n - FIX_CONTEXT_LINES), Math.min(total, n + FIX_CONTEXT_LINES)])
  );
  const shown = ranges.map(([a, b]) => `${a}–${b}`).join(", ");
  const note =
    `…[файл ${f.content.length} символов > ${BIG_FILE_CHARS}: целиком не передаётся, чтобы не раздувать промт. ` +
    `Показан фрагмент ±${FIX_CONTEXT_LINES} строк вокруг дефекта ${defectRefs || lineNumbers.join(", ")}: строки ${shown} из ${total}. ` +
    `Остальной код не показан — верни файл целиком, продолжив существующий код, а не только этот фрагмент]`;
  const body = ranges
    .map(([a, b]) => {
      const chunk = [];
      for (let n = a; n <= b; n++) chunk.push(`${String(n).padStart(5, " ")}| ${lines[n - 1] ?? ""}`);
      return chunk.join("\n");
    })
    .join("\n\n…[пропуск между фрагментами]\n\n");
  return hardCut(`${header}\n${note}\n\n${body}`, room);
}

function fullEntry(f, room, reason) {
  const header = `--- ${f.path} ---`;
  const content = String(f.content ?? "");
  if (!content) return `${header}\n(пустой файл)`;
  const avail = room - header.length - 1;
  if (content.length <= avail) return `${header}\n${content}`;
  if (avail < 160) {
    return hardCut(`${header}\n…[файл не показан: исчерпан общий лимит ${PROJECT_BUDGET} символов; причина — ${reason}]`, room);
  }
  const note = `\n…[файл показан частично: ${content.length} символов, влезло ~${avail}; остальное не показано из-за лимита отбора (${reason})]`;
  return `${header}\n${content.slice(0, Math.max(0, avail - note.length))}${note}`;
}

function signatureEntry(f, room, why) {
  const header = `--- ${f.path} ---`;
  const content = String(f.content ?? "");
  const lines = content.split("\n");
  const { names, explicit } = exportedNames(content);
  const nameLine = names.length
    ? `Экспортируемые имена: ${names.join(", ")}`
    : explicit
      ? "Экспортируемые имена: —"
      : "Экспортируемые имена: не найдены (нет export/module.exports); это не модуль";
  const note =
    `\n…[файл показан частично: ${content.length} символов; переданы шапка (до ${SIG_HEAD_LINES} строк) и список имён, потому что ${why}]`;
  const tail = `\n${nameLine}${note}`;
  const headRoom = room - header.length - 1 - tail.length;
  if (headRoom < 120) return hardCut(`${header}\n${nameLine}${note}`, room);
  let head = lines.slice(0, SIG_HEAD_LINES).join("\n");
  if (lines.length > SIG_HEAD_LINES) head += `\n…[шапка: первые ${SIG_HEAD_LINES} строк из ${lines.length}]`;
  if (head.length > headRoom) head = head.slice(0, Math.max(0, headRoom - 60)) + "\n…[шапка сокращена: лимит]";
  return `${header}\n${head}${tail}`;
}

/** Старое поведение: файлы целиком, 80k на файл, 200k суммарно. */
function renderLegacy(files, withContent) {
  let budget = LIMIT;
  const out = [];
  for (const f of files) {
    const head = `--- ${f.path} ---`;
    if (!withContent) {
      out.push(f.path);
      continue;
    }
    if (budget <= 0) {
      out.push(`${head}\n…[файл не показан: исчерпан общий лимит промпта]`);
      continue;
    }
    const room = Math.min(budget, FILE_LIMIT);
    const body = cut(f.content ?? "", room);
    budget -= body.length;
    out.push(`${head}\n${body}`);
  }
  return out.join("\n\n");
}

/** Умный отбор файлов по приоритету. Вызывается только когда есть block/spec/stage/defects. */
function renderSmart(files, { block, spec, stage, defects, maxChars }) {
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.min(Number(maxChars), PROJECT_BUDGET)) : PROJECT_BUDGET;
  const all = (Array.isArray(files) ? files : [])
    .map((f, index) => ({ path: normPath(f?.path), content: String(f?.content ?? ""), index }))
    .filter((f) => f.path);
  if (!all.length) return "(файлов пока нет)";
  const byPath = new Map(all.map((f) => [f.path, f]));
  const stageId = String(stage ?? "").toLowerCase();

  /* 1. файлы текущего блока — в порядке block.files, даже если файла нет в списке */
  const blockOrder = (Array.isArray(block?.files) ? block.files : [])
    .map((f) => normPath(typeof f === "string" ? f : f?.path))
    .filter(Boolean);
  const blockFiles = [];
  const missingBlock = [];
  for (const p of blockOrder) {
    const f = byPath.get(p);
    if (f) blockFiles.push(f);
    else missingBlock.push(p);
  }
  const blockSet = new Set(blockFiles.map((f) => f.path));

  /* 2. файлы, упомянутые в дефектах и спеке (поиск по имени) */
  const score = new Map();
  const defectLines = new Map();
  const bump = (path, value) => score.set(path, Math.max(score.get(path) ?? 0, value));
  const specLower = String(spec ?? "").toLowerCase();
  for (const f of all) {
    const base = baseName(f.path).toLowerCase();
    if (base && specLower.includes(base)) bump(f.path, 1);
  }
  const defectRefs = new Map();
  for (const d of Array.isArray(defects) ? defects : []) {
    const where = parseWhere(d?.where);
    if (where) {
      const hit = all.find((f) => samePath(f.path, where.path));
      if (hit) {
        bump(hit.path, 3);
        const set = defectLines.get(hit.path) ?? new Set();
        for (let n = where.from; n <= where.to && n - where.from < 200; n++) set.add(n);
        defectLines.set(hit.path, set);
        const refs = defectRefs.get(hit.path) ?? [];
        refs.push(String(d?.where));
        defectRefs.set(hit.path, refs);
      }
    }
    const text = `${d?.where ?? ""} ${d?.what ?? ""} ${d?.criterion ?? ""}`.toLowerCase();
    for (const f of all) {
      const base = baseName(f.path).toLowerCase();
      if (!base) continue;
      if (text.includes(base) || text.includes(f.path.toLowerCase())) bump(f.path, Math.max(2, score.get(f.path) ?? 0));
    }
  }
  const mentioned = all
    .filter((f) => !blockSet.has(f.path) && (score.get(f.path) ?? 0) > 0)
    .sort((a, b) => (score.get(b.path) ?? 0) - (score.get(a.path) ?? 0) || a.index - b.index);
  const mentionedSet = new Set(mentioned.map((f) => f.path));
  const rest = all.filter((f) => !blockSet.has(f.path) && !mentionedSet.has(f.path));

  /* 3. бюджет: резерв под шапку-сводку, список непоказанных, остальное — файлам */
  const RESERVE = 1_400;
  const bodyLimit = Math.max(0, budget - RESERVE);
  const parts = [];
  const omittedPaths = [];
  let used = 0;
  const stats = { full: 0, fragment: 0, partial: 0, signature: 0, omitted: 0 };
  const roomLeft = () => Math.max(0, bodyLimit - used);
  const push = (text) => {
    parts.push(text);
    used += text.length + 2;
  };
  const noteSkipped = (path, why) =>
    `--- ${path} ---\n…[файл не показан: исчерпан общий лимит отбора ${budget} символов; ${why}]`;
  const skip = (f, why, keepHeader) => {
    stats.omitted += 1;
    if (keepHeader) push(noteSkipped(f.path, why));
    else omittedPaths.push(f.path);
  };

  const renderOne = (f, group) => {
    const room = roomLeft();
    const inBlock = group === "block";
    // fix: большой файл с дефектом "файл:строка" -> фрагмент, а не весь файл
    if (stageId === "fix" && f.content.length > BIG_FILE_CHARS && defectLines.has(f.path)) {
      if (room < 400) {
        skip(f, "место под фрагмент вокруг дефекта закончилось", inBlock);
        return;
      }
      push(fragmentEntry(f, defectLines.get(f.path), room, (defectRefs.get(f.path) ?? []).join(", ")));
      stats.fragment += 1;
      return;
    }
    // test: полный код только у файлов блока
    const full = inBlock || (group === "mentioned" && stageId !== "test");
    if (full) {
      if (room < 160) {
        skip(f, inBlock ? "файл блока не поместился" : "место закончилось", inBlock);
        return;
      }
      const reason = inBlock ? "файл текущего блока — приоритет" : "файл упомянут в спеке/дефектах — приоритет";
      const text = fullEntry(f, room, reason);
      push(text);
      if (text.includes("показан частично")) stats.partial += 1;
      else stats.full += 1;
      return;
    }
    // остальные — сигнатуры (для test — и упомянутые тоже)
    const why = group === "mentioned"
      ? "файл упомянут в спеке/дефектах, но не входит в блок (stage=test)"
      : "файл не входит в текущий блок и не упомянут в спеке/дефектах";
    if (room < MIN_SIG_CHARS) {
      skip(f, "место под сигнатуры закончилось", inBlock);
      return;
    }
    push(signatureEntry(f, Math.min(room, SIG_MAX_CHARS), why));
    stats.signature += 1;
  };

  for (const p of missingBlock) {
    stats.omitted += 1;
    push(`--- ${p} ---\n…[файл из block.files отсутствует в проекте: показать нечего]`);
  }
  for (const f of blockFiles) renderOne(f, "block");
  for (const f of mentioned) renderOne(f, "mentioned");
  const restBudget = roomLeft();
  const restShare = Math.floor(restBudget / Math.max(1, rest.length));
  const restCap = Math.max(MIN_SIG_CHARS, Math.min(SIG_MAX_CHARS, restShare));
  for (const f of rest) {
    const room = roomLeft();
    if (room < MIN_SIG_CHARS) {
      skip(f, "место под сигнатуры остальных файлов закончилось", false);
      continue;
    }
    push(signatureEntry(f, Math.min(room, restCap), "файл не входит в текущий блок и не упомянут в спеке/дефектах"));
    stats.signature += 1;
  }
  if (omittedPaths.length) {
    const shown = omittedPaths.slice(0, 12).join(", ");
    const more = omittedPaths.length > 12 ? `; ещё ${omittedPaths.length - 12}` : "";
    push(
      `…[не показаны ${omittedPaths.length} файл(ов): ${shown}${more}. ` +
        `Причина — исчерпан общий лимит отбора ${budget} символов; эти файлы существуют, не считай их отсутствующими или нереализованными]`
    );
  }

  const blockLabel = block?.id ? ` ${block.id}` : "";
  const summary = [
    "## Как отобраны файлы для этого промта",
    `Всего файлов: ${all.length}; бюджет раздела: ${budget} символов (лимит ${PROJECT_BUDGET}).`,
    `Показано полностью: ${stats.full}; фрагментами вокруг дефекта: ${stats.fragment}; частично/сигнатурами: ${stats.signature + stats.partial}; не показано: ${stats.omitted}.`,
    `Приоритет: файлы текущего блока${blockLabel} → файлы, упомянутые в спеке/дефектах → остальные (первые ${SIG_HEAD_LINES} строк + список экспортируемых имён).`,
    "Всё, что не влезло, помечено («показан частично» в файле или в списке непоказанных) — такой файл существует, не считай его отсутствующим или нереализованным.",
  ].join("\n");
  return hardCut(`${summary}\n\n${parts.join("\n\n")}`, budget);
}

/**
 * Рендер файлов для промта.
 * Без block/spec/stage/defects — прежнее поведение (все файлы целиком).
 * С ними — приоритетный отбор с бюджетом PROJECT_BUDGET.
 */
export function renderFiles(
  files,
  { withContent = true, block = null, spec = "", stage = "", defects = [], maxChars = null } = {}
) {
  if (!files?.length) return "(файлов пока нет)";
  if (!withContent) return renderLegacy(files, false);
  const smart = Boolean(block || spec || stage || (Array.isArray(defects) && defects.length));
  return smart ? renderSmart(files, { block, spec, stage, defects, maxChars }) : renderLegacy(files, true);
}

/** Подставить отбор файлов в шаблон и уложить ВЕСЬ промт в MAX_PROMPT_CHARS. */
function fillFiles(skeleton, files, opts) {
  const base = skeleton.length - FILES_SLOT.length;
  const maxChars = Math.max(0, Math.min(PROJECT_BUDGET, MAX_PROMPT_CHARS - base));
  const rendered = renderFiles(files, { ...opts, maxChars });
  return skeleton.split(FILES_SLOT).join(rendered);
}

export function renderPlan(plan) {
  if (!plan) return "(плана нет)";
  const lines = [`# ${plan.title ?? "План"}`, ""];
  for (const b of plan.blocks ?? []) {
    lines.push(`## ${b.id}. ${b.title}`);
    lines.push(`Цель: ${b.goal}`);
    if (b.deps?.length) lines.push(`Зависит от: ${b.deps.join(", ")}`);
    if (b.acceptance?.length) {
      lines.push("Критерии приёмки:");
      for (const a of b.acceptance) lines.push(`- ${a}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function mockupPrompt({ task, plan, specs }) {
  return {
    user: `Задача: ${task}

План:
${renderPlan(plan)}

Спеки блоков:
${(specs ?? []).map((s) => `--- ${s.id}: ${s.title} ---\n${cut(s.text, 2500)}`).join("\n\n") || "(спек пока нет)"}

Собери ОДИН макет будущего продукта — как он будет выглядеть, когда всё готово. Это не рабочий код, а картинка интерфейса.

Требования:
- Один самодостаточный HTML-файл: весь CSS внутри <style>, без внешних ссылок, шрифтов и картинок из интернета.
- Покажи главный экран и ключевые состояния (например: пустое состояние, результат, ошибка), если они есть по спеке.
- Настоящий контент на русском, осмысленные подписи и цифры — не lorem ipsum и не "заголовок 1".
- Аккуратно: отступы кратны 8, читаемый контраст, аккуратная сетка, никакой пестроты.
- Никакого JavaScript, кроме мелочей вроде переключения вкладки (не обязательно).

Верни ТОЛЬКО HTML-документ, целиком, начиная с <!doctype html>. Без markdown-забора и без пояснений.`,
  };
}

export function planPrompt({ task, feedback, change, projectFiles }) {
  const revision = Boolean(change);
  return {
    user: `Задача от заказчика:
"""
${task}
"""
${revision ? `\nЭТО ДОРАБОТКА УЖЕ ГОТОВОГО ПРОЕКТА. Что нужно изменить:
"""
${change}
"""
Текущий проект (файлы уже существуют, код писать заново не надо):
${renderFiles(projectFiles, { withContent: false })}

Планируй ТОЛЬКО изменения: блоки должны описывать, что добавить или поправить, а не переписывать проект.
` : ""}Разбей ${revision ? "изменение" : "задачу"} на 1–4 блока. Блок — это кусок, который можно проверить отдельно.
Правила:
- Блоки не должны пересекаться по файлам и смыслу.
- У каждого блока — проверяемые критерии приёмки (не «работает хорошо», а «после X видно Y»).
- Зависимости указывай только реальные.
- Если задача мелкая — сделай 1 блок и не дроби её искусственно.

Верни СТРОГО JSON без markdown:
{"title":"...","blocks":[{"id":"b1","title":"...","goal":"...","acceptance":["..."],"deps":[]}]}
${feedback ? `\nЗамечания заказчика к предыдущей версии (учти обязательно):\n${feedback}` : ""}`,
  };
}

export function specPrompt({ task, plan, block, feedback }) {
  return {
    user: `Задача: ${task}

Общий план:
${renderPlan(plan)}

Ты пишешь спеку ТОЛЬКО для блока ${block.id} — «${block.title}».
Цель блока: ${block.goal}
${block.deps?.length ? `Зависит от блоков: ${block.deps.join(", ")}` : "Не зависит от других блоков."}

Спека — договор, по которому потом напишут код и проверят его. Пиши markdown:

# ${block.title}
## Цель
## Что входит
## Чего НЕ входит
## Критерии приёмки
(проверяемые пункты: что нажать/запустить и что должно получиться)
## Зависимости
## Открытые вопросы
(0–2 пункта, и только если без ответа нельзя писать код; всё остальное реши сам и запиши решением)

Пиши по-русски, конкретно, без общих слов. Не пиши код.
Решай неоднозначности сам: спека должна быть однозначной, а не справочником вопросов.
${feedback ? `\nЗамечания заказчика к предыдущей версии:\n${feedback}` : ""}`,
  };
}

export function designPrompt({ task, block, spec, feedback }) {
  return {
    user: `Задача: ${task}
Блок ${block.id} — ${block.title}.

Спека блока:
${cut(spec)}

Опиши дизайн/UX этого блока (markdown): структура экрана, состояния элементов, поведение, ограничения по стилю. Без кода. Кратко и по делу.
${feedback ? `\nЗамечания заказчика:\n${feedback}` : ""}`,
  };
}

/** Жёсткие правила для инженера: одинаковые в code и fix — чтобы не было «огрызков». */
const FULL_FILE_RULES = `ЖЁСТКИЕ ПРАВИЛА (нарушение любого = провал блока):
1. Возвращай ПОЛНЫЕ файлы целиком, а не фрагменты, не diff и не «только изменённые строки». В content — весь файл от первой строки до последней.
2. Заглушки запрещены: каждая объявленная функция обязана иметь рабочее тело. Пустое тело, «// TODO», комментарий вместо кода, «return;» вместо логики, «throw new Error("not implemented")» — это провал.
3. Если файл длинный — всё равно верни его полностью. Лучше длинный ответ, чем обрезанный файл: не сокращай код и не выбрасывай уже работающие функции.
4. Каждый критерий приёмки спеки должен быть РЕАЛИЗОВАН в коде, а не только назван в комментарии или в notes.
5. «Минимальный код» — это минимум лишнего, а не минимум логики. Нет логики — нет выполнения задачи.
6. Не удаляй и не упрощай существующие функции, если этого не требует дефект; сохраняй весь ранее работающий функционал. Проект общий: чужие блоки и их функции уже работают, их нельзя вырезать, переименовывать или «оптимизировать» ради своего дефекта. Меняй только то, что прямо нужно для исправления.`;


export function codePrompt({ task, block, spec, design, projectFiles, feedback }) {
  const hasFiles = Boolean(projectFiles?.length);
  const skeleton = `Задача: ${task}
Блок ${block.id} — ${block.title}.

Спека (обязательна к исполнению):
${cut(spec)}
${design ? `\nДизайн:\n${cut(design, 6000)}\n` : ""}
${
  hasFiles
    ? `\nТЕКУЩИЙ ПРОЕКТ (это общий проект, а не отдельная папка блока; файлы блока — целиком, остальные — по приоритету, с пометками «показан частично»):\n${FILES_SLOT}\n`
    : "\nПроект пока пуст — ты создаёшь первые файлы.\n"
}
${FULL_FILE_RULES}

Дополнительно:
- Проект ОДИН. Не создавай параллельную копию в src/${block.id}/, если файл с такой ролью уже есть — правь существующий.
- Дополняй, а не переписывай: если файл уже есть, верни его полное содержимое с нужными изменениями, сохранив всё, что уже работало.
- Самодостаточность: никаких внешних библиотек, если это не оговорено в спеке.
- Только относительные пути внутри проекта.
- Перед ответом проверь себя: в каждом файле нет пустых функций; файл не обрывается на середине; все критерии спеки покрыты.

Верни СТРОГО JSON:
{"files":[{"path":"...","content":"<полное содержимое файла целиком>"}],"notes":"что сделано, одной фразой"}
${feedback ? `\nЗамечания заказчика к предыдущей версии:\n${feedback}` : ""}`;
  return {
    user: hasFiles ? fillFiles(skeleton, projectFiles, { block, spec, stage: "build" }) : skeleton,
  };
}

export function testPrompt({ task, block, spec, files, testOutput, fallbacks = 0 }) {
  const skeleton = `Задача: ${task}
Блок ${block.id} — ${block.title}.

Спека с критериями приёмки:
${cut(spec)}

ВЕСЬ проект сейчас (проверяй итоговое состояние, а не отдельную папку блока). Полный код передан только для файлов текущего блока; остальные — шапка и список имён с пометкой, что показано частично:
${FILES_SLOT}

${fallbacks > 0 ? `ВНИМАНИЕ: часть кода этого прогона писалась резервной моделью (fallback, вызовов: ${fallbacks}) — проверь внимательнее. Резервная модель слабее основной: чаще теряет уже работающие функции, пустые тела и обрезанные файлы. Сверь, что весь ранее работавший функционал на месте.\n` : ""}${testOutput ? `Вывод автоматической проверки:\n"""\n${cut(testOutput, 4000)}\n"""` : "Автоматическая проверка не запускалась — проверяй по коду и спеке."}

ЖЁСТКИЕ ПРАВИЛА ПРОВЕРКИ (нарушать нельзя):
1. Дефект существует ТОЛЬКО если нарушен критерий приёмки из спеки. В каждом дефекте поле criterion — дословная цитата критерия (с его номером, если в спеке есть нумерация), поле what — как именно код его нарушает. severity blocker|major — только при нарушенном критерии. Стиль, формулировки, «лучше уточнить» — не дефекты. Нет нарушенного критерия — нет дефекта.
2. Запрещено требовать того, чего нет в спеке, даже если «так было бы лучше», «так принято» или «без этого критично». Нет критерия в спеке — нет дефекта.
3. Без дублей: один дефект = одна запись. Если несколько формулировок описывают одну и ту же проблему в одном и том же месте — оставь одну, самую точную.
4. Доступность (prefers-reduced-motion, alt, контраст, фокус) — это minor, если спека не назвала её блокирующей.
5. verdict=fail — только если хотя бы один критерий приёмки не выполнен. Minor-дефекты сами по себе блок не валят: при них verdict=pass.
6. Максимум 5 дефектов, и у каждого обязательно where в формате файл:строка (например src/app.js:42).
7. Если критерий выполняется — считай его выполненным, даже если реализовано не так, как сделал бы ты. Пустой список дефектов — нормальный результат.
8. Полный код передан только для файлов текущего блока. Файлы с пометкой «показан частично» и сигнатуры — это СОЗНАТЕЛЬНО сокращённый просмотр: нельзя объявлять функцию отсутствующей или файл обрезанным, если ты видишь только шапку. Дефект «функция объявлена, но не реализована» допустим ТОЛЬКО если ты процитировал её пустое тело или комментарий вместо кода. Фраза «код обрывается» без цитаты последней строки файла — выдумка, а не дефект.

Сначала по каждому критерию приёмки отметь выполнение, потом сделай вывод.

Верни СТРОГО JSON:
{"criteria":[{"text":"критерий","met":true,"evidence":"файл:строка или чем подтверждается"}],
 "verdict":"pass"|"fail",
 "defects":[{"severity":"blocker"|"major"|"minor","criterion":"цитата критерия из спеки","where":"файл:строка","what":"как код нарушает этот критерий"}],
 "summary":"1–2 фразы"}
verdict=fail только если есть хотя бы один невыполненный критерий.`;
  return {
    user: fillFiles(skeleton, files, { block, spec, stage: "test" }),
  };
}

// ВАЖНО для инженера: ниже передаётся ПОЛНЫЙ текст спеки вместе с дефектами,
// иначе он чинит только перечисленное и пропускает остальные критерии.
export function fixPrompt({ task, block, spec, files, projectFiles, defects, round }) {
  const list = projectFiles?.length ? projectFiles : Array.isArray(files) ? files : [];
  const skeleton = `Задача: ${task}
Блок ${block.id} — ${block.title}. Круг правок: ${round}.

Спека (полностью, все критерии):
${cut(spec)}

Текущий код (файлы блока и упомянутые в дефектах — целиком; большой файл с дефектом «файл:строка» — фрагмент ±${FIX_CONTEXT_LINES} строк вокруг дефекта; остальные — сигнатуры, с пометками отбора):
${FILES_SLOT}

Найденные дефекты:
${defects.map((d, i) => `${i + 1}. [${d.severity}] ${d.where}: ${d.what}${d.criterion ? ` (критерий: ${d.criterion})` : ""}`).join("\n")}

${FULL_FILE_RULES}

Правь ВСЕ критерии спеки, а не только перечисленные дефекты: пройди по спеке пункт за пунктом и убедись, что каждый реализован. Если дефект — ложное срабатывание, не ломай рабочий код, но проверь критерий сам и объясни это в notes.
Запрещено удалять или упрощать функции, которых нет в списке дефектов: чужие блоки уже работают на этих функциях, их потеря — регрессия. Если для исправления нужно переписать функцию — перепиши её целиком, сохранив прежнее поведение и сигнатуру.
Если файл передан фрагментом — это экономия промта, а не разрешение вернуть огрызок: в ответе всё равно нужен ВЕСЬ файл целиком.
Перед ответом проверь себя: ни одной пустой функции, ни одного «TODO вместо кода», файлы возвращены целиком и не обрываются.

Верни СТРОГО JSON:
{"files":[{"path":"...","content":"<полное содержимое изменённых файлов целиком>"}],"notes":"что исправлено"}`;
  return {
    user: fillFiles(skeleton, list, { block, spec, defects, stage: "fix" }),
  };
}

export function securityPrompt({ task, block, spec, files }) {
  const skeleton = `Проект: ${task}
Блок ${block.id} — ${block.title}.

Спека:
${cut(spec, 4000)}

Код проекта (файлы блока и упомянутые в спеке — целиком; остальные — сигнатуры, с пометками отбора):
${FILES_SLOT}

Проверь ТОЛЬКО безопасность: бэкдоры, скрытые сетевые вызовы, отправка данных наружу, eval/Function, обфускация, чтение файлов вне проекта, опасные команды, утечки ключей, скрытые ссылки и трекеры.

Верни СТРОГО JSON:
{"verdict":"pass"|"fail","findings":[{"severity":"blocker"|"major"|"minor","where":"файл:строка","what":"что опасно и чем грозит"}],"summary":"1–2 фразы"}`;
  return {
    user: fillFiles(skeleton, files, { block, spec, stage: "security" }),
  };
}

export function reportPrompt({ task, plan, blocks, usage }) {
  const lines = (blocks ?? []).map(
    (b) =>
      `- ${b.id} «${b.title}»: статус ${b.status}` +
      (b.test?.verdict ? `, тест: ${b.test.verdict}` : "") +
      (b.test?.defects?.length ? `, дефектов: ${b.test.defects.length}` : "")
  );
  return {
    user: `Задача: ${task}

План:
${renderPlan(plan)}

Состояние блоков:
${lines.join("\n") || "(нет данных)"}

Потрачено на прогон: ${usage.calls} вызовов, $${usage.cost.toFixed(4)}.

Собери короткую сводку для заказчика (markdown):
# Сводка
## Сделано
## Не сделано / сломано
## Риски
## Что проверить руками
(3–5 конкретных шагов)
## Следующий шаг

Без воды, только то, что заказчик может проверить сам.`,
  };
}
