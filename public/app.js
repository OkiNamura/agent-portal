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
  tab: "flow",
  view: "mockup",
};

const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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
    setInterval(pollTasks, 4000);
    setInterval(pollLogs, 6000);
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
  $("#pageAssistant").classList.toggle("hidden", page !== "assistant");
  renderList();
  if (page === "stats") loadStats();
  if (page === "assistant") {
    renderChat();
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

  const head = el("div", "listHead");
  head.append(el("span", null, "Разделы"));
  box.append(head);
  for (const [label, anchor] of [["Расход", "#statsBody"], ["Модели", "#statsBody"]]) {
    const item = el("div", "item");
    const txt = el("div", "txt");
    txt.append(el("div", "n", label), el("div", "m", "сводка"));
    item.append(txt);
    item.addEventListener("click", () => document.querySelector(anchor)?.scrollIntoView({ behavior: "smooth" }));
    box.append(item);
  }
}

/* ------------------------------ ассистент ------------------------------ */

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
  if (!S.models.length && !S.modelsTried) {
    S.modelsTried = true;
    loadModels().then(() => {
      if (S.models.length && S.editingAgent?.id === a.id) renderAgentEditor();
    });
  }
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
    box.append(cards);

    if (stats.byModel.length) {
      box.append(el("div", "sectionTitle", "По моделям"));
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
      box.append(el("div", "sectionTitle", "По проектам"));
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
      box.append(el("div", "sectionTitle", "По дням"));
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
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#tabFlow").classList.toggle("hidden", tab !== "flow");
  $("#tabMockup").classList.toggle("hidden", tab !== "mockup");
  $("#tabFiles").classList.toggle("hidden", tab !== "files");
  if (tab === "mockup" && S.current) {
    S.previewSig = "";
    renderPreview(S.current);
  }
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
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
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

boot();
