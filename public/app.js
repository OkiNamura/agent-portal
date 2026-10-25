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
  studio: { thread: [], models: [], sessions: [], activeId: null, refItem: null, refData: null, lastText: "" },
  corner: { items: [], unread: 0, alerts: [] },
  diff: { runId: null, data: null, file: null },
  tab: "flow",
  view: "mockup",
};

const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
};

const hhmmss = (iso) => (iso ? new Date(iso) : new Date()).toTimeString().slice(0, 8);
const statusLabel = (s) =>
  ({ running: "идёт", awaiting: "ждёт", awaiting_plan: "нужен план", done: "готов", failed: "ошибка", cancelled: "стоп", interrupted: "прерван" }[s] || s);

/* ------------------------------- boot ------------------------------- */

async function boot() {
  try {
    const st = await api("/api/state");
    S.mode = st.mode;
    S.agentsFile = st.agents;
    S.pipelineFile = st.pipeline;
    S.agents = st.agents.agents;
    S.stages = st.pipeline.stages.filter((s) => s.enabled !== false);
    S.projects = st.projects ?? [];
    renderMode(st);
    setPage("projects");
    if (S.projects[0]) await selectProject(S.projects[0].id);
    else newProjectMode();
    pollTasks();
    pollLogs();
    pollCorner();
    setInterval(pollTasks, 4000);
    setInterval(pollLogs, 6000);
    setInterval(pollCorner, 20000);
  } catch (err) {
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
  $("#pageKeys").classList.toggle("hidden", page !== "keys");
  $("#pageSearch").classList.toggle("hidden", page !== "search");
  $("#pageAssistant").classList.toggle("hidden", page !== "assistant");
  renderList();
  if (page === "stats") loadStats();
  if (page === "studio") loadStudio();
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
    const add = el("button", "mini", "+");
    add.title = "Новый проект";
    add.addEventListener("click", newProjectMode);
    head.append(broom, add);
    box.append(head);

    if (!S.projects.length) box.append(el("div", "empty", "пока нет проектов"));
    for (const p of S.projects) {
      const last = p.runs?.[0];
      const item = el("div", "item" + (S.project?.id === p.id ? " active" : ""));
      const txt = el("div", "txt");
      const n = el("div", "n");
      n.append(dot(last?.status), el("span", null, p.name));
      txt.append(n, el("div", "m", `${p.runs?.length ?? 0} верс. · ${statusLabel(last?.status ?? "—")}`));
      const kill = el("button", "kill", "✕");
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
    head.append(el("span", null, "Чаты"));
    const addImg = el("button", "mini", "+");
    addImg.title = "Новый чат картинок";
    addImg.addEventListener("click", () => createSession("images"));
    const addDoc = el("button", "mini", "📄");
    addDoc.title = "Новый чат документов";
    addDoc.addEventListener("click", () => createSession("docs"));
    head.append(addDoc, addImg);
    box.append(head);

    if (!S.studio.sessions.length) box.append(el("div", "empty", "пока нет чатов"));
    for (const s of S.studio.sessions) {
      const item = el("div", "item" + (s.id === S.studio.activeId ? " active" : ""));
      const txt = el("div", "txt");
      txt.append(el("div", "n", s.name), el("div", "m", `${s.kind === "images" ? "картинки" : s.kind} · сообщений: ${s.messages}`));
      const kill = el("button", "kill", "✕");
      kill.title = "Удалить чат";
      kill.addEventListener("click", (e) => {
        e.stopPropagation();
        removeSession(s);
      });
      item.append(txt, kill);
      item.addEventListener("click", () => switchSession(s.id));
      item.addEventListener("dblclick", () => renameSession(s));
      box.append(item);
    }
    return;
  }

  if (S.page === "stats") {
    const head = el("div", "listHead");
    head.append(el("span", null, "Разделы"));
    box.append(head);
    for (const [label, anchor] of [["Расход", "statsCost"], ["Модели", "statsModels"], ["Проекты", "statsProjects"], ["Агенты", "statsAgents"], ["Дни", "statsDays"]]) {
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
    const { sessions, activeId } = await api("/api/studio/sessions");
    S.studio.sessions = sessions ?? [];
    const keep = S.studio.activeId && S.studio.sessions.some((s) => s.id === S.studio.activeId);
    S.studio.activeId = keep ? S.studio.activeId : activeId ?? S.studio.sessions[0]?.id;
    await loadThread();
    renderList();
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
}

async function loadThread() {
  const sid = S.studio.activeId;
  if (!sid) return;
  const { thread } = await api(`/api/studio/thread?session=${encodeURIComponent(sid)}`);
  if (S.studio.activeId !== sid) return; // успели переключиться — чужой ответ не применяем
  S.studio.thread = thread ?? [];
  renderThread();
}

function switchSession(id) {
  S.studio.activeId = id;
  S.studio.refItem = null;
  S.studio.refData = null;
  renderChip();
  renderList();
  loadThread().catch((err) => ($("#studioInfo").textContent = err.message));
}

async function newSession() {
  await createSession("images");
}

async function createSession(kind) {
  const name = prompt(kind === "docs" ? "Название чата документов" : "Название чата картинок", kind === "docs" ? "Документы" : "Новый чат");
  if (name == null) return;
  try {
    const j = await api("/api/studio/sessions", { method: "POST", body: JSON.stringify({ name, kind }) });
    S.studio.sessions = j.sessions;
    S.studio.activeId = j.activeId;
    renderList();
    await loadThread();
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
}

async function renameSession(s) {
  const name = prompt("Новое название чата", s.name);
  if (name == null) return;
  try {
    await api(`/api/studio/sessions/${s.id}`, { method: "POST", body: JSON.stringify({ name }) });
    const { sessions } = await api("/api/studio/sessions");
    S.studio.sessions = sessions;
    renderList();
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
}

async function removeSession(s) {
  if (!confirm(`Удалить чат «${s.name}»? Картинки останутся в файлах.`)) return;
  try {
    const j = await api(`/api/studio/sessions/${s.id}`, { method: "DELETE" });
    S.studio.sessions = j.sessions;
    S.studio.activeId = j.activeId;
    renderList();
    await loadThread();
  } catch (err) {
    $("#studioInfo").textContent = err.message;
  }
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
  const isDocs = kind === "docs";

  $("#imgPrompt").placeholder = isDocs
    ? "Вставь текст документа — редактор вычитает или приведёт в порядок…"
    : "Опиши, что хочешь — художник перепишет это в промт и покажет, что отправит";
  $("#imgSend").textContent = isDocs ? "Вычитать" : "Художник";
  const directLabel = $("#imgDirect")?.closest("label");
  if (directLabel) directLabel.style.display = isDocs ? "none" : "";

  if (kind === "decks") {
    box.append(el("div", "empty", "Чат «презентации» ещё в разработке — сейчас работают картинки и документы."));
    return;
  }

  if (!S.studio.thread.length) {
    box.append(
      el(
        "div",
        "empty",
        isDocs
          ? "Вставь текст — редактор приведёт его в порядок. Короткий запрос он может переписать, большой документ только вычитает: орфография и разметка, без изменения смысла."
          : "Опиши, что хочешь — художник перепишет это в промт, покажет, что отправит, и нарисует после твоего «Отправить»."
      )
    );
    return;
  }

  const results = S.studio.thread.filter((m) => m.role === "result" || m.role === "doc");
  const spent = results.reduce((s, m) => s + (m.cost || 0), 0);
  $("#studioInfo").textContent = `${isDocs ? "документов" : "картинок"}: ${results.length} · потрачено $${spent.toFixed(3)}`;

  for (const msg of S.studio.thread) {
    if (msg.role === "user") box.append(userBubble(msg));
    else if (msg.role === "proposal" && !isDocs) box.append(proposalCard(msg));
    else if (msg.role === "result") box.append(resultCard(msg));
    else if (msg.role === "doc") box.append(docCard(msg));
  }
  box.scrollTop = box.scrollHeight;
}

function docCard(msg) {
  const card = el("div", "docCard");
  const head = el("div", "docHead");
  head.append(el("b", null, msg.title || "Документ"));
  head.append(el("span", "tag", msg.mode === "correct" ? "корректор" : "помощник"));
  card.append(head);

  if (msg.reasoning) {
    const d = document.createElement("details");
    d.className = "reasoning";
    const s = document.createElement("summary");
    s.textContent = "что сделал редактор";
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
    el("span", null, new Date(msg.at).toLocaleString("ru-RU"))
  );
  card.append(meta);

  const md = document.createElement("a");
  md.className = "mini link";
  md.textContent = "скачать .md";
  md.href = `/api/studio/doc/${msg.id}.md`;

  const docx = document.createElement("a");
  docx.className = "mini link";
  docx.textContent = "скачать .docx";
  docx.href = `/api/studio/doc/${msg.id}.docx`;

  card.append(actionsRow([smallBtn("удалить", "Убрать документ и всё после него", () => truncateAt(msg)), md, docx]));
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
      await studioCall("/api/studio/edit", { id: msg.id, text });
      if (sess?.kind === "docs") await studioCall("/api/studio/doc", { text });
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

  if (sess?.kind === "docs") {
    btn.disabled = true;
    $("#studioInfo").innerHTML = '<span class="spin"></span> редактор работает…';
    try {
      await studioCall("/api/studio/doc", { text });
      $("#imgPrompt").value = "";
      renderThread();
    } catch (err) {
      $("#studioInfo").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
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
  const map = { done: "var(--ok)", failed: "var(--bad)", cancelled: "var(--bad)", interrupted: "var(--bad)", awaiting: "var(--warn)", awaiting_plan: "var(--warn)", running: "var(--accent)" };
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
  const del = el("button", "mini danger", "удалить проект");
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
}

function closeStream() {
  if (S.stream) S.stream.close();
  S.stream = null;
}

/* ------------------------------- apply ------------------------------- */

function applyRun(run) {
  S.current = run;
  $("#runStatus").textContent = `${statusLabel(run.status)} · ${run.usage.calls} вызовов · $${(run.usage.cost || 0).toFixed(4)}`;
  $("#stopRun").classList.toggle("hidden", !["running", "awaiting", "awaiting_plan"].includes(run.status));
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
  for (const b of run.blocks) {
    const card = el("div", "block");
    card.append(el("span", "id", b.id));
    const mid = el("div");
    mid.append(el("div", "t", b.title));
    const meta = [];
    if (b.files?.length) meta.push(`файлов: ${b.files.length}`);
    if (b.fixCount) meta.push(`правок: ${b.fixCount}`);
    if (b.test?.verdict) meta.push(`тест: ${b.test.verdict}`);
    mid.append(el("div", "g", meta.join(" · ") || b.goal || ""));
    card.append(mid, el("span", "st " + b.status, b.status));
    box.append(card);
  }
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

  if (["interrupted", "failed"].includes(run.status)) {
    box.classList.remove("hidden");
    const head = el("div", "q");
    head.append(el("b", null, "Прогон прерван"), el("span", null, " — " + (run.error || "без причины")));
    const acts = el("div", "acts");
    const again = el("button", "okBtn", "Продолжить с текущей стадии");
    again.addEventListener("click", resumeRun);
    acts.append(again);
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
  const can = hasCode && S.project && !["running", "interrupted"].includes(run.status);
  box.classList.toggle("hidden", !can);
  if (can) $("#changeInput").placeholder = `Что изменить в «${(run.plan?.title || S.project.name).slice(0, 40)}»?`;
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

async function resumeRun() {
  try {
    const { run } = await api(`/api/runs/${S.current.id}/resume`, { method: "POST" });
    applyRun(run);
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

async function pollCorner() {
  try {
    const [mb, al] = await Promise.all([api("/api/mailbox?limit=60"), api("/api/alerts")]);
    S.corner = { items: mb.items ?? [], unread: mb.unread ?? 0, alerts: al.alerts ?? [] };
    const badge = $("#cornerBadge");
    const total = (S.corner.unread ?? 0) + (S.corner.alerts ?? []).length;
    badge.classList.toggle("hidden", total === 0);
    badge.textContent = total > 99 ? "99+" : String(total);
    if (!$("#cornerPanel").classList.contains("hidden")) renderCorner();
  } catch {
    /* сервер занят */
  }
}

function renderCorner() {
  const box = $("#cornerLog");
  box.textContent = "";
  for (const m of S.corner.items.slice(-40)) {
    const node = el("div", "cmsg " + m.from, m.text);
    const who = m.from === "user" ? "ты" : m.from === "harness" ? "харнесс" : m.from === "assistant" ? "ассистент портала" : "портал";
    node.prepend(el("span", "who", `${who} · ${hhmmss(m.at)}`));
    box.append(node);
  }
  if (!S.corner.items.length) box.append(el("div", "empty", "тут появятся события портала и наша переписка"));

  const alerts = $("#cornerAlerts");
  alerts.textContent = "";
  for (const a of S.corner.alerts) alerts.append(el("div", "alert " + (a.level === "bad" ? "bad" : ""), a.text));
  box.scrollTop = box.scrollHeight;
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

$("#cornerBtn").addEventListener("click", async () => {  const panel = $("#cornerPanel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) {
    renderCorner();
    $("#cornerInput").focus();
    await pollCorner();
    const shown = (S.corner.items ?? []).slice(-40).map((m) => m.id);
    if (shown.length) api("/api/mailbox/read", { method: "POST", body: JSON.stringify({ ids: shown }) }).catch(() => {});
    setTimeout(pollCorner, 800);
  }
});
$("#cornerClose").addEventListener("click", () => $("#cornerPanel").classList.add("hidden"));
$("#cornerSend").addEventListener("click", sendCorner);
$("#cornerInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendCorner();
});

boot();
