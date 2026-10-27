/* Agent Portal — vanilla UI, no build step. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const S = {
  mode: "mock",
  page: "projects",
  user: null,
  role: null,
  authDead: false,
  agents: [],
  agentsFile: null,
  pipelineFile: null,
  stages: [],
  projects: [],
  project: null,
  runs: [],
  current: null,
  editingAgent: null,
  stream: null,
  lastSeq: 0,
  artSig: "",
  previewSig: "",
  activeArtifact: null,
  raw: false,
  models: [],
  modelsTried: false,
  logCutoff: 0,
  metrics: null,
  studio: { thread: [], models: [], sessions: [], activeId: null, refItem: null, refData: null, lastText: "", view: "all", collapsed: {} },
  gallery: { items: [], total: 0, cost: 0, q: "", view: "all" },
  watch: { running: false, everyMin: 10, lastRunAt: null, lastAlerts: [] },
  corner: { items: [], unread: 0, alerts: [], tabs: {}, tab: "critical" },
  globalStream: null,
  diff: { runId: null, data: null, file: null },
  tab: "flow",
  view: "mockup",
};

/* ------------------------- библиотека и группы студии ------------------------- */

const LIB_VIEWS = [
  ["all", "Все", "Все"],
  ["fav", "★", "Избранное"],
  ["archive", "🗄", "Архив"],
  ["trash", "🗑", "Корзина"],
];
const STUDIO_GROUP_KEY = "portal.studio.groups";
const STUDIO_VIEW_KEY = "portal.studio.view";
const GALLERY_VIEW_KEY = "portal.gallery.view";

const STUDIO_KIND_META = {
  images: {
    title: "Картинки",
    icon: "🖼",
    placeholder: "Опиши, что хочешь — художник перепишет это в промт и покажет, что отправит",
    send: "Художник",
    empty: "Опиши, что хочешь — художник перепишет это в промт, покажет, что отправит, и нарисует после твоего «Отправить».",
  },
  docs: {
    title: "Документы",
    icon: "📄",
    placeholder: "Вставь текст документа — редактор вычитает или приведёт в порядок…",
    send: "Вычитать",
    empty: "Вставь текст — редактор приведёт его в порядок. Короткий запрос он может переписать, большой документ только вычитает: орфография и разметка, без изменения смысла.",
  },
  specs: {
    title: "Спеки",
    icon: "📐",
    placeholder: "Опиши задачу — архитектор напишет спеку. Следующим сообщением можно попросить доработать…",
    send: "Написать спеку",
    empty: "Опиши задачу словами: что нужно сделать, для кого и по каким критериям принимать. Архитектор соберёт спеку-договор в markdown, её можно скачать, поправить или доработать следующим сообщением.",
  },
  prompts: {
    title: "Промты",
    icon: "✎",
    placeholder: "Опиши текстовую задачу — промт-инженер соберёт готовый промт…",
    send: "Сделать промт",
    empty: "Опиши задачу словами: что должен сделать ИИ, на входе и на выходе, чего нельзя делать. Промт-инженер отдаст готовый промт в блоке кода, следующим сообщением его можно доработать.",
  },
  decks: {
    title: "Презентации",
    icon: "📊",
    placeholder: "Опиши презентацию — архитектор соберёт слайды и .pptx. Следующим сообщением можно попросить доработать…",
    send: "Собрать презентацию",
    empty: "Опиши, о чём презентация и для кого. Архитектор придумает слайды с заголовками и пунктами, сервер соберёт .pptx — его можно скачать, а следующим сообщением попросить доработать.",
  },
  video: {
    title: "Видео",
    icon: "🎬",
    placeholder: "Видео ещё не подключено",
    send: "Создать",
    empty: "Видео ещё не подключено.",
  },
};

const STUDIO_GROUPS = [
  { kind: "images", title: "Картинки", icon: "🖼" },
  { kind: "docs", title: "Документы", icon: "📄" },
  { kind: "specs", title: "Спеки", icon: "📐" },
  { kind: "prompts", title: "Промты", icon: "✎" },
  { kind: "decks", title: "Презентации", icon: "📊", onlyIfChats: true },
  { kind: "video", title: "Видео", icon: "🎬", onlyIfChats: true },
];

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* приватный режим — обойдёмся без запоминания */
  }
}

function libViewValue(raw) {
  return LIB_VIEWS.some(([v]) => v === raw) ? raw : "all";
}

function canWrite() {
  return S.role === "admin" || S.role === "editor";
}

function initLibraryUi() {
  S.studio.view = libViewValue(readLocal(STUDIO_VIEW_KEY, "all"));
  S.gallery.view = libViewValue(readLocal(GALLERY_VIEW_KEY, "all"));
  const collapsed = readLocal(STUDIO_GROUP_KEY, {});
  S.studio.collapsed = collapsed && typeof collapsed === "object" ? collapsed : {};
}

function libViewSwitch(active, onChange, compact = false) {
  const row = el("div", "libViews");
  for (const [value, icon, label] of LIB_VIEWS) {
    const b = el("button", "libView" + (active === value ? " active" : ""), compact && value !== "all" ? icon : `${icon} ${label}`);
    b.type = "button";
    b.title = label;
    b.dataset.view = value;
    b.addEventListener("click", () => onChange(value));
    row.append(b);
  }
  return row;
}

function toggleStudioGroup(kind) {
  S.studio.collapsed = { ...(S.studio.collapsed ?? {}), [kind]: !S.studio.collapsed?.[kind] };
  writeLocal(STUDIO_GROUP_KEY, S.studio.collapsed);
  renderList();
}

function kindMeta(kind) {
  return STUDIO_KIND_META[kind] ?? { title: kind, icon: "•", placeholder: "", send: "Отправить", empty: "Пустой чат." };
}

function dateShort(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/** После любой пометки библиотеки перезагружаем то, что видно на экране. */
async function refreshAfterLibrary() {
  if (S.page === "studio") await reloadStudioSessions();
  if (S.page === "gallery") await loadGallery();
}

async function markLibrary(ref, patch) {
  try {
    await api("/api/library/mark", { method: "POST", body: JSON.stringify({ ref, ...patch }) });
    await refreshAfterLibrary();
  } catch (err) {
    alert(err.message);
  }
}

async function trashLibrary(ref, label = "элемент") {
  if (!confirm(`Переместить ${label} в корзину? Восстановить можно будет из раздела «Корзина».`)) return;
  try {
    await api("/api/library/trash", { method: "POST", body: JSON.stringify({ ref }) });
    await refreshAfterLibrary();
  } catch (err) {
    alert(err.message);
  }
}

async function restoreLibrary(ref) {
  try {
    await api("/api/library/restore", { method: "POST", body: JSON.stringify({ ref }) });
    await refreshAfterLibrary();
  } catch (err) {
    alert(err.message);
  }
}

async function purgeLibrary(ref, label = "элемент") {
  if (!confirm(`Удалить ${label} навсегда? Файлы и переписка будут удалены физически, отменить нельзя.`)) return;
  try {
    await api("/api/library/purge", { method: "DELETE", body: JSON.stringify({ ref }) });
    await refreshAfterLibrary();
  } catch (err) {
    alert(err.message);
  }
}

function starButton(ref, fav) {
  const b = el("button", "star" + (fav ? " on" : ""), fav ? "★" : "☆");
  b.type = "button";
  b.title = fav ? "Убрать из избранного" : "В избранное";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    markLibrary(ref, { fav: !fav });
  });
  return b;
}

/** Кнопка «⋯» с меню: архив/корзина. */
function libraryMenu(ref, { archived = false, deleted = false } = {}) {
  const wrap = el("div", "menuWrap");
  const btn = el("button", "menuBtn", "⋯");
  btn.type = "button";
  btn.title = "Ещё: архив и корзина";
  const menu = el("div", "itemMenu hidden");
  const add = (label, fn, cls = "mini") => {
    const b = el("button", cls, label);
    b.type = "button";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.add("hidden");
      fn();
    });
    menu.append(b);
  };
  add(archived ? "вернуть из архива" : "в архив", () => markLibrary(ref, { archived: !archived }));
  if (!deleted) add("в корзину", () => trashLibrary(ref), "mini danger");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  wrap.append(btn, menu);
  return wrap;
}

const api = async (path, opts = {}) => {
  const method = String(opts.method ?? "GET").toUpperCase();
  if (S.role === "viewer" && !["GET", "HEAD"].includes(method)) {
    throw new Error("Роль viewer: только чтение");
  }
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin("Нужен вход — сессия истекла или её ещё нет.");
    const err = new Error(data.error || "нужен вход");
    err.status = 401;
    err.data = data;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

/* ------------------------------- авторизация ------------------------------- */

function showLogin(message = "") {
  S.authDead = true;
  closeStream();
  closeGlobalStream();
  document.body.classList.remove("booting");
  document.body.classList.add("auth-locked");
  const screen = $("#loginScreen");
  if (!screen) return;
  screen.classList.remove("hidden");
  const err = $("#loginError");
  if (err) {
    err.textContent = message;
    err.classList.toggle("hidden", !message);
  }
  $("#userBadge")?.classList.add("hidden");
  setTimeout(() => $("#loginLogin")?.focus(), 40);
}

function applyRole(me) {
  S.user = me?.login ? me : null;
  S.role = me?.role ?? "viewer";
  S.authDead = false;
  document.body.dataset.role = S.role;
  for (const role of ["viewer", "editor", "admin"]) {
    document.body.classList.toggle(`role-${role}`, S.role === role);
  }
  $("#userBadge")?.classList.remove("hidden");
  const login = $("#userLogin");
  const role = $("#userRole");
  if (login) login.textContent = me?.login ?? "";
  if (role) role.textContent = ({ viewer: "только чтение", editor: "редактор", admin: "админ" })[S.role] ?? S.role;
}

async function submitLogin(event) {
  event?.preventDefault();
  const button = $("#loginSubmit");
  const loginInput = $("#loginLogin");
  const passInput = $("#loginPassword");
  const err = $("#loginError");
  const login = loginInput.value.trim();
  const password = passInput.value;
  button.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = data.error || `HTTP ${res.status}`;
      err.classList.remove("hidden");
      passInput.select();
      return;
    }
    // cookie уже стоит — начинаем с чистого состояния
    window.location.reload();
  } catch (e) {
    err.textContent = "Сервер не ответил: " + e.message;
    err.classList.remove("hidden");
  } finally {
    button.disabled = false;
  }
}

async function submitLogout() {
  try {
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" } });
  } catch {
    /* всё равно перезагружаемся — cookie могла уже истечь */
  }
  window.location.reload();
}

const hhmmss = (iso) => (iso ? new Date(iso) : new Date()).toTimeString().slice(0, 8);
const statusLabel = (s) =>
  ({ running: "идёт", awaiting: "ждёт", awaiting_plan: "нужен план", paused: "на паузе", done: "готов", failed: "ошибка", cancelled: "стоп", interrupted: "прерван" }[s] || s);

/* ------------------------------- boot ------------------------------- */

async function boot() {
  try {
    const me = await api("/api/me");
    applyRole(me);
    initLibraryUi();
    const st = await api("/api/state");
    S.mode = st.mode;
    S.agentsFile = st.agents;
    S.pipelineFile = st.pipeline;
    S.agents = st.agents.agents;
    S.stages = st.pipeline.stages.filter((s) => s.enabled !== false);
    S.projects = st.projects ?? [];
    renderMode(st);
    document.body.classList.remove("booting");
    document.body.classList.remove("auth-locked");
    $("#loginScreen")?.classList.add("hidden");
    setPage("projects");
    connectGlobalStream();
    if (S.projects[0]) await selectProject(S.projects[0].id);
    else newProjectMode();
    pollTasks();
    pollLogs();
    pollCorner();
    setInterval(pollTasks, 4000);
    setInterval(pollLogs, 6000);
    setInterval(pollCorner, 20000);
  } catch (err) {
    if (err.status === 401) return; // форма входа уже показана в api()
    document.body.classList.remove("booting");
    $("#runStatus").textContent = "ошибка загрузки: " + err.message;
  }
}

function renderMode(st) {
  const live = st.mode === "live";
  const b = $("#modeBadge");
  b.textContent = live ? "LIVE · OpenRouter" : "MOCK · без ключа";
  b.className = "badge " + (live ? "live" : "mock");
}

/* ------------------------------- pages ------------------------------- */

function setPage(page) {
  S.page = page;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("#pageProjects").classList.toggle("hidden", page !== "projects");
  $("#pageAgents").classList.toggle("hidden", page !== "agents");
  $("#pageStats").classList.toggle("hidden", page !== "stats");
  $("#pageStudio").classList.toggle("hidden", page !== "studio");
  $("#pageGallery").classList.toggle("hidden", page !== "gallery");
  $("#pageKeys").classList.toggle("hidden", page !== "keys");
  $("#pageSearch").classList.toggle("hidden", page !== "search");
  $("#pageAssistant").classList.toggle("hidden", page !== "assistant");
  renderList();
  if (page === "stats") loadStats();
  if (page === "studio") loadStudio();
  if (page === "gallery") loadGallery();
  if (page === "keys") loadKeys();
  if (page === "search") setTimeout(() => $("#searchInput")?.focus(), 50);
  if (page === "assistant") {
    renderChat();
    setAssistTab("chat");
    setTimeout(() => $("#askInput")?.focus(), 50);
  }
}

function renderList() {
  const box = $("#list");
  box.textContent = "";
  if (S.page === "projects") {
    const head = el("div", "listHead");
    head.append(el("span", null, "Проекты"));
    const broom = el("button", "mini", "🧹");
    broom.title = "Убрать с диска прогоны, не привязанные к проектам";
    broom.addEventListener("click", cleanupDisk);
    const broken = el("button", "mini", "битые");
    broken.title = "Очистить несуществующие проекты: без живых прогонов на диске";
    broken.dataset.write = "";
    broken.addEventListener("click", cleanMissingProjects);
    const add = el("button", "mini", "+");
    add.title = "Новый проект";
    add.addEventListener("click", newProjectMode);
    head.append(broom, broken, add);
    box.append(head);

    if (!S.projects.length) box.append(el("div", "empty", "пока нет проектов"));
    for (const p of S.projects) {
      const last = p.runs?.[0];
      const item = el("div", "item" + (S.project?.id === p.id ? " active" : ""));
      const txt = el("div", "txt");
      const n = el("div", "n");
      n.append(dot(last?.status), el("span", null, p.name));
      if (p.paused) n.append(el("span", "tag pausedTag", "пауза"));
      txt.append(n, el("div", "m", `${p.runs?.length ?? 0} верс. · ${statusLabel(last?.status ?? "—")}`));
      const kill = el("button", "kill projectKill", "✕");
      kill.title = "Удалить проект";
      kill.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteProject(p);
      });
      item.append(txt, kill);
      item.addEventListener("click", () => selectProject(p.id));
      box.append(item);
    }
    return;
  }

  if (S.page === "agents") {
    const head = el("div", "listHead");
    head.append(el("span", null, "Агенты"));
    const add = el("button", "mini", "+");
    add.title = "Добавить агента";
    add.addEventListener("click", addAgent);
    head.append(add);
    box.append(head);

    for (const a of S.agents) {
      const item = el("div", "item" + (S.editingAgent?.id === a.id ? " active" : ""));
      const txt = el("div", "txt");
      const n = el("div", "n");
      n.append(el("span", null, a.name));
      if (a.kind === "external") n.append(el("span", "tag", "чат"));
      txt.append(n, el("div", "m", a.model || "—"));
      const kill = el("button", "kill", "✕");
      kill.title = "Удалить агента";
      kill.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteAgent(a);
      });
      item.append(txt, kill);
      item.addEventListener("click", () => selectAgent(a.id));
      box.append(item);
    }
    return;
  }

  if (S.page === "studio") {
    const head = el("div", "listHead");
    head.append(el("span", null, "Студия"));
    const addDeck = el("button", "mini", "📊");
    addDeck.title = "Новый чат презентаций";
    addDeck.disabled = !canWrite();
    addDeck.addEventListener("click", () => createSession("decks"));
    head.append(addDeck);
    const addVideo = el("button", "mini", "🎬");
    addVideo.title = "Новый чат видео (пока не подключено)";
    addVideo.disabled = !canWrite();
    addVideo.addEventListener("click", () => createSession("video"));
    head.append(addVideo);
    box.append(head);

    box.append(libViewSwitch(S.studio.view, setStudioView, false));

    const sessions = S.studio.sessions ?? [];
    const known = new Set();
    for (const group of STUDIO_GROUPS) {
      const chats = sessions.filter((s) => (s.kind ?? "images") === group.kind);
      if (group.onlyIfChats && !chats.length) continue;
      known.add(group.kind);
      box.append(renderStudioGroup(group, chats));
    }
    const other = sessions.filter((s) => !known.has(s.kind ?? "images"));
    if (other.length) box.append(renderStudioGroup({ kind: "other", title: "Другое", icon: "•" }, other));
    return;
  }

  if (S.page === "gallery") {
    const head = el("div", "listHead");
    head.append(el("span", null, "Галерея"));
    const again = el("button", "mini", "⟳");
    again.title = "Обновить список картинок";
    again.addEventListener("click", () => loadGallery());
    head.append(again);
    box.append(head);
    box.append(libViewSwitch(S.gallery.view, setGalleryView, false));
    const viewLabel = LIB_VIEWS.find(([v]) => v === S.gallery.view)?.[2] ?? "Все";
    const item = el("div", "item active");
    const txt = el("div", "txt");
    txt.append(
      el("div", "n", viewLabel),
      el("div", "m", `${S.gallery.total} шт. · $${Number(S.gallery.cost || 0).toFixed(3)}`)
    );
    item.append(txt);
    box.append(item);
    box.append(el("div", "empty", canWrite() ? "Звёздочка — в избранное, меню — в архив или корзину." : "Роль viewer: только просмотр."));
    return;
  }

  if (S.page === "stats") {
    const head = el("div", "listHead");
    head.append(el("span", null, "Разделы"));
    box.append(head);
    for (const [label, anchor] of [["Расход", "statsCost"], ["Снимки", "statsSnapshots"], ["Модели", "statsModels"], ["Проекты", "statsProjects"], ["Агенты", "statsAgents"], ["Дни", "statsDays"]]) {
      const item = el("div", "item");
      const txt = el("div", "txt");
      txt.append(el("div", "n", label), el("div", "m", "перейти"));
      item.append(txt);
      item.addEventListener("click", () => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }));
      box.append(item);
    }
    return;
  }
}

