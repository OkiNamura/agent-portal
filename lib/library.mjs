/**
 * Общая библиотека студии: избранное / архив / корзина.
 *
 * Хранилище — `<studio>/library.json`:
 *   { items: { "chat:<id>": { fav, archived, deletedAt }, "image:<id>": ..., "doc:<id>": ... } }
 *
 * Модуль отвечает только за разметку ссылок. Физическое удаление (файлы чата,
 * картинки, сообщения) делает server.mjs через Studio — здесь нет доступа к ним.
 *
 * Запись атомарная (tmp + rename), как в остальных хранилищах портала.
 */
import fs from "node:fs";
import path from "node:path";

export const LIBRARY_VIEWS = Object.freeze(["all", "fav", "archive", "trash"]);

const REF_RE = /^(chat|image|doc):([\w-]{1,64})$/;

/** Допустимый вид библиотеки; неизвестный → all (чужой query не должен ронять API). */
export function normalizeView(raw) {
  const view = String(raw ?? "all").trim().toLowerCase();
  return LIBRARY_VIEWS.includes(view) ? view : "all";
}

/** Ссылка `chat:<sessionId>` | `image:<imageId>` | `doc:<messageId>`. */
export function parseRef(ref) {
  const value = String(ref ?? "").trim();
  const m = value.match(REF_RE);
  if (!m) throw new Error("Некорректная ссылка: нужен chat:<id>, image:<id> или doc:<id>");
  return { ref: value, type: m[1], id: m[2] };
}

function cleanState(raw) {
  const st = raw && typeof raw === "object" ? raw : {};
  return {
    fav: Boolean(st.fav),
    archived: Boolean(st.archived),
    deletedAt: typeof st.deletedAt === "string" && st.deletedAt.trim() ? st.deletedAt : null,
  };
}

function isDefault(st) {
  return !st.fav && !st.archived && !st.deletedAt;
}

/** Совпадает ли состояние с выбранным видом. */
export function matchesView(state, view) {
  const st = cleanState(state);
  if (view === "trash") return Boolean(st.deletedAt);
  if (st.deletedAt) return false; // корзина — отдельный вид, в остальных не мешаем
  if (view === "archive") return st.archived;
  if (view === "fav") return st.fav;
  return !st.archived; // all
}

export class Library {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, "library.json");
    this.items = {};
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
      const items = raw?.items && typeof raw.items === "object" ? raw.items : {};
      this.items = {};
      for (const [ref, state] of Object.entries(items)) {
        try {
          parseRef(ref);
        } catch {
          continue; // чужую/битую ссылку молча выкидываем
        }
        const clean = cleanState(state);
        if (!isDefault(clean)) this.items[ref] = clean;
      }
    } catch {
      this.items = {};
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  /** Состояние ссылки; отсутствующая запись = всё по умолчанию. */
  state(ref) {
    parseRef(ref);
    return cleanState(this.items[ref]);
  }

  get(ref) {
    parseRef(ref);
    return this.items[ref] ?? null;
  }

  isDeleted(ref) {
    return Boolean(this.state(ref).deletedAt);
  }

  isArchived(ref) {
    return Boolean(this.state(ref).archived);
  }

  isFav(ref) {
    return Boolean(this.state(ref).fav);
  }

  /** Точечно меняет fav/archived. Возвращает актуальное состояние. */
  mark(ref, patch = {}) {
    parseRef(ref);
    const next = this.state(ref);
    if (patch.fav !== undefined) next.fav = Boolean(patch.fav);
    if (patch.archived !== undefined) next.archived = Boolean(patch.archived);
    this.write(ref, next);
    return next;
  }

  /** В корзину: дата первого удаления сохраняется (повторный клик её не сдвигает). */
  trash(ref) {
    const next = this.state(ref);
    if (!next.deletedAt) next.deletedAt = new Date().toISOString();
    this.write(ref, next);
    return next;
  }

  /** Из корзины: остальные пометки (избранное/архив) не трогаем. */
  restore(ref) {
    const next = this.state(ref);
    next.deletedAt = null;
    this.write(ref, next);
    return next;
  }

  /** Убрать запись библиотеки совсем (после физического удаления). */
  remove(ref) {
    parseRef(ref);
    if (this.items[ref]) {
      delete this.items[ref];
      this.save();
      return true;
    }
    return false;
  }

  write(ref, state) {
    const clean = cleanState(state);
    if (isDefault(clean)) {
      if (this.items[ref]) {
        delete this.items[ref];
        this.save();
      }
      return;
    }
    this.items[ref] = clean;
    this.save();
  }

  /** Ссылки выбранного вида (без обогащения — это делает сервер). */
  list(view = "all") {
    const v = normalizeView(view);
    return Object.entries(this.items)
      .filter(([, st]) => matchesView(st, v))
      .map(([ref, st]) => ({ ref, ...cleanState(st) }));
  }

  counts() {
    const view = { all: 0, fav: 0, archive: 0, trash: 0 };
    for (const state of Object.values(this.items)) {
      for (const v of LIBRARY_VIEWS) if (matchesView(state, v)) view[v]++;
    }
    return view;
  }
}