function renderStudioGroup(group, chats) {
  const collapsed = Boolean(S.studio.collapsed?.[group.kind]);
  const wrap = el("div", "studioGroup");
  const head = el("div", "groupHead");
  head.append(
    el("span", "groupCaret", collapsed ? "▸" : "▾"),
    el("span", "groupTitle", `${group.icon ?? ""} ${group.title}`.trim()),
    el("span", "groupCount", String(chats.length))
  );
  const add = el("button", "mini groupAdd", "+");
  add.type = "button";
  add.title = `Новый чат: ${String(group.title).toLowerCase()}`;
  add.disabled = !canWrite();
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    createSession(group.kind);
  });
  head.append(add);
  head.title = collapsed ? "Развернуть группу" : "Свернуть группу";
  head.addEventListener("click", () => toggleStudioGroup(group.kind));
  wrap.append(head);

  if (!collapsed) {
    const body = el("div", "groupBody");
    if (!chats.length) body.append(el("div", "empty groupEmpty", "пока нет чатов"));
    for (const s of chats) body.append(studioSessionItem(s));
    wrap.append(body);
  }
  return wrap;
}

function studioSessionItem(s) {
  const wrap = el("div", "itemWrap");
  const item = el("div", "item" + (s.id === S.studio.activeId ? " active" : ""));
  const txt = el("div", "txt");
  const n = el("div", "n");
  n.append(el("span", null, s.name));
  if (s.archived) n.append(el("span", "tag", "архив"));
  txt.append(n);
  const meta = el("div", "m", `${kindMeta(s.kind).title.toLowerCase()} · сообщений: ${s.messages ?? 0}`);
  if (s.deletedAt) meta.append(el("span", "libDeleted", ` · удалён ${dateShort(s.deletedAt)}`));
  txt.append(meta);
  item.append(txt);

  if (s.deletedAt) {
    item.append(el("span", "deletedMark", "🗑"));
  } else {
    if (canWrite()) item.append(starButton(s.ref, Boolean(s.fav)));
    if (canWrite()) item.append(libraryMenu(s.ref, { archived: Boolean(s.archived) }));
  }

  item.addEventListener("click", () => switchSession(s.id));
  item.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (canWrite()) renameSession(s);
  });
  wrap.append(item);

  if (s.deletedAt && canWrite()) {
    const acts = el("div", "itemActions");
    acts.append(smallBtn("восстановить", "Вернуть чат из корзины", () => restoreLibrary(s.ref)));
    acts.append(smallBtn("удалить навсегда", "Удалить чат и переписку физически", () => purgeLibrary(s.ref, `чат «${s.name}»`), "mini danger"));
    wrap.append(acts);
  }
  return wrap;
}

/* ------------------------------ картинки ------------------------------ */

// подсказки по моделям: цена / качество / скорость. Итоговый выбор всегда за пользователем.
const MODEL_TIPS = {
  price: ["bytedance-seed/seedream-5-0-flash", "google/gemini-3.1-flash-lite-image", "qwen/qwen-image-2.1-turbo", "black-forest-labs/flux-3-image-klein"],
  quality: ["openai/gpt-image-2", "black-forest-labs/flux-3-image", "google/gemini-3-pro-image", "bytedance-seed/seedream-5-0-pro"],
  speed: ["google/gemini-3.1-flash-image", "bytedance-seed/seedream-5-0-flash", "qwen/qwen-image-2.1-turbo"],
  note: {
    price: "эти модели дешевле — примерно $0.01–0.03 за картинку",
    quality: "дороже (до $0.13), но детальнее и лучше держат текст",
    speed: "быстрые: 5–10 секунд на картинку",
  },
};

async function loadStudio() {
  if (!S.studio.models.length) {
    try {
      const { models } = await api("/api/images/models");
      S.studio.models = models ?? [];
      const sel = $("#imgModel");
      sel.textContent = "";
      for (const m of S.studio.models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name;
        sel.append(opt);
      }
      const preferred = ["google/gemini-3.1-flash-image", "black-forest-labs/flux-3-image-klein", "bytedance-seed/seedream-5-0-flash"];
      const pick = preferred.find((id) => S.studio.models.some((m) => m.id === id)) ?? S.studio.models[0]?.id;
      if (pick) sel.value = pick;
      try {
        const { image } = await api("/api/prices");
        S.studio.prices = image ?? {};
        for (const opt of sel.options) {
          const p = S.studio.prices[opt.value];
          if (p) opt.textContent = `${opt.textContent} · ~$${p.toFixed(2)}`;
        }
      } catch {
        /* без цен */
      }
    } catch {
      /* без списка моделей */
    }
  }
  try {
    const { sessions, activeId } = await api(`/api/studio/sessions?view=${encodeURIComponent(S.studio.view)}`);
    S.studio.sessions = sessions ?? [];
    const keep = S.studio.activeId && S.studio.sessions.some((s) => s.id === S.studio.activeId);
    S.studio.activeId = keep ? S.studio.activeId : activeId ?? S.studio.sessions[0]?.id ?? null;
    await loadThread();
    renderList();
    updateStudioChrome();
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
}

async function reloadStudioSessions() {
  try {
    const { sessions, activeId } = await api(`/api/studio/sessions?view=${encodeURIComponent(S.studio.view)}`);
    S.studio.sessions = sessions ?? [];
    const keep = S.studio.activeId && S.studio.sessions.some((s) => s.id === S.studio.activeId);
    S.studio.activeId = keep ? S.studio.activeId : activeId ?? S.studio.sessions[0]?.id ?? null;
    renderList();
    await loadThread();
    updateStudioChrome();
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
}

async function setStudioView(view) {
  S.studio.view = libViewValue(view);
  writeLocal(STUDIO_VIEW_KEY, S.studio.view);
  await reloadStudioSessions();
}

async function loadThread() {
  const sid = S.studio.activeId;
  if (!sid) {
    S.studio.thread = [];
    renderThread();
    return;
  }
  const { thread } = await api(`/api/studio/thread?session=${encodeURIComponent(sid)}`);
  if (S.studio.activeId !== sid) return; // успели переключиться — чужой ответ не применяем
  S.studio.thread = thread ?? [];
  renderThread();
}

function updateStudioChrome() {
  const sess = S.studio.sessions.find((s) => s.id === S.studio.activeId);
  const kind = sess?.kind ?? "images";
  const isImages = kind === "images";
  const meta = kindMeta(kind);
  $("#imgPrompt").placeholder = meta.placeholder;
  $("#imgSend").textContent = meta.send;
  const directLabel = $("#imgDirect")?.closest("label");
  if (directLabel) directLabel.style.display = isImages ? "" : "none";
  const attach = $("#imgFile")?.closest("label");
  if (attach) attach.style.display = isImages ? "" : "none";
  for (const sel of ["#imgModel", "#imgAspect", "#imgQuality"]) {
    const node = $(sel);
    if (node) node.style.display = isImages ? "" : "none";
  }
}

function switchSession(id) {
  S.studio.activeId = id;
  S.studio.refItem = null;
  S.studio.refData = null;
  renderChip();
  updateStudioChrome();
  renderList();
  loadThread().catch((err) => ($("#studioInfo").textContent = err.message));
}

async function newSession() {
  await createSession("images");
}

async function createSession(kind) {
  // видео пока не подключено: не спрашиваем имя, а сразу показываем ответ сервера
  if (kind === "video") {
    try {
      await api("/api/studio/sessions", { method: "POST", body: JSON.stringify({ name: "Видео", kind }) });
    } catch (err) {
      const info = $("#studioInfo");
      if (info) info.textContent = err.message;
      else alert(err.message);
    }
    return;
  }
  const titles = {
    images: ["Название чата картинок", "Новый чат"],
    docs: ["Название чата документов", "Документы"],
    specs: ["Название чата спек", "Новая спека"],
    prompts: ["Название чата промтов", "Новые промты"],
    decks: ["Название чата презентаций", "Презентация"],
  };
  const [title, fallback] = titles[kind] ?? ["Название чата", "Новый чат"];
  const name = prompt(title, fallback);
  if (name == null) return;
  try {
    const j = await api("/api/studio/sessions", { method: "POST", body: JSON.stringify({ name, kind }) });
    S.studio.view = "all";
    writeLocal(STUDIO_VIEW_KEY, "all");
    S.studio.sessions = j.sessions ?? [];
    S.studio.activeId = j.activeId;
    renderList();
    await loadThread();
    updateStudioChrome();
  } catch (err) {
    const info = $("#studioInfo");
    if (info) info.textContent = err.message;
    else alert(err.message);
  }
}

async function renameSession(s) {
  const name = prompt("Новое название чата", s.name);
  if (name == null) return;
  try {
    await api(`/api/studio/sessions/${s.id}`, { method: "POST", body: JSON.stringify({ name }) });
    await reloadStudioSessions();
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
}

/** Старое «удалить» теперь тоже мягкое: чат уезжает в корзину. */
async function removeSession(s) {
  await trashLibrary(s.ref ?? `chat:${s.id}`, `чат «${s.name}»`);
}

function lastResultId() {
  for (let i = S.studio.thread.length - 1; i >= 0; i--) {
    if (S.studio.thread[i].role === "result") return S.studio.thread[i].imageId;
  }
  return null;
}

function renderThread() {
  const box = $("#studioFeed");
  box.textContent = "";
  const sess = S.studio.sessions.find((s) => s.id === S.studio.activeId);
  const kind = sess?.kind ?? "images";
  const meta = kindMeta(kind);
  updateStudioChrome();

  if (kind === "video") {
    box.append(el("div", "empty", "Видео ещё не подключено — создай чат другого типа."));
    return;
  }

  if (!S.studio.thread.length) {
    box.append(el("div", "empty", meta.empty));
    $("#studioInfo").textContent = "";
    return;
  }

  const results = S.studio.thread.filter((m) => m.role === "result" || m.role === "doc" || m.role === "prompt" || m.role === "deck");
  const spent = results.reduce((s, m) => s + (m.cost || 0), 0);
  const noun = kind === "images" ? "картинок" : kind === "prompts" ? "промтов" : kind === "decks" ? "презентаций" : "документов";
  $("#studioInfo").textContent = `${noun}: ${results.length} · потрачено $${spent.toFixed(3)}`;

  for (const msg of S.studio.thread) {
    if (msg.role === "user") box.append(userBubble(msg));
    else if (msg.role === "proposal" && kind === "images") box.append(proposalCard(msg));
    else if (msg.role === "result") box.append(resultCard(msg));
    else if (msg.role === "doc") box.append(docCard(msg));
    else if (msg.role === "prompt") box.append(promptCard(msg));
    else if (msg.role === "deck") box.append(deckCard(msg));
  }
  box.scrollTop = box.scrollHeight;
}

/** Инлайн-правка карточки: markdown спеки/документа или текста промта. */
function inlineEditor(card, value, onSave, rows = 10) {
  const existing = card.querySelector(".inlineEdit");
  if (existing) {
    existing.querySelector("textarea")?.focus();
    return existing;
  }
  const wrap = el("div", "inlineEdit");
  const ta = el("textarea", "pText");
  ta.value = value;
  ta.rows = rows;
  const row = el("div", "pRow");
  const save = el("button", "primary", "Сохранить");
  const cancel = el("button", "mini", "отмена");
  cancel.addEventListener("click", () => wrap.remove());
  save.addEventListener("click", async () => {
    const text = ta.value.trim();
    if (text.length < 2) {
      ta.focus();
      return;
    }
    save.disabled = true;
    try {
      await onSave(text);
      wrap.remove();
    } catch (err) {
      alert(err.message);
      save.disabled = false;
    }
  });
  row.append(save, cancel);
  wrap.append(ta, row);
  card.append(wrap);
  ta.focus();
  return wrap;
}

async function patchStudioMessage(msg, patch) {
  const data = await api("/api/studio/message/patch", {
    method: "POST",
    body: JSON.stringify({ id: msg.id, sessionId: S.studio.activeId, ...patch }),
  });
  if (data.thread) {
    S.studio.thread = data.thread;
    renderThread();
  }
  return data;
}

function docCard(msg) {
  const card = el("div", "docCard");
  const head = el("div", "docHead");
  head.append(el("b", null, msg.title || (msg.spec ? "Спека" : "Документ")));
  head.append(el("span", "tag", msg.spec ? "спека" : msg.mode === "correct" ? "корректор" : "помощник"));
  if (msg.mock) head.append(el("span", "tag mockTag", "MOCK"));
  card.append(head);

  if (msg.reasoning) {
    const d = document.createElement("details");
    d.className = "reasoning";
    const s = document.createElement("summary");
    s.textContent = msg.spec ? "что уточнил архитектор" : "что сделал редактор";
    d.append(s, el("div", "why", msg.reasoning));
    card.append(d);
  }

  const preview = el("div", "docPreview");
  preview.innerHTML = markdown(msg.markdown || "");
  card.append(preview);

  const meta = el("div", "meta");
  meta.append(
    el("span", null, `$${(msg.cost || 0).toFixed(4)}`),
    el("span", null, `${((msg.ms || 0) / 1000).toFixed(1)} с`),
    el("span", null, msg.at ? new Date(msg.at).toLocaleString("ru-RU") : "")
  );
  card.append(meta);

  const md = document.createElement("a");
  md.className = "mini link";
  md.textContent = "скачать .md";
  md.href = `/api/studio/doc/${msg.id}.md`;
  md.download = "";

  const docx = document.createElement("a");
  docx.className = "mini link";
  docx.textContent = "скачать .docx";
  docx.href = `/api/studio/doc/${msg.id}.docx`;
  docx.download = "";

  const edit = smallBtn("править", "Отредактировать markdown вручную", () => {
    inlineEditor(card, String(msg.markdown ?? ""), (value) => patchStudioMessage(msg, { markdown: value }));
  });

  card.append(actionsRow([edit, smallBtn("удалить", "Убрать документ и всё после него", () => truncateAt(msg)), md, docx]));
  return card;
}

function promptCard(msg) {
  const card = el("div", "docCard promptCard");
  const head = el("div", "docHead");
  head.append(el("b", null, msg.title || "Промт"));
  head.append(el("span", "tag", "промт"));
  if (msg.mock) head.append(el("span", "tag mockTag", "MOCK"));
  card.append(head);

  if (msg.reasoning) {
    const d = document.createElement("details");
    d.className = "reasoning";
    const s = document.createElement("summary");
    s.textContent = "как понял задачу";
    d.append(s, el("div", "why", msg.reasoning));
    card.append(d);
  }

  const pre = el("pre", "codeBlock");
  pre.append(el("code", null, String(msg.text ?? "")));
  card.append(pre);

  if (Array.isArray(msg.questions) && msg.questions.length) {
    const d = document.createElement("details");
    d.className = "reasoning";
    d.append(el("summary", null, "уточняющие вопросы"), el("div", "why", msg.questions.map((q) => `• ${q}`).join("\n")));
    card.append(d);
  }

  const meta = el("div", "meta");
  meta.append(
    el("span", null, msg.model || "artist"),
    el("span", null, `$${(msg.cost || 0).toFixed(4)}`),
    el("span", null, `${((msg.ms || 0) / 1000).toFixed(1)} с`),
    el("span", null, msg.at ? new Date(msg.at).toLocaleString("ru-RU") : "")
  );
  card.append(meta);

  const copy = smallBtn("копировать", "Скопировать промт в буфер обмена", async () => {
    try {
      await navigator.clipboard.writeText(String(msg.text ?? ""));
      copy.textContent = "скопировано";
      setTimeout(() => (copy.textContent = "копировать"), 1600);
    } catch {
      copy.textContent = "не скопировалось";
    }
  });
  const refine = smallBtn("доработать", "Следующим сообщением попросите поправить промт", () => {
    const input = $("#imgPrompt");
    input.value = "";
    input.placeholder = "Что поправить в промте? Например: «сделай короче и добавь формат ответа»";
    input.focus();
  });
  const edit = smallBtn("править", "Отредактировать текст промта вручную", () => {
    inlineEditor(card, String(msg.text ?? ""), (value) => patchStudioMessage(msg, { text: value }), 8);
  });

  card.append(actionsRow([copy, refine, edit, smallBtn("удалить", "Убрать промт и всё после него", () => truncateAt(msg))]));
  return card;
}

/** Карточка презентации: заголовок, слайды с маркерами, файл, правка и удаление. */
function deckCard(msg) {
  const card = el("div", "docCard deckCard");
  const slides = Array.isArray(msg.slides) ? msg.slides : [];
  const head = el("div", "docHead");
  head.append(el("b", null, msg.title || "Презентация"));
  head.append(el("span", "tag", `слайдов: ${slides.length}`));
  if (msg.mock) head.append(el("span", "tag mockTag", "MOCK"));
  card.append(head);

  const list = el("div", "deckSlides");
  slides.forEach((slide, i) => {
    const item = el("div", "deckSlide");
    item.append(el("div", "deckSlideTitle", `${i + 1}. ${slide?.title || "Слайд"}`));
    const bullets = Array.isArray(slide?.bullets) ? slide.bullets : [];
    if (bullets.length) {
      const ul = el("ul", "deckBullets");
      for (const bullet of bullets) ul.append(el("li", null, String(bullet)));
      item.append(ul);
    } else {
      item.append(el("div", "dim", "без пунктов"));
    }
    if (slide?.notes) {
      const d = document.createElement("details");
      d.className = "reasoning";
      d.append(el("summary", null, "заметки"), el("div", "why", String(slide.notes)));
      item.append(d);
    }
    list.append(item);
  });
  card.append(list);

  const meta = el("div", "meta");
  meta.append(
    el("span", null, msg.model || "architect"),
    el("span", null, `$${(msg.cost || 0).toFixed(4)}`),
    el("span", null, `${((msg.ms || 0) / 1000).toFixed(1)} с`),
    el("span", null, msg.size ? `${(msg.size / 1024).toFixed(1)} КБ` : ""),
    el("span", null, msg.at ? new Date(msg.at).toLocaleString("ru-RU") : "")
  );
  card.append(meta);

  const download = document.createElement("a");
  download.className = "mini link";
  download.textContent = "скачать .pptx";
  download.href = `/api/studio/deck/${msg.id}.pptx`;
  download.download = "";

  const edit = smallBtn("править", "Следующим сообщением попросите поправить презентацию", () => {
    const input = $("#imgPrompt");
    input.value = "";
    input.placeholder = "Что поправить в презентации? Например: «добавь слайд про бюджет»";
    input.focus();
  });

  card.append(actionsRow([download, edit, smallBtn("удалить", "Убрать презентацию и всё после неё", () => truncateAt(msg))]));
  return card;
}


/* общая обёртка для вызовов студии, чтобы не дублировать обновление треда */
async function studioCall(path, body) {
  const sid = S.studio.activeId;
  const payload = { ...(body ?? {}), sessionId: sid };
  try {
    const data = await api(path, { method: "POST", body: JSON.stringify(payload) });
    if (data.thread && S.studio.activeId === sid) {
      S.studio.thread = data.thread;
      renderThread();
    }
    return data;
  } catch (err) {
    // сервер вернул тред вместе с ошибкой — показываем сохранённое сообщение, чтобы не было «невидимых»
    if (err.data?.thread && S.studio.activeId === sid) {
      S.studio.thread = err.data.thread;
      renderThread();
    }
    throw err;
  }
}

function actionsRow(buttons) {
  const row = el("div", "msgActions");
  for (const b of buttons) if (b) row.append(b);
  return row;
}

function smallBtn(label, title, onClick, cls = "mini") {
  const b = el("button", cls, label);
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function textBefore(msg) {
  const idx = S.studio.thread.indexOf(msg);
  for (let i = idx - 1; i >= 0; i--) if (S.studio.thread[i].role === "user") return S.studio.thread[i].text;
  return "";
}

function userBubble(msg) {
  const wrap = el("div", "bubbleWrap");
  const b = el("div", "bubble user", msg.text);
  wrap.append(b);

  const actions = actionsRow([
    smallBtn("изменить", "Отредактировать и переписать промт", () => editUserMessage(msg, wrap)),
    smallBtn("удалить ниже", "Откатиться: убрать это сообщение и всё после него", () => truncateAt(msg)),
  ]);
  wrap.append(actions);
  return wrap;
}

function editUserMessage(msg, wrap) {
  wrap.textContent = "";
  const ta = el("textarea", "pText");
  ta.value = msg.text;
  ta.rows = 3;
  const row = el("div", "pRow");
  const save = el("button", "primary", "Сохранить и переписать");
  const cancel = el("button", "mini", "отмена");
  cancel.addEventListener("click", () => renderThread());
  save.addEventListener("click", async () => {
    const text = ta.value.trim();
    if (text.length < 2) return ta.focus();
    const idx = S.studio.thread.indexOf(msg);
    const after = idx >= 0 ? S.studio.thread.length - idx - 1 : 0;
    if (after > 0 && !confirm(`После этого сообщения будет удалено ${after} — они пропадут из чата. Продолжить?`)) return;
    save.disabled = true;
    try {
      const sess = S.studio.sessions.find((s) => s.id === S.studio.activeId);
      const kind = sess?.kind ?? "images";
      await studioCall("/api/studio/edit", { id: msg.id, text });
      if (kind === "docs") await studioCall("/api/studio/doc", { text });
      else if (kind === "specs") await studioCall("/api/studio/spec", { text });
      else if (kind === "prompts") await studioCall("/api/studio/prompt", { text });
      else if (kind === "decks") await studioCall("/api/studio/deck", { text });
      else await studioCall("/api/studio/propose", { text });
    } catch (err) {
      $("#studioInfo").textContent = err.message;
      save.disabled = false;
    }
  });
  row.append(save, cancel);
  wrap.append(ta, row);
  ta.focus();
}

async function truncateAt(msg) {
  if (!confirm("Удалить это сообщение и всё, что после него? Картинки останутся в файлах.")) return;
  try {
    await studioCall("/api/studio/truncate", { id: msg.id });
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
}

function proposalCard(msg) {
  const card = el("div", "proposal");

  if (msg.reasoning || msg.why) {
    const d = document.createElement("details");
    d.className = "reasoning";
    const s = document.createElement("summary");
    s.textContent = "размышления художника";
    d.append(s);
    if (msg.why) d.append(el("div", "why", msg.why));
    if (msg.reasoning) d.append(el("div", "why", msg.reasoning));
    const spend = el("div", "meta");
    spend.append(el("span", null, `$ ${(msg.cost || 0).toFixed(4)}`), el("span", null, `${((msg.ms || 0) / 1000).toFixed(1)} с`));
    d.append(spend);
    card.append(d);
  }

  const ta = el("textarea", "pText");
  ta.value = msg.prompt;
  ta.rows = 4;
  card.append(ta);

  const row = el("div", "pRow");
  const model = document.createElement("select");
  model.className = "miniSelect";
  for (const m of S.studio.models) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.name;
    model.append(o);
  }
  model.value = msg.model;

  const aspect = document.createElement("select");
  aspect.className = "miniSelect";
  for (const a of ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2"]) {
    const o = document.createElement("option");
    o.value = a;
    o.textContent = a;
    aspect.append(o);
  }
  aspect.value = msg.aspectRatio ?? "1:1";
  row.append(model, aspect);

  // цена выбранной модели — обновляется при смене
  const est = el("span", "dim");
  const updateEst = () => {
    const p = S.studio.prices?.[model.value];
    est.textContent = p ? `≈ $${p.toFixed(2)}` : "цена неизвестна";
  };
  model.addEventListener("change", updateEst);
  row.append(est);
  setTimeout(updateEst, 0);

  const refId = msg.ref ?? lastResultId();
  let refBox = null;
  if (refId) {
    const lab = el("label", "chk");
    refBox = document.createElement("input");
    refBox.type = "checkbox";
    refBox.checked = true;
    lab.append(refBox, el("span", null, "править прошлую картинку"));
    row.append(lab);
  }

  const go = el("button", "primary", "Отправить");
  go.addEventListener("click", () =>
    submitProposal(msg, { prompt: ta.value.trim(), model: model.value, aspectRatio: aspect.value, referenceId: refBox?.checked ? refId : null }, go)
  );
  row.append(go);
  card.append(row);

  // подсказки: какая модель лучше по цене / качеству / скорости — выбор остаётся за тобой
  const tips = el("div", "pRow");
  tips.append(el("span", "dim", "подсказать:"));
  const TIPS = [
    ["по цене", "price"],
    ["по качеству", "quality"],
    ["по скорости", "speed"],
  ];
  const note = el("span", "dim");
  for (const [label, key] of TIPS) {
    const b = el("button", "mini", label);
    b.addEventListener("click", () => {
      const picked = MODEL_TIPS[key].find((id) => S.studio.models.some((m) => m.id === id));
      if (picked) model.value = picked;
      note.textContent = MODEL_TIPS.note[key];
      tips.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    });
    tips.append(b);
  }
  tips.append(note);
  card.append(tips);

  card.append(
    actionsRow([
      smallBtn("другой промт", "Переписать заново тем же запросом", () => anotherProposal(msg)),
      smallBtn("удалить", "Убрать предложение и всё после него", () => truncateAt(msg)),
    ])
  );
  return card;
}

function resultCard(msg) {
  const card = el("div", "shot");
  const img = document.createElement("img");
  img.src = `/studio/${msg.file}?v=${msg.imageId}`;
  img.loading = "lazy";
  img.alt = msg.text?.slice(0, 60) ?? "картинка";
  img.addEventListener("click", () => window.open(`/studio/${msg.file}`, "_blank"));
  img.style.cursor = "zoom-in";
  card.append(img);

  const d = document.createElement("details");
  d.className = "reasoning";
  const s = document.createElement("summary");
  s.textContent = "промт";
  d.append(s, el("div", "prompt", msg.text ?? ""));
  card.append(d);

  const meta = el("div", "meta");
  meta.append(
    el("span", null, msg.model ?? ""),
    el("span", null, `$${(msg.cost || 0).toFixed(3)}`),
    el("span", null, `${((msg.ms || 0) / 1000).toFixed(1)} с`),
    el("span", null, msg.ref ? "по референсу" : "с нуля"),
    el("span", null, new Date(msg.at).toLocaleString("ru-RU"))
  );
  card.append(meta);

  const dl = el("a", "mini link", "скачать");
  dl.href = `/studio/${msg.file}`;
  dl.download = msg.file;

  card.append(
    actionsRow([
      smallBtn("ещё вариант", "Нарисовать заново с этим же промтом", () => regenerate(msg)),
      smallBtn("править", "Взять как референс и дописать пожелания", () => {
        S.studio.refItem = { id: msg.imageId, file: msg.file };
        S.studio.refData = null;
        renderChip();
        $("#imgPrompt").value = "";
        $("#imgPrompt").placeholder = "Что поправить в этой картинке?";
        $("#imgPrompt").focus();
      }),
      smallBtn("удалить", "Убрать картинку из чата и откатиться", () => truncateAt(msg)),
      dl,
    ])
  );
  return card;
}

function renderChip() {
  const chip = $("#imgChip");
  const src = S.studio.refData ?? (S.studio.refItem ? `/studio/${S.studio.refItem.file}` : null);
  if (!src) {
    chip.classList.add("hidden");
    chip.textContent = "";
    return;
  }
  chip.classList.remove("hidden");
  chip.textContent = "";
  const img = document.createElement("img");
  img.src = src;
  const kill = el("button", null, "✕");
  kill.addEventListener("click", (e) => {
    e.preventDefault();
    S.studio.refData = null;
    S.studio.refItem = null;
    renderChip();
  });
  chip.append(img, kill);
}

async function sendStudio() {
  const text = $("#imgPrompt").value.trim();
  if (text.length < 2) {
    $("#imgPrompt").focus();
    return;
  }
  const direct = $("#imgDirect").checked;
  const btn = $("#imgSend");
  const sess = S.studio.sessions.find((s) => s.id === S.studio.activeId);
  const kind = sess?.kind ?? "images";

  const textChats = {
    docs: ["/api/studio/doc", "редактор работает…"],
    specs: ["/api/studio/spec", "архитектор пишет спеку…"],
    prompts: ["/api/studio/prompt", "промт-инженер думает…"],
    decks: ["/api/studio/deck", "архитектор собирает презентацию…"],
  };
  if (textChats[kind]) {
    const [path, status] = textChats[kind];
    btn.disabled = true;
    $("#studioInfo").innerHTML = `<span class="spin"></span> ${status}`;
    try {
      await studioCall(path, { text });
      $("#imgPrompt").value = "";
      renderThread();
    } catch (err) {
      $("#studioInfo").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (kind === "video") {
    $("#studioInfo").textContent = "Видео ещё не подключено";
    return;
  }

  btn.disabled = true;
  $("#studioInfo").innerHTML = `<span class="spin"></span> ${direct ? "рисую…" : "художник думает…"}`;
  try {
    if (direct) {
      const body = {
        prompt: text,
        model: $("#imgModel").value,
        aspectRatio: $("#imgAspect").value,
        quality: $("#imgQuality").value,
      };
      if (S.studio.refItem?.id) body.referenceId = S.studio.refItem.id;
      await studioCall("/api/studio/generate", body);
    } else {
      const body = { text };
      if (S.studio.refItem?.id) body.referenceId = S.studio.refItem.id;
      await studioCall("/api/studio/say", body);
    }
    S.studio.lastText = text;
    $("#imgPrompt").value = "";
    S.studio.refItem = null;
    S.studio.refData = null;
    renderChip();
    renderThread();
  } catch (err) {
    $("#studioInfo").textContent = err.message;
    pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
  } finally {
    btn.disabled = false;
  }
}

async function submitProposal(msg, values, btn) {
  btn.disabled = true;
  $("#studioInfo").innerHTML = '<span class="spin"></span> рисую…';
  const body = { prompt: values.prompt, model: values.model, aspectRatio: values.aspectRatio, quality: msg.quality ?? "auto" };
  if (values.referenceId) body.referenceId = values.referenceId;
  try {
    await studioCall("/api/studio/generate", body);
  } catch (err) {
    $("#studioInfo").textContent = err.message;
    btn.disabled = false;
  }
}

async function regenerate(msg) {
  $("#studioInfo").innerHTML = '<span class="spin"></span> рисую заново…';
  try {
    const body = { prompt: msg.text, model: msg.model, aspectRatio: msg.aspectRatio, quality: msg.quality, replaceId: msg.id };
    if (msg.ref) body.referenceId = msg.ref;
    await studioCall("/api/studio/generate", body);
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
}

async function anotherProposal(msg) {
  const text = textBefore(msg);
  if (!text) return;
  $("#studioInfo").innerHTML = '<span class="spin"></span> художник думает…';
  try {
    await studioCall("/api/studio/truncate", { id: msg.id });
    await studioCall("/api/studio/propose", { text });
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
}

/* -------------------------------- галерея -------------------------------- */

let galleryTimer = null;
let gallerySeq = 0;

async function setGalleryView(view) {
  S.gallery.view = libViewValue(view);
  writeLocal(GALLERY_VIEW_KEY, S.gallery.view);
  await loadGallery();
}

async function loadGallery() {
  const box = $("#galleryGrid");
  if (!box) return;
  const seq = ++gallerySeq;
  const q = ($("#galleryFilter")?.value ?? "").trim();
  box.textContent = "…";
  try {
    const data = await api(`/api/gallery?limit=300&view=${encodeURIComponent(S.gallery.view)}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    if (seq !== gallerySeq) return; // пришёл ответ на старый фильтр
    S.gallery = { items: data.items ?? [], total: data.total ?? 0, cost: data.cost ?? 0, q, view: S.gallery.view };
    renderGallery();
    renderList();
  } catch (err) {
    if (seq === gallerySeq) box.textContent = "Ошибка: " + err.message;
  }
}

function renderGallery() {
  const box = $("#galleryGrid");
  if (!box) return;
  box.textContent = "";
  const { items, total, cost, q, view } = S.gallery;

  const views = $("#galleryViews");
  if (views) {
    views.textContent = "";
    views.append(libViewSwitch(view, setGalleryView, false));
  }

  const shown = items.length !== total ? `${items.length} из ${total}` : String(items.length);
  $("#galleryInfo").textContent = `${shown} картинок · $${Number(cost || 0).toFixed(3)}`;

  if (!items.length) {
    const empty = {
      all: q ? "По фильтру ничего нет." : "Картинок пока нет — сгенерируй первую в разделе «Студия».",
      fav: "В избранном пока нет картинок.",
      archive: "Архив пуст.",
      trash: "Корзина пуста.",
    }[view];
    box.append(el("div", "empty", empty));
    return;
  }

  for (const item of items) {
    const card = el("div", "galleryCard");
    const img = document.createElement("img");
    img.src = item.url;
    img.alt = (item.prompt ?? "").slice(0, 80);
    img.loading = "lazy";
    img.title = "Открыть в новой вкладке";
    img.addEventListener("click", () => window.open(item.url, "_blank", "noopener"));
    card.append(img);

    const body = el("div", "gBody");
    const prompt = el("div", "galleryPrompt", item.prompt || "без промта");
    prompt.title = item.prompt || "";
    const meta = el("div", "galleryMeta");
    meta.append(
      el("span", null, item.model ?? "—"),
      el("span", null, `$${Number(item.cost || 0).toFixed(3)}`),
      el("span", null, item.at ? new Date(item.at).toLocaleDateString("ru-RU") : "—")
    );
    if (item.deletedAt) meta.append(el("span", "libDeleted", `удалён ${dateShort(item.deletedAt)}`));

    const acts = el("div", "galleryActs");
    const open = document.createElement("a");
    open.className = "mini link";
    open.textContent = "открыть";
    open.href = item.url;
    open.target = "_blank";
    open.rel = "noopener";
    acts.append(open);

    if (canWrite()) {
      if (item.deletedAt) {
        acts.append(smallBtn("восстановить", "Вернуть картинку из корзины", () => restoreLibrary(item.ref)));
        acts.append(
          smallBtn("удалить навсегда", "Удалить запись и файл физически", () => purgeLibrary(item.ref, `картинку «${(item.prompt || item.file).slice(0, 40)}»`), "mini danger")
        );
      } else {
        acts.append(starButton(item.ref, Boolean(item.fav)));
        acts.append(libraryMenu(item.ref, { archived: Boolean(item.archived) }));
      }
    }

    body.append(prompt, meta, acts);
    card.append(body);
    box.append(card);
  }
}

/** Совместимость со старыми вызовами: физическое удаление теперь только через purge библиотеки. */
async function deleteGalleryItem(item) {
  await trashLibrary(item.ref ?? `image:${item.id}`, `картинку «${(item.prompt || item.file).slice(0, 60)}»`);
}

/* -------------------------------- ключи -------------------------------- */

async function loadKeys() {
  const box = $("#keysBody");
  box.textContent = "…";
  let data;
  try {
    data = await api("/api/keys");
  } catch (err) {
    box.textContent = "Ошибка: " + err.message;
    return;
  }
  box.textContent = "";

  // пресеты
  box.append(el("div", "sectionTitle", "Быстрая настройка моделей"));
  const presets = el("div", "presetRow");
  for (const [key, meta] of Object.entries(data.presets ?? {})) {
    const b = el("button", "presetBtn");
    b.append(el("b", null, meta.title), el("span", null, meta.note));
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const res = await api("/api/keys/preset", { method: "POST", body: JSON.stringify({ preset: key }) });
        S.agents = res.agents.agents;
        S.agentsFile = res.agents;
        await loadKeys();
      } catch (err) {
        alert(err.message);
      } finally {
        b.disabled = false;
      }
    });
    presets.append(b);
  }
  box.append(presets);

  // список ключей
  box.append(el("div", "sectionTitle", "Ключи OpenRouter"));
  const list = el("div", "keysList");
  for (const k of data.keys ?? []) {
    const card = el("div", "keyCard");
    const head = el("div", "keyHead");
    head.append(el("b", null, k.label), el("span", "dim", k.mask));
    if (data.defaultKeyId === k.id) head.append(el("span", "tag", "по умолчанию"));

    const limit = document.createElement("input");
    limit.type = "number";
    limit.min = "0";
    limit.step = "0.5";
    limit.className = "limitInput";
    limit.value = String(k.limitDaily ?? 0);
    limit.title = "Дневной лимит, $ (0 — без лимита)";
    limit.addEventListener("change", async () => {
      await api(`/api/keys/${k.id}`, { method: "POST", body: JSON.stringify({ limitDaily: Number(limit.value) }) });
      await loadKeys();
    });

    const spend = el("div", "meta");
    spend.append(el("span", null, `сегодня: $${(data.spend?.[k.id] ?? 0).toFixed(3)}`), el("span", null, "лимит: $"), limit);
    if (k.limitDaily) spend.append(el("span", null, `из $${k.limitDaily}`));

    const acts = el("div", "keyActs");
    if (data.defaultKeyId !== k.id) {
      const def = el("button", "mini", "сделать основным");
      def.addEventListener("click", async () => {
        await api("/api/keys/default", { method: "POST", body: JSON.stringify({ id: k.id }) });
        await loadKeys();
      });
      acts.append(def);
    }
    const del = el("button", "mini danger", "удалить");
    del.addEventListener("click", async () => {
      if (!confirm(`Удалить ключ «${k.label}»?`)) return;
      try {
        await api(`/api/keys/${k.id}`, { method: "DELETE" });
        await loadKeys();
      } catch (err) {
        alert(err.message);
      }
    });
    acts.append(del);

    card.append(head, spend, acts);
    list.append(card);
  }
  box.append(list);

  // добавление
  box.append(el("div", "sectionTitle", "Добавить ключ"));
  const form = el("div", "keyForm");
  const label = document.createElement("input");
  label.placeholder = "Название, например «Основной»";
  const key = document.createElement("input");
  key.placeholder = "sk-or-v1-…";
  key.type = "password";
  const add = el("button", "primary", "Добавить");
  add.addEventListener("click", async () => {
    add.disabled = true;
    try {
      await api("/api/keys", { method: "POST", body: JSON.stringify({ label: label.value || "Ключ", key: key.value, limitDaily: 0 }) });
      label.value = "";
      key.value = "";
      await loadKeys();
    } catch (err) {
      alert(err.message);
    } finally {
      add.disabled = false;
    }
  });
  form.append(label, key, add);
  box.append(form);
  box.append(el("div", "hint", "Ключ хранится в config/keys.json на этой машине и наружу отдаётся только маской."));

  // привязка агентов
  box.append(el("div", "sectionTitle", "Какой ключ у какого агента"));
  const table = el("table", "tbl");
  table.innerHTML = "<thead><tr><th>Агент</th><th>Модель</th><th>Ключ</th></tr></thead>";
  const tb = document.createElement("tbody");
  for (const a of S.agents) {
    if (a.kind === "external") continue;
    const tr = document.createElement("tr");
    tr.append(td(a.name, "name"), td(a.model || "—"));
    const cell = document.createElement("td");
    const sel = document.createElement("select");
    sel.className = "miniSelect";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "по умолчанию";
    sel.append(auto);
    for (const k of data.keys ?? []) {
      const o = document.createElement("option");
      o.value = k.id;
      o.textContent = k.label;
      sel.append(o);
    }
    sel.value = data.assign?.[a.id] ?? "";
    sel.addEventListener("change", async () => {
      await api("/api/keys/assign", { method: "POST", body: JSON.stringify({ agentId: a.id, keyId: sel.value || null }) });
      await loadKeys();
    });
    cell.append(sel);
    tr.append(cell);
    tb.append(tr);
  }
  table.append(tb);
  box.append(table);

  // управление пользователями — только админ
  if (S.role === "admin") box.append(await renderUsersCard());
}

async function renderUsersCard() {
  const card = el("div", "card");
  card.id = "usersCard";
  card.append(el("div", "sectionTitle", "Пользователи и роли"));
  card.append(el("div", "dim", "viewer — только чтение; editor — прогоны и настройки, кроме ключей, пользователей и удаления проектов; admin — всё."));

  let users = [];
  try {
    ({ users } = await api("/api/users"));
  } catch (err) {
    card.append(el("div", "hint", "Не удалось загрузить пользователей: " + err.message));
    return card;
  }

  const table = el("table", "tbl");
  table.innerHTML = "<thead><tr><th>Логин</th><th>Роль</th><th>Создан</th><th>Действия</th></tr></thead>";
  const tb = document.createElement("tbody");
  for (const u of users) {
    const tr = document.createElement("tr");
    tr.append(td(u.login, "name"));

    const roleCell = document.createElement("td");
    const sel = document.createElement("select");
    sel.className = "miniSelect";
    for (const r of ["viewer", "editor", "admin"]) {
      const o = document.createElement("option");
      o.value = r;
      o.textContent = r;
      sel.append(o);
    }
    sel.value = u.role;
    sel.addEventListener("change", async () => {
      try {
        await api(`/api/users/${u.id}/role`, { method: "POST", body: JSON.stringify({ role: sel.value }) });
        await loadKeys();
      } catch (err) {
        alert(err.message);
        await loadKeys();
      }
    });
    roleCell.append(sel);
    tr.append(roleCell, td(new Date(u.createdAt).toLocaleString("ru-RU")));

    const acts = document.createElement("td");
    const pass = el("button", "mini", "сменить пароль");
    pass.addEventListener("click", async () => {
      const next = prompt(`Новый пароль для «${u.login}» (минимум 6 символов)`);
      if (!next) return;
      try {
        await api(`/api/users/${u.id}/password`, { method: "POST", body: JSON.stringify({ password: next }) });
        alert("Пароль обновлён. Старые сессии этого пользователя закрыты.");
      } catch (err) {
        alert(err.message);
      }
    });
    const del = el("button", "mini danger", "удалить");
    del.addEventListener("click", async () => {
      if (!confirm(`Удалить пользователя «${u.login}»?`)) return;
      try {
        await api(`/api/users/${u.id}`, { method: "DELETE" });
        await loadKeys();
      } catch (err) {
        alert(err.message);
      }
    });
    acts.append(pass, del);
    tr.append(acts);
    tb.append(tr);
  }
  table.append(tb);
  card.append(table);

  const form = el("div", "keyForm");
  const login = document.createElement("input");
  login.placeholder = "логин (латиница, 3–32)";
  const password = document.createElement("input");
  password.placeholder = "пароль (мин. 6)";
  password.type = "password";
  const role = document.createElement("select");
  role.className = "miniSelect";
  for (const r of ["viewer", "editor", "admin"]) {
    const o = document.createElement("option");
    o.value = r;
    o.textContent = r;
    role.append(o);
  }
  role.value = "editor";
  const add = el("button", "primary", "Добавить пользователя");
  add.addEventListener("click", async () => {
    add.disabled = true;
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify({ login: login.value.trim(), password: password.value, role: role.value }) });
      await loadKeys();
    } catch (err) {
      alert(err.message);
    } finally {
      add.disabled = false;
    }
  });
  form.append(login, password, role, add);
  card.append(form);
  card.append(el("div", "hint", "Пароли хранятся scrypt-хешами. Пароль первого админа напечатан в консоли сервера."));
  return card;
}

/* -------------------------------- поиск -------------------------------- */

async function runSearch() {
  const q = $("#searchInput").value.trim();
  if (q.length < 2) return;
  const box = $("#searchResults");
  box.textContent = "ищу…";
  try {
    const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
    box.textContent = "";

    const section = (title, items, render) => {
      if (!items?.length) return;
      const t = el("div", "sectionTitle", `${title} · ${items.length}`);
      box.append(t);
      for (const it of items) box.append(render(it));
    };

    section("Проекты", r.projects, (p) => {
      const row = el("div", "searchItem");
      row.append(el("b", null, p.name), el("span", "dim", p.task ?? ""));
      row.addEventListener("click", async () => {
        setPage("projects");
        await selectProject(p.id);
      });
      return row;
    });

    section("Прогоны", r.runs, (x) => {
      const row = el("div", "searchItem");
      row.append(el("b", null, x.change ? "↻ " + x.change : x.id), el("span", "dim", `${statusLabel(x.status)} · ${x.task}`));
      row.addEventListener("click", async () => {
        setPage("projects");
        if (x.projectId) await selectProject(x.projectId);
        await selectRun(x.id);
      });
      return row;
    });

    section("Артефакты", r.artifacts, (a) => {
      const row = el("div", "searchItem");
      row.append(el("b", null, a.path), el("span", "dim", a.runId));
      row.addEventListener("click", async () => {
        setPage("projects");
        if (a.projectId) await selectProject(a.projectId);
        await selectRun(a.runId);
        setTab("files");
        showArtifact(a.path);
      });
      return row;
    });

    section("Картинки", r.images, (im) => {
      const row = el("div", "searchItem");
      const pic = document.createElement("img");
      pic.src = `/studio/${im.file}`;
      pic.className = "searchThumb";
      row.append(pic, el("span", "dim", im.prompt ?? ""));
      row.addEventListener("click", () => window.open(`/studio/${im.file}`, "_blank"));
      return row;
    });

    section("Агенты", r.agents, (a) => {
      const row = el("div", "searchItem");
      row.append(el("b", null, a.name), el("span", "dim", a.role ?? ""));
      row.addEventListener("click", () => selectAgent(a.id));
      return row;
    });

    if (!box.childElementCount) box.append(el("div", "empty", "ничего не нашлось"));
  } catch (err) {
    box.textContent = "Ошибка: " + err.message;
  }
}

/* ------------------------------ ассистент ------------------------------ */

async function setAssistTab(tab) {
  document.querySelectorAll("#assistTabs button").forEach((b) => b.classList.toggle("active", b.dataset.atab === tab));
  $("#assistChat").classList.toggle("hidden", tab !== "chat");
  $("#assistLogs").classList.toggle("hidden", tab !== "logs");
  $("#assistErrors").classList.toggle("hidden", tab !== "errors");
  $("#assistMail").classList.toggle("hidden", tab !== "mail");
  if (tab === "chat") return renderChat();

  if (tab === "logs" || tab === "errors") {
    const box = tab === "logs" ? $("#assistLogList") : $("#assistErrorList");
    box.textContent = "…";
    try {
      const { logs } = await api("/api/logs?limit=150");
      let rows = logs;
      if (tab === "errors") {
        const { alerts } = await api("/api/alerts");
        rows = [
          ...alerts.map((a) => ({ at: new Date().toISOString(), kind: a.level === "bad" ? "error" : "gate", project: "наблюдатель", message: a.text })),
          ...logs.filter((l) => l.kind === "error" || l.kind === "call_failed"),
        ];
      }
      box.textContent = "";
      if (!rows.length) box.append(el("div", "empty", tab === "errors" ? "ошибок нет" : "лог пуст"));
      for (const l of rows.slice(0, 150)) {
        const row = el("div", "row");
        row.append(
          el("span", "t", hhmmss(l.at)),
          el("span", "p", (l.project ?? "").slice(0, 22)),
          el("span", "m " + (l.kind === "error" ? "error" : l.kind === "gate" ? "gate" : ""), l.message)
        );
        box.append(row);
      }
    } catch (err) {
      box.textContent = "Ошибка: " + err.message;
    }
    return;
  }

  if (tab === "mail") {
    const box = $("#assistMailList");
    box.textContent = "…";
    try {
      const { items } = await api("/api/mailbox");
      box.textContent = "";
      if (!items.length) box.append(el("div", "empty", "сообщений нет"));
      for (const m of [...items].reverse()) {
        const row = el("div", "row");
        const who = m.from === "user" ? "ты" : m.from === "harness" ? "харнесс" : m.from === "assistant" ? "ассистент" : "портал";
        row.append(el("span", "t", hhmmss(m.at)), el("span", "p", who), el("span", "m", m.text));
        box.append(row);
      }
    } catch (err) {
      box.textContent = "Ошибка: " + err.message;
    }
  }
}

async function cleanupDisk() {
  if (!confirm("Удалить с диска каталоги прогонов, которые не привязаны ни к одному проекту?")) return;
  try {
    const res = await api("/api/maintenance/cleanup", { method: "POST" });
    alert(res.freed ? `Удалено каталогов: ${res.freed}` : "Мусора не нашлось — всё привязано к проектам.");
    pollTasks();
  } catch (err) {
    alert(err.message);
  }
}

async function cleanMissingProjects() {
  if (
    !confirm(
      "Очистить несуществующие проекты? Из projects.json удалятся записи, у которых нет ни одного живого прогона на диске. Проекты с живыми прогонами останутся."
    )
  ) {
    return;
  }
  try {
    const res = await api("/api/projects/cleanup", { method: "POST", body: JSON.stringify({}) });
    const names = (res.projects ?? []).map((p) => `«${p.name}»`).join(", ");
    alert(res.removed ? `Удалено проектов: ${res.removed}${names ? " — " + names : ""}` : "Несуществующих проектов нет — все записи живые.");
    const st = await api("/api/state");
    S.projects = st.projects ?? [];
    if (S.project && !S.projects.some((p) => p.id === S.project.id)) newProjectMode();
    else {
      renderList();
      renderProjectHead();
    }
    pollTasks();
  } catch (err) {
    alert(err.message);
  }
}

const chat = [];

function renderChat() {
  const box = $("#chatLog");
  box.textContent = "";
  if (!chat.length) {
    box.append(el("div", "empty", "Спроси что-нибудь про проекты: «где остановился», «были ли ошибки», «сколько потрачено»."));
    return;
  }
  for (const m of chat) {
    const node = el("div", "msg " + (m.role === "user" ? "user" : m.role === "error" ? "err" : "bot"), m.text);
    if (m.meta) node.append(el("span", "meta", m.meta));
    box.append(node);
  }
  box.scrollTop = box.scrollHeight;
}

async function ask() {
  const input = $("#askInput");
  const question = input.value.trim();
  if (!question) return;
  chat.push({ role: "user", text: question });
  input.value = "";
  $("#askBtn").disabled = true;
  const pending = { role: "assistant", text: "…" };
  chat.push(pending);
  renderChat();
  try {
    const res = await api("/api/assistant", {
      method: "POST",
      body: JSON.stringify({ question, history: chat.slice(-7, -1) }),
    });
    pending.text = res.answer;
    pending.meta = `${res.model} · $${Number(res.cost || 0).toFixed(4)}`;
  } catch (err) {
    pending.role = "error";
    pending.text = err.message;
  } finally {
    $("#askBtn").disabled = false;
    renderChat();
  }
}

function dot(status) {
  const d = el("span", "dot");
  const map = { done: "var(--ok)", failed: "var(--bad)", cancelled: "var(--bad)", interrupted: "var(--bad)", awaiting: "var(--warn)", awaiting_plan: "var(--warn)", paused: "var(--warn)", running: "var(--accent)" };
  if (map[status]) d.style.background = map[status];
  return d;
}

/* ------------------------------ projects ------------------------------ */

async function selectProject(id) {
  closeStream();
  try {
    const { project } = await api(`/api/projects/${id}`);
    S.project = project;
    S.runs = project.runs ?? [];
    S.projects = S.projects.map((p) => (p.id === project.id ? { ...p, ...project } : p));
    renderList();
    renderProjectHead();
    renderRuns();
    $("#composer").classList.add("hidden");
    if (S.runs[0]) await selectRun(S.runs[0].id);
    else clearRun();
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: `Не открылся проект: ${err.message}` });
  }
}

function newProjectMode() {
  setPage("projects");
  closeStream();
  S.project = null;
  S.runs = [];
  S.current = null;
  renderList();
  renderProjectHead();
  renderRuns();
  clearRun();
  $("#composer").classList.remove("hidden");
  $("#task").focus();
}

async function deleteProject(p) {
  if (!confirm(`Удалить проект «${p.name}» и все его прогоны (${p.runs?.length ?? 0})?`)) return;
  try {
    await api(`/api/projects/${p.id}`, { method: "DELETE" });
    S.projects = S.projects.filter((x) => x.id !== p.id);
    if (S.project?.id === p.id) newProjectMode();
    else renderList();
    pollTasks();
  } catch (err) {
    alert(err.message);
  }
}

function renderProjectHead() {
  const box = $("#projectHead");
  box.textContent = "";
  if (!S.project) {
    box.append(el("h1", null, "Новый проект"));
    box.append(el("div", "task", "Опиши, что нужно получить в итоге — и запусти каскад."));
    return;
  }
  box.append(el("h1", null, S.project.name));
  box.append(el("div", "task", S.project.task || ""));
  const facts = el("div", "facts");
  const cost = S.runs.reduce((a, r) => a + (r.cost || 0), 0);
  facts.append(el("span", null, `версий: ${S.runs.length}`), el("span", null, `$${cost.toFixed(4)}`));
  if (S.project.paused) {
    const badge = el("span", "badge pausedBadge", "⏸ на паузе");
    badge.title = S.project.pausedStage ? `остановлен на стадии «${S.project.pausedStage}»` : "прогон остановлен";
    facts.append(badge);
    if (S.project.pausedAt) facts.append(el("span", null, `с ${hhmmss(S.project.pausedAt)}`));
    const go = el("button", "mini", "▶ Продолжить");
    go.dataset.write = "";
    go.title = "Продолжить с той же стадии";
    go.addEventListener("click", () => resumeRun(S.project.pausedRunId || S.current?.id));
    facts.append(go);
  } else {
    const active = S.runs.find((r) => ["running", "awaiting", "awaiting_plan"].includes(r.status));
    if (active) {
      const pause = el("button", "mini", "⏸ Пауза");
      pause.dataset.write = "";
      pause.title = "Мягко остановить прогон: текущий вызов доиграет, новые стадии не пойдут";
      pause.addEventListener("click", () => pauseProjectRun(active.id));
      facts.append(pause);
    }
  }
  const clean = el("button", "mini", "очистить несуществующие");
  clean.dataset.write = "";
  clean.title = "Удалить из projects.json записи без живых прогонов на диске; проекты с живыми прогонами останутся";
  clean.addEventListener("click", cleanMissingProjects);
  facts.append(clean);
  const del = el("button", "mini danger projectKill", "удалить проект");
  del.addEventListener("click", () => deleteProject(S.project));
  facts.append(del);
  box.append(facts);
}

/* ------------------------------- agents ------------------------------- */

function selectAgent(id) {
  setPage("agents");
  S.editingAgent = S.agents.find((a) => a.id === id) ?? null;
  renderList();
  renderAgentEditor();
}

function renderAgentEditor() {
  const box = $("#agentEditor");
  box.textContent = "";
  const a = S.editingAgent;
  if (!a) {
    box.append(el("div", "empty", "Выбери агента слева или добавь нового."));
    return;
  }
  const card = el("div", "card");
  const facts = el("div", "facts");
  facts.append(el("span", null, `id: ${a.id}`), el("span", null, a.kind === "external" ? "внешний (чат)" : "модель по API"));
  card.append(facts);

  const g2 = el("div", "grid2");
  const nameL = el("label", "label", "Имя");
  const nameI = el("input");
  nameI.value = a.name;
  nameL.append(nameI);
  const roleL = el("label", "label", "Роль");
  const roleI = el("input");
  roleI.value = a.role || "";
  roleL.append(roleI);
  g2.append(nameL, roleL);
  card.append(g2);

  const modelL = el("label", "label", "Модель (OpenRouter id)");
  const modelI = el("input");
  modelI.value = a.model || "";
  modelI.setAttribute("list", "modelList");
  const dl = document.createElement("datalist");
  dl.id = "modelList";
  for (const m of S.models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.label = `${m.id} · $${(m.promptPrice * 1e6).toFixed(2)} / $${(m.completionPrice * 1e6).toFixed(2)}`;
    dl.append(opt);
  }
  modelL.append(modelI, dl);
  card.append(modelL);

  const tempL = el("label", "label", "Температура");
  const tempI = el("input");
  tempI.type = "number";
  tempI.min = "0";
  tempI.max = "2";
  tempI.step = "0.1";
  tempI.value = a.temperature ?? 0.3;
  tempL.append(tempI);
  card.append(tempL);

  const promptL = el("label", "label", "Системный промт");
  const promptI = el("textarea");
  promptI.rows = 8;
  promptI.value = a.prompt || "";
  promptL.append(promptI);
  card.append(promptL);

  const actions = el("div", "actions");
  const save = el("button", "primary", "Сохранить");
  save.addEventListener("click", () => {
    a.name = nameI.value.trim() || a.id;
    a.role = roleI.value.trim();
    a.model = modelI.value.trim();
    a.temperature = Number(tempI.value);
    a.prompt = promptI.value;
    saveAgents();
  });
  const del = el("button", "danger", "Удалить");
  del.addEventListener("click", () => deleteAgent(a));
  actions.append(del, save);
  card.append(actions);

  box.append(card);
  renderAgentStats(a);
  if (a.id === "harness") renderHarnessSettings(a);
  if (!S.models.length && !S.modelsTried) {
    S.modelsTried = true;
    loadModels().then(() => {
      if (S.models.length && S.editingAgent?.id === a.id) renderAgentEditor();
    });
  }
}

async function renderAgentStats(a) {  const box = $("#agentEditor");
  const { agents } = await loadMetrics();
  const m = agents.find((x) => x.id === a.id);
  if (S.editingAgent?.id !== a.id) return;
  const card = el("div", "card");
  card.append(el("div", "sectionTitle", "Статистика агента"));
  if (!m) {
    card.append(el("div", "empty", "Пока не вызывался."));
  } else {
    const facts = el("div", "facts");
    facts.append(
      el("span", null, `вызовов: ${m.attempts}`),
      el("span", null, `ошибок: ${m.failed}`),
      el("span", null, `средний ответ: ${fmtMs(m.avgMs)}`),
      el("span", null, `правок: ${m.fixes}`),
      el("span", null, `проверок: ${m.verdicts.pass}/${m.verdicts.fail}`),
      el("span", null, `стоимость: $${m.cost.toFixed(4)}`)
    );
    card.append(facts);
    if (m.failed > 0) {
      const warn = el("div", "empty", `Ошибок ${m.failed} из ${m.attempts} вызовов — повод сменить модель или промт.`);
      warn.style.color = "var(--warn)";
      card.append(warn);
    }
  }
  box.append(card);
}

async function loadModels() {
  if (S.models.length || S.mode === "mock") return;
  try {
    const { models } = await api("/api/models");
    S.models = models;
  } catch {
    /* можно вписать вручную */
  }
}

async function saveAgents() {
  try {
    const res = await api("/api/config", {
      method: "POST",
      body: JSON.stringify({ agents: { ...S.agentsFile, agents: S.agents }, pipeline: S.pipelineFile }),
    });
    S.agentsFile = res.agents;
    S.agents = res.agents.agents;
    renderList();
    renderAgentEditor();
  } catch (err) {
    alert("Не сохранилось: " + err.message);
  }
}

function addAgent() {
  setPage("agents");
  const id = `agent-${Math.random().toString(36).slice(2, 6)}`;
  const agent = { id, name: "Новый агент", role: "", kind: "llm", model: "deepseek/deepseek-v3.2", temperature: 0.3, prompt: "" };
  S.agents.push(agent);
  S.editingAgent = agent;
  renderList();
  renderAgentEditor();
}

async function deleteAgent(a) {
  if (!confirm(`Удалить агента «${a.name}»?`)) return;
  try {
    const res = await api(`/api/agents/${a.id}`, { method: "DELETE" });
    S.agents = res.agents.agents;
    if (S.editingAgent?.id === a.id) S.editingAgent = null;
    renderList();
    renderAgentEditor();
  } catch (err) {
    alert(err.message);
  }
}

/* ------------------------------- stats ------------------------------- */

async function renderWatchCard(box) {
  let data;
  try {
    data = await api("/api/watch");
  } catch (err) {
    box.append(el("div", "empty", "Дежурный недоступен: " + err.message));
    return;
  }
  S.watch = data;

  const card = el("div", "card watchCard");
  const head = el("div", "sectionHead");
  head.append(el("span", null, "Дежурный"), el("span", "tag", data.running ? "работает" : "выключен"));
  card.append(head);

  const facts = el("div", "facts");
  facts.append(
    el("span", null, data.running ? `каждые ${data.everyMin} мин` : `интервал: ${data.everyMin} мин`),
    el("span", null, data.lastRunAt ? `последняя проверка: ${new Date(data.lastRunAt).toLocaleString("ru-RU")}` : "ещё не проверял")
  );
  card.append(facts);

  if (data.lastAlerts?.length) {
    const list = el("div", "watchAlerts");
    for (const a of data.lastAlerts.slice(0, 5)) {
      const row = el("div", "watchAlert " + (a.level === "bad" ? "bad" : a.level === "warn" ? "warn" : ""), a.text);
      list.append(row);
    }
    if (data.lastAlerts.length > 5) list.append(el("div", "dim", `… и ещё ${data.lastAlerts.length - 5}`));
    card.append(list);
  } else {
    card.append(el("div", "empty", "Проблем не найдено."));
  }

  if (S.role === "admin") {
    const controls = el("div", "watchControls");
    const label = el("label", "label", "Интервал, минут");
    const every = document.createElement("input");
    every.type = "number";
    every.min = "1";
    every.max = "1440";
    every.value = String(data.everyMin ?? 10);
    every.className = "watchEvery";
    label.append(every);
    controls.append(label);

    const toggle = el("button", data.running ? "danger" : "primary", data.running ? "выключить" : "включить");
    toggle.dataset.write = "";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        if (data.running) await api("/api/watch/stop", { method: "POST" });
        else await api("/api/watch/start", { method: "POST", body: JSON.stringify({ everyMin: Number(every.value) || 10 }) });
        await loadStats();
      } catch (err) {
        alert(err.message);
        toggle.disabled = false;
      }
    });
    controls.append(toggle);
    every.addEventListener("change", async () => {
      if (!data.running) return;
      try {
        await api("/api/watch/start", { method: "POST", body: JSON.stringify({ everyMin: Number(every.value) || 10 }) });
        await loadStats();
      } catch (err) {
        alert(err.message);
      }
    });
    card.append(controls);
    card.append(el("div", "hint", "Каждые N минут портал собирает алерты, пишет их в почтовый ящик и шлёт событие watch в угловой чат."));
  } else {
    card.append(el("div", "hint", "Включает и настраивает администратор. Алерты приходят в угловой чат."));
  }

  box.append(card);
}

/* --------------------------- снимки состояния --------------------------- */

const fmtBytes = (bytes) => {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 Б";
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(2)} МБ`;
};
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

async function saveSnapshot() {
  const name = prompt("Название снимка (необязательно):", "");
  if (name === null) return;
  try {
    const res = await api("/api/snapshots", { method: "POST", body: JSON.stringify({ name }) });
    alert(`Снимок создан: «${res.snapshot?.name ?? "снимок"}» · ${fmtBytes(res.snapshot?.size)} · прогонов: ${res.snapshot?.runs ?? 0}`);
    await loadStats();
  } catch (err) {
    alert(err.message);
  }
}

async function restoreSnapshot(id, name) {
  if (!confirm(`Восстановить состояние из снимка «${name}»? Сначала автоматически сохраним текущее состояние (before-restore).`)) return;
  try {
    const res = await api(`/api/snapshots/${encodeURIComponent(id)}/restore`, { method: "POST", body: JSON.stringify({}) });
    alert(
      `Восстановлено файлов: ${res.restored}. Авто-снимок текущего состояния: «${res.before?.name ?? "before-restore"}». Страница перезагрузится.`
    );
    window.location.reload();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteSnapshot(id, name) {
  if (!confirm(`Удалить снимок «${name}»? Файлы снимка пропадут безвозвратно.`)) return;
  try {
    await api(`/api/snapshots/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadStats();
  } catch (err) {
    alert(err.message);
  }
}

async function renderSnapshots(box) {
  let snapshots = [];
  let error = null;
  try {
    ({ snapshots } = await api("/api/snapshots"));
  } catch (err) {
    error = err.message;
  }
  const card = el("div", "card snapshotCard");
  card.id = "statsSnapshots";
  const head = el("div", "listHead");
  head.append(el("span", null, "Состояние портала"));
  const save = el("button", "mini", "Сохранить состояние");
  save.dataset.write = "";
  save.title = "Сохранить projects.json, config/, studio/ и state.json всех прогонов";
  save.addEventListener("click", saveSnapshot);
  head.append(save);
  card.append(head);
  card.append(el("div", "hint", "Снимок — это папка snapshots/<дата>-<имя>: проекты, настройки агентов и пайплайна, студия и состояния прогонов. Перед восстановлением всегда делается авто-снимок before-restore."));
  if (error) card.append(el("div", "empty", "Снимки не прочитались: " + error));
  else if (!snapshots.length) card.append(el("div", "empty", "снимков пока нет — сохрани состояние перед рискованным изменением"));
  else {
    const t = el("table", "tbl");
    t.innerHTML = "<thead><tr><th>Имя</th><th>Когда</th><th>Размер</th><th>Прогонов</th><th></th></tr></thead>";
    const tb = document.createElement("tbody");
    for (const snap of snapshots) {
      const tr = document.createElement("tr");
      tr.append(td(snap.name, "name"), td(fmtDate(snap.createdAt)), td(fmtBytes(snap.size)), td(String(snap.runs ?? 0)));
      const acts = document.createElement("td");
      acts.className = "snapActs";
      if (S.role === "admin") {
        const restore = el("button", "mini", "восстановить");
        restore.title = "Вернуть файлы к состоянию снимка";
        restore.addEventListener("click", () => restoreSnapshot(snap.id, snap.name));
        acts.append(restore);
      }
      const del = el("button", "mini danger", "удалить");
      del.dataset.write = "";
      del.title = "Удалить снимок";
      del.addEventListener("click", () => deleteSnapshot(snap.id, snap.name));
      acts.append(del);
      tr.append(acts);
      tb.append(tr);
    }
    t.append(tb);
    card.append(t);
  }
  box.append(card);
}

async function loadStats() {
  const box = $("#statsBody");
  box.textContent = "…";
  try {
    const { stats } = await api("/api/stats");
    box.textContent = "";
    const cards = el("div", "cards");
    const add = (v, l) => {
      const c = el("div", "cardStat");
      c.append(el("div", "v", v), el("div", "l", l));
      cards.append(c);
    };
    add(`$${stats.cost.toFixed(3)}`, "потрачено");
    add(String(stats.calls), "вызовов модели");
    add(`${(stats.tokens / 1000).toFixed(1)}k`, "токенов");
    add(String(stats.projectsCount), "проектов");
    const totalRuns = Object.values(stats.byStatus).reduce((a, b) => a + b, 0);
    add(String(totalRuns), "прогонов");
    add(String(stats.byStatus.done ?? 0), "завершено");
    cards.id = "statsCost";
    box.append(cards);

    await renderSnapshots(box);
    await renderWatchCard(box);
    await renderAgentMetrics(box);

    if (stats.byModel.length) {
      const title = el("div", "sectionTitle", "По моделям");
      title.id = "statsModels";
      box.append(title);
      const t = el("table", "tbl");
      t.innerHTML = "<thead><tr><th>Модель</th><th>Вызовов</th><th>Стоимость</th></tr></thead>";
      const tb = document.createElement("tbody");
      for (const m of stats.byModel) {
        const tr = document.createElement("tr");
        tr.append(td(m.model), td(String(m.calls)), td(`$${m.cost.toFixed(4)}`));
        tb.append(tr);
      }
      t.append(tb);
      box.append(t);
    }

    if (stats.projects.length) {
      const title = el("div", "sectionTitle", "По проектам");
      title.id = "statsProjects";
      box.append(title);
      const maxCost = Math.max(...stats.projects.map((p) => p.cost), 0.000001);
      const t = el("table", "tbl");
      t.innerHTML = "<thead><tr><th>Проект</th><th>Версий</th><th>Готово</th><th>Стоимость</th><th></th></tr></thead>";
      const tb = document.createElement("tbody");
      for (const p of stats.projects) {
        const tr = document.createElement("tr");
        const bar = el("div", "barWrap");
        const fill = el("div", "bar");
        fill.style.width = `${Math.max(2, (p.cost / maxCost) * 100)}%`;
        bar.append(fill);
        const btd = document.createElement("td");
        btd.append(bar);
        tr.append(td(p.name, "name"), td(String(p.runs)), td(String(p.done)), td(`$${p.cost.toFixed(4)}`), btd);
        tb.append(tr);
      }
      t.append(tb);
      box.append(t);
    }

    if (stats.byDay.length) {
      const title = el("div", "sectionTitle", "По дням");
      title.id = "statsDays";
      box.append(title);
      const t = el("table", "tbl");
      t.innerHTML = "<thead><tr><th>День</th><th>Стоимость</th></tr></thead>";
      const tb = document.createElement("tbody");
      for (const [day, cost] of stats.byDay) {
        const tr = document.createElement("tr");
        tr.append(td(day), td(`$${cost.toFixed(4)}`));
        tb.append(tr);
      }
      t.append(tb);
      box.append(t);
    }

    if (!stats.byModel.length && !stats.projects.length) box.append(el("div", "empty", "Пока нет данных — запусти первый прогон."));
  } catch (err) {
    box.textContent = "Ошибка: " + err.message;
  }
}

const td = (text, cls) => {
  const c = document.createElement("td");
  if (cls) c.className = cls;
  c.textContent = text;
  return c;
};

/* --------------------------- метрики агентов --------------------------- */

async function loadMetrics({ force = false } = {}) {
  if (S.metrics && !force) return S.metrics;
  try {
    S.metrics = await api("/api/metrics");
  } catch {
    S.metrics = { agents: [], verdicts: null, runs: 0 };
  }
  return S.metrics;
}

const fmtMs = (ms) => (ms == null ? "—" : ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`);

async function renderAgentMetrics(box) {
  const { agents, verdicts } = await loadMetrics({ force: true });
  if (!agents.length) return;

  const title = el("div", "sectionTitle", "По агентам: кто работает, кто косячит");
  title.id = "statsAgents";
  box.append(title);
  const t = el("table", "tbl");
  t.innerHTML =
    "<thead><tr><th>Агент</th><th>Модель</th><th>Вызовов</th><th>Ошибок</th><th>Средний ответ</th><th>Правок</th><th>Проверки</th><th>Стоимость</th></tr></thead>";
  const tb = document.createElement("tbody");
  for (const a of agents) {
    const tr = document.createElement("tr");
    const cfg = S.agents.find((x) => x.id === a.id);
    tr.append(td(cfg?.name ?? a.id, "name"));
    tr.append(td(a.model ?? "—"));
    tr.append(td(String(a.attempts)));
    const errTd = td(a.failed ? `${a.failed} (${Math.round(a.failRate * 100)}%)` : "0");
    errTd.style.color = a.failed ? "var(--bad)" : "var(--dim)";
    tr.append(errTd);
    tr.append(td(fmtMs(a.avgMs)));
    tr.append(td(String(a.fixes)));
    const v = a.verdicts.pass + a.verdicts.fail ? `${a.verdicts.pass}/${a.verdicts.fail}` : "—";
    tr.append(td(v));
    tr.append(td(`$${a.cost.toFixed(4)}`));
    tb.append(tr);
  }
  t.append(tb);
  box.append(t);

  if (verdicts && verdicts.total) {
    const pct = Math.round(verdicts.passRate * 100);
    box.append(
      el(
        "div",
        "diffSummary",
        `Проверок: ${verdicts.total} · с первого раза: ${verdicts.pass} (${pct}%) · с дефектами: ${verdicts.fail} · блоков принято: ${verdicts.blocksVerified}, провалено: ${verdicts.blocksFailed}`
      )
    );
  }
}

/* -------------------------------- runs -------------------------------- */

function renderRuns() {
  const box = $("#runs");
  box.textContent = "";
  if (!S.runs.length) {
    box.append(el("div", "empty", "прогонов ещё нет"));
    return;
  }
  for (const r of S.runs) {
    const item = el("div", "runItem" + (S.current?.id === r.id ? " active" : ""));
    item.append(el("span", "t", r.change ? "↻ " + r.change : "версия " + r.id.slice(-4)));
    item.append(el("span", "s " + r.status, statusLabel(r.status)));
    item.append(el("span", "c", "$" + (r.cost || 0).toFixed(3)));
    item.addEventListener("click", () => selectRun(r.id));
    box.append(item);
  }
}

async function selectRun(id) {
  closeStream();
  try {
    const { run } = await api(`/api/runs/${id}`);
    $("#log").textContent = "";
    S.lastSeq = 0;
    S.artSig = "";
    S.previewSig = "";
    applyRun(run);
    connectStream(id);
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: `Не открылся прогон: ${err.message}` });
  }
}

function clearRun() {
  S.current = null;
  $("#blocks").textContent = "";
  $("#planTitle").textContent = "";
  $("#gate").classList.add("hidden");
  $("#iterate").classList.add("hidden");
  $("#runStatus").textContent = "";
  $("#artifacts").textContent = "";
  $("#downloadZip")?.classList.add("hidden");
  $("#runPause")?.classList.add("hidden");
  $("#preview").src = "about:blank";
  renderStages();
}

/* ------------------------------- stream ------------------------------- */

function connectStream(id) {
  const es = new EventSource(`/api/runs/${id}/events`);
  S.stream = es;
  es.onmessage = (ev) => {
    try {
      const entry = JSON.parse(ev.data);
      if (entry.seq && entry.seq <= S.lastSeq) return;
      if (entry.seq) S.lastSeq = entry.seq;
      pushLog(entry);
    } catch {
      /* ignore */
    }
  };
  es.addEventListener("state", (ev) => {
    try {
      applyRun(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  // Если сессия истекла, SSE получает 401 и молча переподключается — проверяем вход вручную.
  es.onerror = () => {
    api("/api/me").catch(() => {});
  };
}

function closeStream() {
  if (S.stream) S.stream.close();
  S.stream = null;
}

/* Общий поток портала: события дежурного. */
function connectGlobalStream() {
  closeGlobalStream();
  if (S.authDead) return;
  const es = new EventSource("/api/events");
  S.globalStream = es;
  es.addEventListener("watch", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      S.watch = { ...S.watch, ...data };
      if (data.lastRunAt) {
        const status = $("#cornerStatus");
        if (status) status.textContent = `дежурный: ${hhmmss(data.lastRunAt)}`;
      }
      pollCorner();
    } catch {
      /* битое событие не должно ломать страницу */
    }
  });
  es.onerror = () => {
    if (S.authDead) es.close();
  };
}

function closeGlobalStream() {
  if (S.globalStream) S.globalStream.close();
  S.globalStream = null;
}

/* ------------------------------- apply ------------------------------- */

function applyRun(run) {
  S.current = run;
  $("#runStatus").textContent = `${statusLabel(run.status)} · ${run.usage.calls} вызовов · $${(run.usage.cost || 0).toFixed(4)}`;
  $("#stopRun").classList.toggle("hidden", !["running", "awaiting", "awaiting_plan"].includes(run.status));
  const pauseBtn = $("#runPause");
  if (pauseBtn) {
    const canPause = ["running", "awaiting", "awaiting_plan", "paused"].includes(run.status);
    pauseBtn.classList.toggle("hidden", !canPause);
    pauseBtn.textContent = run.status === "paused" ? "▶ Продолжить" : "⏸ Пауза";
    pauseBtn.title =
      run.status === "paused"
        ? "Продолжить прогон с той же стадии"
        : "Мягко остановить: текущий вызов модели доиграет, новые стадии не пойдут";
  }
  const zip = $("#downloadZip");
  if (zip) {
    zip.href = `/api/runs/${encodeURIComponent(run.id)}/export.zip`;
    zip.classList.remove("hidden");
  }
  $("#planTitle").textContent = run.plan ? run.plan.title : "";
  renderStages();
  renderBlocks(run);
  renderGate(run);
  renderIterate(run);
  if (run.artifacts) {
    const sig = run.artifacts.map((a) => a.path + a.mtime).join("|");
    if (sig !== S.artSig) {
      S.artSig = sig;
      renderArtifacts();
      if (S.activeArtifact && run.artifacts.some((a) => a.path === S.activeArtifact)) showArtifact(S.activeArtifact, { silent: true });
    }
  }
  if (S.tab === "mockup") renderPreview(run);
  if (S.tab === "diff" && S.diff.runId !== run.id) loadDiff(run);
  const idx = S.runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) {
    S.runs[idx] = { ...S.runs[idx], status: run.status, cost: run.usage.cost, change: run.change };
    renderRuns();
  }
  renderProjectHead();
}

function renderStages() {
  const run = S.current;
  const idx = run ? run.stageIndex : -1;
  const box = $("#stages");
  box.textContent = "";
  S.stages.forEach((s, i) => {
    const li = el("li");
    let cls = "";
    if (run && i === idx && !["done", "failed", "cancelled"].includes(run.status)) cls = "active" + (s.gate ? " gate" : "");
    else if (run && (i < idx || run.status === "done")) cls = "done";
    li.className = cls;
    li.append(el("span", "dot"), el("span", null, s.title));
    if (s.gate) li.append(el("span", "g", "гейт"));
    box.append(li);
  });
}

function renderBlocks(run) {
  const box = $("#blocks");
  box.textContent = "";
  if (!run.blocks?.length) {
    box.append(el("div", "empty", "Декомпозиция появится после первой стадии"));
    return;
  }
  const stage = S.stages[run.stageIndex];
  const canDecide =
    (S.role === "admin" || S.role === "editor") &&
    stage?.kind === "verify" &&
    ["running", "awaiting", "interrupted", "failed"].includes(run.status);
  for (const b of run.blocks) {
    const card = el("div", "block");
    card.append(el("span", "id", b.id));
    const mid = el("div");
    const titleRow = el("div", "t", b.title);
    if (b.needsRecheck) {
      // блок уже был принят, но его общий файл поправил другой блок — нужна повторная проверка
      const mark = el("span", "tag", "⚠ проверка после правок");
      mark.style.marginLeft = "7px";
      mark.style.color = "var(--warn)";
      mark.style.borderColor = "#4a3a1c";
      mark.style.background = "#211a0e";
      titleRow.append(mark);
    }
    mid.append(titleRow);
    const meta = [];
    if (b.files?.length) meta.push(`файлов: ${b.files.length}`);
    if (b.fixCount) meta.push(`правок: ${b.fixCount}`);
    if (b.test?.verdict) meta.push(`тест: ${b.test.verdict}`);
    if (Number(b.fallbacks) > 0) meta.push(`подмен модели: ${b.fallbacks}`);
    if (Number(b.rechecks) > 0) meta.push(`перепроверок: ${b.rechecks}`);
    if (b.manual?.decision) {
      meta.push(
        b.manual.decision !== "accept" ? "возвращён вручную" : b.manual.auto === true ? "принят автоматически" : "принят вручную"
      );
    }
    mid.append(el("div", "g", meta.join(" · ") || b.goal || ""));
    if (Array.isArray(b.integrityWarnings) && b.integrityWarnings.length) {
      const warn = el("div", "g", "⚠ целостность: " + b.integrityWarnings.join("; "));
      warn.style.color = "var(--warn)";
      warn.style.fontSize = "11px";
      warn.style.whiteSpace = "normal";
      mid.append(warn);
    }
    card.append(mid, el("span", "st " + b.status, b.status));
    if (canDecide) card.append(blockDecisionRow(run, b));
    box.append(card);
  }
}

function blockDecisionRow(run, block) {
  const row = el("div", "blockActs");
  const input = document.createElement("input");
  input.placeholder = block.manual?.decision === "accept" ? "комментарий (необязательно)" : "комментарий (обязателен для «в доработку»)";
  const ok = el("button", "okBtn", "принять");
  const no = el("button", "noBtn", "в доработку");
  ok.disabled = block.manual?.decision === "accept";
  ok.title = "Принять блок: статус verified, в событиях — «принят вручную»";
  no.title = "Вернуть блок в доработку: статус built, комментарий уйдёт в дефекты";
  const send = async (decision) => {
    const comment = input.value.trim();
    if (decision === "rework" && !comment) {
      input.focus();
      return;
    }
    ok.disabled = true;
    no.disabled = true;
    try {
      const { run: next } = await api(`/api/runs/${run.id}/block/${block.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision, comment }),
      });
      applyRun(next);
    } catch (err) {
      pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
      ok.disabled = block.status === "verified";
      no.disabled = false;
    }
  };
  ok.addEventListener("click", () => send("accept"));
  no.addEventListener("click", () => send("rework"));
  row.append(input, ok, no);
  return row;
}

function renderGate(run) {
  const box = $("#gate");
  box.textContent = "";

  if (run.status === "awaiting_plan") {
    box.classList.remove("hidden");
    const head = el("div", "q");
    head.append(el("b", null, "План от оркестратора"), el("span", null, " — план пишется в чате, сюда вставляется JSON"));
    const ta = el("textarea", "planBox");
    ta.placeholder = '{"title":"...","blocks":[{"id":"b1","title":"...","goal":"...","acceptance":["..."],"deps":[]}]}';
    ta.id = "planInput";
    const acts = el("div", "acts");
    const ok = el("button", "okBtn", "Применить план");
    ok.addEventListener("click", applyPlan);
    acts.append(ok);
    box.append(head, ta, acts);
    return;
  }

  if (run.status === "paused") {
    box.classList.remove("hidden");
    const head = el("div", "q");
    head.append(el("b", null, "Проект на паузе"), el("span", null, " — прогон остановлен мягко, текущий вызов модели мог доиграть."));
    const acts = el("div", "acts");
    const again = el("button", "okBtn", "Продолжить с той же стадии");
    again.addEventListener("click", () => resumeRun(run.id));
    acts.append(again);
    box.append(head, acts);
    return;
  }

  if (["interrupted", "failed"].includes(run.status)) {
    box.classList.remove("hidden");
    const head = el("div", "q");
    head.append(el("b", null, "Прогон прерван"), el("span", null, " — " + (run.error || "без причины")));
    const acts = el("div", "acts");
    const again = el("button", "okBtn", "Продолжить с текущей стадии");
    again.addEventListener("click", resumeRun);
    const zip = document.createElement("a");
    zip.className = "mini link";
    zip.textContent = "Скачать ZIP";
    zip.href = `/api/runs/${run.id}/export.zip`;
    zip.title = "Файлы проекта, README и отчёты одним архивом";
    acts.append(again, zip);
    box.append(head, acts);
    return;
  }

  if (run.status !== "awaiting" || !run.awaiting) {
    box.classList.add("hidden");
    return;
  }

  box.classList.remove("hidden");
  const head = el("div", "q");
  head.append(el("b", null, run.awaiting.title), el("span", null, " — " + run.awaiting.question));
  const ta = el("textarea");
  ta.placeholder = "Комментарий: что поправить (обязателен для отклонения)";
  ta.id = "gateComment";
  const acts = el("div", "acts");
  const ok = el("button", "okBtn", "Принять");
  const no = el("button", "noBtn", "Вернуть на доработку");
  ok.addEventListener("click", () => decide("approve"));
  no.addEventListener("click", () => decide("reject"));
  acts.append(ok, no, ta);
  box.append(head, acts, gatePreview(run));
}

/* ------------------- полный просмотр согласовываемого ------------------- */

function gateArtifactsFor(run) {
  const stageId = run.awaiting?.stageId;
  const all = (run.artifacts ?? []).map((a) => a.path);
  if (stageId === "plan") return all.filter((p) => p === "plan.md");
  if (stageId === "spec") return all.filter((p) => p.endsWith("/spec.md"));
  if (stageId === "mockup") return all.filter((p) => p === "mockup.html");
  if (stageId === "report") return all.filter((p) => p === "summary.md");
  return [];
}

function gatePreview(run) {
  const wrap = el("div");
  const files = gateArtifactsFor(run);
  if (!files.length) return wrap;

  const tabs = el("div", "gateTabs");
  const viewer = el("div", "gateViewer");

  const show = async (path) => {
    [...tabs.children].forEach((b) => b.classList.toggle("active", b.dataset.path === path));
    if (path === "mockup.html") {
      viewer.replaceChildren();
      const frame = document.createElement("iframe");
      frame.className = "gateFrame";
      frame.src = `/preview/${run.id}/mockup?v=${Date.now()}`;
      viewer.append(frame);
      viewer.style.maxHeight = "none";
      return;
    }
    viewer.style.maxHeight = "";
    viewer.textContent = "…";
    try {
      const { content } = await api(`/api/runs/${run.id}/artifact?path=${encodeURIComponent(path)}`);
      viewer.innerHTML = markdown(content);
    } catch (err) {
      viewer.textContent = "Не открылось: " + err.message;
    }
  };

  for (const path of files) {
    const tab = el("button", null, path.replace(/^blocks\//, ""));
    tab.dataset.path = path;
    tab.addEventListener("click", () => show(path));
    tabs.append(tab);
  }

  wrap.append(tabs, viewer);
  show(files[0]);
  return wrap;
}

function renderIterate(run) {
  const box = $("#iterate");
  const hasCode = (run.artifacts || []).some((a) => a.path.startsWith("work/"));
  const can = hasCode && S.project && !["running", "interrupted", "paused"].includes(run.status);
  box.classList.toggle("hidden", !can);
  if (can) {
    $("#changeInput").placeholder = `Что изменить в «${(run.plan?.title || S.project.name).slice(0, 40)}»?`;
    $("#iterateBtn").disabled = Boolean(S.project?.paused);
    if (S.project?.paused) $("#changeInput").placeholder = "Проект на паузе — сначала продолжите прогон";
  }
}

async function decide(decision) {
  const comment = $("#gateComment")?.value ?? "";
  if (decision === "reject" && !comment.trim()) {
    $("#gateComment").focus();
    return;
  }
  try {
    const { run } = await api(`/api/runs/${S.current.id}/approve`, { method: "POST", body: JSON.stringify({ decision, comment }) });
    applyRun(run);
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
  }
}

function applyProjectPauseState(project) {
  if (!project || !S.project || project.id !== S.project.id) return;
  Object.assign(S.project, {
    paused: project.paused === true,
    pausedAt: project.pausedAt ?? null,
    pausedStage: project.pausedStage ?? null,
    pausedRunId: project.pausedRunId ?? null,
  });
  S.projects = S.projects.map((p) =>
    p.id === project.id ? { ...p, paused: project.paused === true, pausedAt: project.pausedAt ?? null, pausedStage: project.pausedStage ?? null } : p
  );
  renderProjectHead();
  renderList();
}

async function pauseProjectRun(id = S.current?.id) {
  if (!id) return;
  try {
    const res = await api(`/api/runs/${id}/pause`, { method: "POST" });
    applyProjectPauseState(res.project);
    if (res.run) applyRun(res.run);
    pollTasks();
  } catch (err) {
    alert(err.message);
  }
}

async function resumeRun(id = S.current?.id) {
  if (!id) return;
  try {
    const { run, project } = await api(`/api/runs/${id}/resume`, { method: "POST" });
    applyProjectPauseState(project);
    applyRun(run);
    pollTasks();
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
  }
}

async function applyPlan() {
  const raw = $("#planInput").value.trim();
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: "План не разобрался как JSON: " + err.message });
    return;
  }
  const btn = $("#gate .okBtn");
  if (btn) btn.disabled = true;
  try {
    const { run } = await api(`/api/runs/${S.current.id}/plan`, { method: "POST", body: JSON.stringify(payload) });
    applyRun(run);
  } catch (err) {
    if (btn) btn.disabled = false;
    pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
  }
}

/* ------------------------------ preview ------------------------------ */

function renderPreview(run) {
  const sig = `${run.id}|${run.mockupAt}|${S.artSig}|${S.view}`;
  const empty = $("#previewEmpty");
  const frame = $("#preview");
  const link = $("#openPreview");

  const hasMockup = run.hasMockup;
  const hasApp = (run.artifacts || []).some((a) => a.path.startsWith("work/") && /\.html?$/i.test(a.path));
  const available = S.view === "mockup" ? hasMockup : hasApp;

  if (!available) {
    frame.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.textContent = S.view === "mockup" ? "Макет появится на стадии «Макет и дизайн»." : "Результат появится после стадии «Реализация».";
    link.style.pointerEvents = "none";
    link.style.opacity = ".4";
    return;
  }

  empty.classList.add("hidden");
  frame.classList.remove("hidden");
  link.style.pointerEvents = "";
  link.style.opacity = "1";

  const url = S.view === "mockup" ? `/preview/${run.id}/mockup` : `/preview/${run.id}/app/`;
  link.href = url;
  if (sig !== S.previewSig) {
    S.previewSig = sig;
    frame.src = `${url}?v=${encodeURIComponent(run.mockupAt || run.updatedAt || "")}`;
  }
}

function setView(view) {
  S.view = view;
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (S.current) {
    S.previewSig = "";
    renderPreview(S.current);
  }
}

/* ----------------------------- artifacts ----------------------------- */

function renderArtifacts() {
  const box = $("#artifacts");
  box.textContent = "";
  const list = S.current?.artifacts ?? [];
  if (!list.length) {
    box.append(el("div", "empty", "пока ничего"));
    return;
  }
  for (const a of list) {
    const item = el("div", "art" + (S.activeArtifact === a.path ? " active" : ""));
    item.append(el("span", null, a.path), el("span", "sz", `${(a.size / 1024).toFixed(1)}k`));
    item.addEventListener("click", () => showArtifact(a.path));
    box.append(item);
  }
}

async function showArtifact(path, { silent = false } = {}) {
  S.activeArtifact = path;
  if (!silent) renderArtifacts();
  $("#viewerTitle").textContent = path;
  $("#rawToggle").classList.remove("hidden");
  try {
    const { content } = await api(`/api/runs/${S.current.id}/artifact?path=${encodeURIComponent(path)}`);
    if (!silent) S.raw = !path.endsWith(".md");
    renderViewer(content);
  } catch (err) {
    renderViewer(`Не удалось открыть файл: ${err.message}`);
  }
}

function renderViewer(content) {
  const body = $("#viewerBody");
  if (S.raw) {
    const pre = document.createElement("pre");
    pre.textContent = content;
    body.replaceChildren(pre);
  } else {
    body.innerHTML = markdown(content);
  }
  $("#rawToggle").textContent = S.raw ? "md" : "raw";
}

/* -------------------------------- log -------------------------------- */

function pushLog(entry) {
  const box = $("#log");
  const line = el("div", entry.kind);
  line.append(el("span", "t", hhmmss(entry.at)), document.createTextNode(entry.message));
  box.append(line);
  while (box.childElementCount > 400) box.firstElementChild.remove();
  box.scrollTop = box.scrollHeight;
}

/* ------------------------- tasks and global logs ------------------------- */

async function pollTasks() {
  if (S.authDead) return;
  try {
    const { tasks } = await api("/api/tasks");
    const box = $("#tasks");
    box.textContent = "";
    if (!tasks.length) {
      box.append(el("div", "empty", "все спокойны"));
      return;
    }
    for (const t of tasks) {
      const item = el("div", "task");
      item.append(el("div", "p", t.project));
      item.append(el("div", "s " + t.status, `${statusLabel(t.status)} · ${t.stage}${t.awaiting ? " · " + t.awaiting : ""}`));
      item.addEventListener("click", async () => {
        setPage("projects");
        await selectProject(t.projectId);
        await selectRun(t.runId);
      });
      box.append(item);
    }
  } catch {
    /* сервер мог перезапускаться */
  }
}

async function pollLogs() {
  if (S.authDead) return;
  try {
    const { logs } = await api("/api/logs?limit=80");
    const box = $("#globalLog");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const visible = logs.filter((l) => new Date(l.at).getTime() > S.logCutoff).slice(0, 60);
    box.textContent = "";
    if (!visible.length) box.append(el("div", "empty", S.logCutoff ? "лог очищен — новые события появятся здесь" : "пока пусто"));
    for (const l of visible) {
      const line = el("div", l.kind);
      line.append(el("span", "t", hhmmss(l.at)), el("span", "p", (l.project ?? "").slice(0, 14)), document.createTextNode(l.message));
      box.append(line);
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch {
    /* ignore */
  }
}

/* ------------------------------- actions ------------------------------- */

async function startProject() {
  const task = $("#task").value.trim();
  const name = $("#projectName").value.trim() || task.slice(0, 60);
  if (task.length < 10) {
    $("#hint").textContent = "Опиши задачу подробнее — минимум 10 символов.";
    return;
  }
  $("#start").disabled = true;
  try {
    const { project } = await api("/api/projects", { method: "POST", body: JSON.stringify({ name, task }) });
    const { run } = await api("/api/runs", { method: "POST", body: JSON.stringify({ task, projectId: project.id }) });
    $("#task").value = "";
    $("#projectName").value = "";
    S.project = { ...project, runs: [] };
    S.runs = [{ id: run.id, status: run.status, cost: 0, change: run.change ?? null, createdAt: run.createdAt }];
    S.projects.unshift({ ...project, runs: S.runs });
    renderList();
    renderProjectHead();
    $("#composer").classList.add("hidden");
    beginRun(run);
    pollTasks();
  } catch (err) {
    $("#hint").textContent = err.message;
    $("#start").disabled = false;
  }
}

async function startIteration() {
  const change = $("#changeInput").value.trim();
  if (change.length < 5) {
    $("#changeInput").focus();
    return;
  }
  if (!S.current || !S.project) return;
  if (S.project.paused) {
    alert("Проект на паузе — сначала продолжите прогон, потом запускайте доработку.");
    return;
  }
  const btn = $("#iterateBtn");
  btn.disabled = true;
  try {
    const { run } = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({ task: S.project.task, projectId: S.project.id, baseRunId: S.current.id, change }),
    });
    S.runs.unshift({ id: run.id, status: run.status, cost: 0, change: run.change, createdAt: run.createdAt });
    renderRuns();
    beginRun(run);
    $("#changeInput").value = "";
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
  } finally {
    btn.disabled = false;
  }
}

function beginRun(run) {
  S.lastSeq = 0;
  S.artSig = "";
  S.previewSig = "";
  $("#log").textContent = "";
  closeStream();
  applyRun(run);
  connectStream(run.id);
}

/* -------------------------------- tabs -------------------------------- */

function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll("#tabs button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#tabFlow").classList.toggle("hidden", tab !== "flow");
  $("#tabMockup").classList.toggle("hidden", tab !== "mockup");
  $("#tabFiles").classList.toggle("hidden", tab !== "files");
  $("#tabDiff").classList.toggle("hidden", tab !== "diff");
  if (tab === "mockup" && S.current) {
    S.previewSig = "";
    renderPreview(S.current);
  }
  if (tab === "diff" && S.current) loadDiff(S.current);
}

/* ------------------------------ markdown ------------------------------ */

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function markdown(src) {
  const lines = esc(src).split(/\r?\n/);
  const out = [];
  let inCode = false;
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      closeList();
      out.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${h[2]}</h${h[1].length}>`);
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) {
      out.push("");
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

const inline = (s) =>
  s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>");

/* ------------------------------ дифф версий ------------------------------ */

function renderDiffSummary(d) {
  const box = $("#diffSummary");
  box.textContent = "";
  const head = el("div", null, d.base.id.slice(-4) + " → " + d.current.id.slice(-4));
  const stats = el("div");
  stats.innerHTML = `файлов: <b>${d.summary.files}</b> · <span class="plus">+${d.summary.added}</span> · <span class="minus">−${d.summary.removed}</span>`;
  box.append(head, stats);
  if (d.current.change) box.append(el("div", "dim", "изменение: " + d.current.change.slice(0, 90)));
}

function renderDiffList(d) {
  const box = $("#diffList");
  box.textContent = "";
  if (!d.files.length) {
    box.append(el("div", "empty", "изменений нет"));
    return;
  }
  for (const f of d.files) {
    const item = el("div", "art" + (S.diff.file === f.path ? " active" : ""));
    item.append(el("span", null, f.path));
    item.append(el("span", "plus", "+" + f.added), el("span", "minus", "−" + f.removed));
    item.addEventListener("click", () => selectDiffFile(f.path));
    box.append(item);
  }
}

function selectDiffFile(path) {
  S.diff.file = path;
  renderDiffList(S.diff.data);
  const file = S.diff.data.files.find((f) => f.path === path);
  $("#diffTitle").textContent = `${path} · ${file.status}`;
  renderDiffHunks(file);
}

function renderDiffHunks(file) {
  const box = $("#diffBody");
  box.textContent = "";
  const only = $("#onlyChanges").checked;
  let oldNo = 1;
  let newNo = 1;
  let gap = 0;

  const flushGap = () => {
    if (gap > 0) box.append(el("div", "dl meta", `… ${gap} строк без изменений …`));
    gap = 0;
  };

  for (const h of file.hunks) {
    if (h.type === "ctx") {
      if (only) {
        gap++;
        oldNo++;
        newNo++;
        continue;
      }
      flushGap();
      box.append(diffLine("ctx", oldNo++, h.text, newNo++));
      continue;
    }
    flushGap();
    if (h.type === "add") box.append(diffLine("add", "", h.text, newNo++));
    else if (h.type === "del") box.append(diffLine("del", oldNo++, h.text, ""));
    else box.append(el("div", "dl meta", h.text));
  }
  if (only && gap > 0) flushGap();
}

function diffLine(kind, ln, text, newLn) {
  const row = el("div", "dl " + kind);
  row.append(el("span", "sign", kind === "add" ? "+" : kind === "del" ? "−" : " "));
  row.append(el("span", "ln", String(ln || "")));
  row.append(el("span", "txt", text));
  void newLn;
  return row;
}

function fillDiffBase(run, baseId) {
  const sel = $("#diffBase");
  sel.textContent = "";
  const others = (S.runs ?? []).filter((r) => r.id !== run.id);
  if (!others.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "не с чем сравнивать";
    sel.append(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const r of others) {
    const o = document.createElement("option");
    o.value = r.id;
    o.textContent = `с: ${r.change ? r.change.slice(0, 30) : "версия " + r.id.slice(-4)}`;
    sel.append(o);
  }
  const preferred = baseId ?? (others.some((r) => r.id === run.baseId) ? run.baseId : others[0].id);
  sel.value = preferred;
  sel.onchange = () => loadDiff(run, sel.value);
}

async function loadDiff(run, baseId = null) {
  const box = $("#diffList");
  $("#diffSummary").textContent = "считаю…";
  box.textContent = "";
  $("#diffBody").textContent = "";
  $("#diffTitle").textContent = "—";
  fillDiffBase(run, baseId);
  try {
    const qs = baseId ? `?base=${encodeURIComponent(baseId)}` : "";
    const d = await api(`/api/runs/${run.id}/diff${qs}`);
    S.diff = { runId: run.id, data: d, file: null };
    renderDiffSummary(d);
    renderDiffList(d);
    if (d.files[0]) selectDiffFile(d.files[0].path);
    else {
      $("#diffSummary").textContent = "";
      $("#diffTitle").textContent = "изменений нет";
    }
  } catch (err) {
    S.diff = { runId: run.id, data: null, file: null };
    $("#diffSummary").textContent = "";
    $("#diffTitle").textContent = "сравнивать не с чем";
    $("#diffBody").textContent = err.message;
    box.append(el("div", "empty", "это первая версия проекта"));
  }
}

/* --------------------------- угловой чат --------------------------- */

const CORNER_TABS = [
  ["critical", "Критичное", "ошибок и падений нет"],
  ["notice", "Оповещения", "гейтов и завершений нет"],
  ["chat", "Чат", "напиши Харнессу — начнём переписку"],
];

function cornerTabMeta(tab) {
  return CORNER_TABS.find(([id]) => id === tab) ?? CORNER_TABS[0];
}

function applyCornerSummary(tabs, unread) {
  if (tabs && typeof tabs === "object") S.corner.tabs = tabs;
  if (Number.isFinite(Number(unread))) S.corner.unread = Number(unread);
  renderCornerCounts();
}

function renderCornerCounts() {
  const tabs = S.corner.tabs ?? {};
  for (const [id] of CORNER_TABS) {
    const count = tabs[id]?.unread ?? 0;
    document.querySelectorAll(`[data-ctab-count="${id}"]`).forEach((node) => {
      node.textContent = count > 99 ? "99+" : String(count);
      node.classList.toggle("zero", !count);
    });
  }
  document.querySelectorAll("#cornerTabs button").forEach((b) => b.classList.toggle("active", b.dataset.ctab === S.corner.tab));
  const badge = $("#cornerBadge");
  if (badge) {
    const total = Number(S.corner.unread ?? 0);
    badge.classList.toggle("hidden", total === 0);
    badge.textContent = total > 99 ? "99+" : String(total);
  }
}

async function pollCorner() {
  if (S.authDead) return;
  try {
    const [mb, al] = await Promise.all([api("/api/mailbox?limit=200"), api("/api/alerts")]);
    S.corner.items = mb.items ?? [];
    S.corner.tabs = mb.tabs ?? {};
    S.corner.unread = mb.unread ?? 0;
    S.corner.alerts = al.alerts ?? [];
    renderCornerCounts();
    if (!$("#cornerPanel").classList.contains("hidden")) renderCorner();
  } catch {
    /* сервер занят */
  }
}

function renderCorner() {
  const tab = S.corner.tab;
  const [, title, emptyText] = cornerTabMeta(tab);
  const box = $("#cornerLog");
  box.textContent = "";
  const items = (S.corner.items ?? []).filter((m) => (m.tab ?? "notice") === tab).slice(-60);
  for (const m of items) {
    const node = el("div", "cmsg " + m.from + (m.level ? " " + m.level : "") + (m.read ? "" : " unread"), m.text);
    const who = m.from === "user" ? "ты" : m.from === "harness" ? "харнесс" : m.from === "assistant" ? "ассистент портала" : "портал";
    node.prepend(el("span", "who", `${who} · ${hhmmss(m.at)}`));
    if (!m.read && canWrite()) {
      const read = el("button", "mini cmsgRead", "прочитать");
      read.title = "Отметить это сообщение прочитанным";
      read.addEventListener("click", () => markCornerRead(m.id));
      node.append(read);
    }
    box.append(node);
  }
  if (!items.length) box.append(el("div", "empty", emptyText));

  // Живые алерты наблюдателя не входят в счётчики: это условие, а не письмо.
  // Показываем их в подходящей вкладке, но не дублируем те, что уже есть в почте.
  const alertsBox = $("#cornerAlerts");
  if (alertsBox) {
    alertsBox.textContent = "";
    const live = (S.corner.alerts ?? []).filter(
      (a) => (a.tab ?? (a.level === "bad" || a.level === "error" ? "critical" : "notice")) === tab && !items.some((m) => m.text === a.text)
    );
    alertsBox.classList.toggle("hidden", live.length === 0);
    if (live.length) {
      alertsBox.append(el("div", "caHead", "наблюдатель · не в счётчике"));
      for (const a of live) alertsBox.append(el("div", "alert " + (a.level === "bad" ? "bad" : ""), a.text));
    }
  }

  const info = $("#cornerTabInfo");
  if (info) info.textContent = `${title.toLowerCase()} · ${items.length} сообщ.`;
  document.querySelectorAll("#cornerTabs button").forEach((b) => b.classList.toggle("active", b.dataset.ctab === tab));
  box.scrollTop = box.scrollHeight;
}

function setCornerTab(tab) {
  if (!CORNER_TABS.some(([id]) => id === tab)) return;
  S.corner.tab = tab;
  renderCorner();
}

async function markCornerRead(id) {
  if (!id || !canWrite()) return;
  try {
    const res = await api("/api/mailbox/read", { method: "POST", body: JSON.stringify({ ids: [id] }) });
    applyCornerSummary(res.tabs, res.unread);
    await pollCorner();
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
  }
}

async function readCornerTab() {
  if (!canWrite()) return;
  const tab = S.corner.tab;
  try {
    const res = await api("/api/mailbox/read", { method: "POST", body: JSON.stringify({ tab }) });
    applyCornerSummary(res.tabs, res.unread);
    await pollCorner();
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
  }
}

async function clearCornerTab() {
  if (!canWrite()) return;
  const tab = S.corner.tab;
  const [, title] = cornerTabMeta(tab);
  if (tab === "critical") {
    if (!confirm(`Удалить все сообщения вкладки «${title}»? Это ошибки, падения и остановки.`)) return;
    if (!confirm("Точно удалить критичные сообщения? Отменить это будет нельзя.")) return;
  } else if (!confirm(`Очистить вкладку «${title}»? Сообщения удалятся безвозвратно.`)) {
    return;
  }
  try {
    const res = await api("/api/mailbox/clear", { method: "POST", body: JSON.stringify({ tab }) });
    applyCornerSummary(res.tabs, res.unread);
    await pollCorner();
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
  }
}

async function sendCorner() {
  const input = $("#cornerInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  $("#cornerSend").disabled = true;
  try {
    await api("/api/mailbox", { method: "POST", body: JSON.stringify({ text, from: "user" }) });
    const reply = await api("/api/assistant", { method: "POST", body: JSON.stringify({ question: text }) }).catch(() => null);
    if (reply?.answer) await api("/api/mailbox", { method: "POST", body: JSON.stringify({ text: reply.answer, from: "assistant" }) });
    S.corner.tab = "chat";
    await pollCorner();
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
  } finally {
    $("#cornerSend").disabled = false;
  }
}

async function renderHarnessSettings(a) {
  const box = $("#agentEditor");
  let harness;
  try {
    ({ harness } = await api("/api/harness"));
  } catch {
    return;
  }
  if (S.editingAgent?.id !== a.id) return;

  const card = el("div", "card");
  card.append(el("div", "sectionTitle", "Когда будить Харнесса"));
  card.append(el("div", "dim", "Галочки: на какие события он получает сообщение в угловой чат. Решение по-прежнему за тобой."));

  const labels = {
    projectStart: "старт проекта или доработки",
    gateAwaiting: "прогон ждёт согласования",
    stageDone: "стадия завершена",
    runFinished: "прогон закончен",
    agentError: "ошибка агента",
    slowCall: "агент думает дольше порога",
  };
  const triggers = { ...(harness.triggers ?? {}) };
  for (const [key, label] of Object.entries(labels)) {
    const row = el("label", "chk");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = Boolean(triggers[key]);
    cb.addEventListener("change", () => (triggers[key] = cb.checked));
    row.append(cb, el("span", null, label));
    card.append(row);
  }

  const thresholds = { ...(harness.thresholds ?? {}) };
  const grid = el("div", "grid2");
  const mk = (title, key, scale = 1) => {
    const l = el("label", "label", title);
    const i = document.createElement("input");
    i.type = "number";
    i.value = String((thresholds[key] ?? 0) / scale);
    i.addEventListener("input", () => (thresholds[key] = Number(i.value) * scale));
    l.append(i);
    grid.append(l);
  };
  mk("долгий ответ, сек", "slowCallMs", 1000);
  mk("зависло, мин", "stuckMinutes");
  mk("дневной лимит, $", "dailyBudget");
  card.append(grid);

  const save = el("button", "primary", "Сохранить триггеры");
  save.dataset.write = "";
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api("/api/harness", { method: "POST", body: JSON.stringify({ triggers, thresholds }) });
      save.textContent = "Сохранено";
      pollCorner();
    } catch (err) {
      save.textContent = "Ошибка: " + err.message;
    } finally {
      setTimeout(() => {
        save.disabled = false;
        save.textContent = "Сохранить триггеры";
      }, 1500);
    }
  });
  card.append(save);
  box.append(card);
}

/* ------------------------------ wiring ------------------------------ */

$("#loginForm").addEventListener("submit", submitLogin);
$("#logoutBtn").addEventListener("click", submitLogout);

document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => setPage(b.dataset.page)));
$("#start").addEventListener("click", startProject);
$("#task").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") startProject();
});
$("#iterateBtn").addEventListener("click", startIteration);
$("#changeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startIteration();
});
$("#clearLog").addEventListener("click", () => ($("#log").textContent = ""));
$("#rawToggle").addEventListener("click", () => {
  S.raw = !S.raw;
  if (S.activeArtifact) showArtifact(S.activeArtifact);
});
$("#reloadPreview").addEventListener("click", () => {
  if (S.current) {
    S.previewSig = "";
    renderPreview(S.current);
  }
});
document.querySelectorAll("#tabs button[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
document.querySelectorAll("#assistTabs button").forEach((b) => b.addEventListener("click", () => setAssistTab(b.dataset.atab)));
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("#onlyChanges").addEventListener("change", () => {
  const file = S.diff.data?.files.find((f) => f.path === S.diff.file);
  if (file) renderDiffHunks(file);
});
$("#stopRun").addEventListener("click", async () => {
  if (!S.current) return;
  if (!confirm("Остановить прогон? Текущий вызов модели доиграет, дальше стадии не пойдут.")) return;
  try {
    const { run } = await api(`/api/runs/${S.current.id}/cancel`, { method: "POST" });
    applyRun(run);
    pollTasks();
  } catch (err) {
    pushLog({ at: new Date().toISOString(), kind: "error", message: err.message });
  }
});
$("#askBtn").addEventListener("click", ask);
$("#clearGlobalLog").addEventListener("click", () => {
  S.logCutoff = Date.now();
  $("#globalLog").textContent = "";
  pollLogs();
});
$("#askInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") ask();
});

$("#searchBtn").addEventListener("click", runSearch);
$("#searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
$("#galleryRefresh").addEventListener("click", () => loadGallery());
document.addEventListener("click", () => {
  document.querySelectorAll(".itemMenu:not(.hidden)").forEach((m) => m.classList.add("hidden"));
});
$("#galleryFilter").addEventListener("input", () => {
  clearTimeout(galleryTimer);
  galleryTimer = setTimeout(() => loadGallery(), 220);
});
$("#galleryFilter").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(galleryTimer);
    loadGallery();
  }
});
$("#imgSend").addEventListener("click", sendStudio);
$("#studioClear").addEventListener("click", async () => {
  if (!confirm("Очистить чат? Картинки останутся в файлах, история переписки пропадёт.")) return;
  try {
    const { thread } = await api("/api/studio/clear", { method: "POST", body: JSON.stringify({ sessionId: S.studio.activeId }) });
    S.studio.thread = thread ?? [];
    renderThread();
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
});
$("#imgPrompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendStudio();
  }
});
$("#imgFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    $("#studioInfo").innerHTML = '<span class="spin"></span> загружаю…';
    try {
      const { item } = await api("/api/studio/upload", { method: "POST", body: JSON.stringify({ data: String(reader.result) }) });
      S.studio.refItem = item;
      S.studio.refData = null;
      renderChip();
      $("#studioInfo").textContent = "референс прикреплён";
      $("#imgPrompt").placeholder = "Что сделать с этой картинкой? Например: «сделай её в стиле гравюры»";
    } catch (err) {
      $("#studioInfo").textContent = err.message;
    }
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});

$("#runPause").addEventListener("click", () => {
  if (!S.current) return;
  if (S.current.status === "paused") resumeRun(S.current.id);
  else pauseProjectRun(S.current.id);
});

$("#cornerBtn").addEventListener("click", async () => {
  const panel = $("#cornerPanel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) {
    renderCorner();
    $("#cornerInput").focus();
    await pollCorner();
    setTimeout(pollCorner, 800);
  }
});
$("#cornerClose").addEventListener("click", () => $("#cornerPanel").classList.add("hidden"));
document.querySelectorAll("#cornerTabs button").forEach((b) => {
  b.addEventListener("click", () => setCornerTab(b.dataset.ctab));
});
$("#cornerReadAll").addEventListener("click", readCornerTab);
$("#cornerClear").addEventListener("click", clearCornerTab);
$("#cornerSend").addEventListener("click", sendCorner);
$("#cornerInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendCorner();
});

boot();
