import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SKIP = new Set(["state.json", "events.jsonl"]);

export function makeRunId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

export function safeRel(rel) {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("Пустой путь");
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) throw new Error(`Абсолютный путь запрещён: ${rel}`);
  const parts = norm.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error(`Выход за пределы каталога запрещён: ${rel}`);
  return parts.join("/");
}

export class Store {
  constructor(root) {
    this.root = root;
    this.runsDir = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.join(root, "runs");
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.cache = new Map();
  }

  runDir(id) {
    return path.join(this.runsDir, id);
  }

  create(task, { base = null, change = "", projectId = null } = {}) {
    const id = makeRunId();
    const dir = this.runDir(id);
    fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    const run = {
      id,
      task,
      change: change || null,
      baseId: base?.id ?? null,
      projectId: projectId ?? base?.projectId ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      stageIndex: 0,
      awaiting: null,
      blocks: [],
      workspace: base?.workspace ? { ...base.workspace } : {},
      plan: null,
      approvals: {},
      stageMeta: {},
      usage: { prompt: 0, completion: 0, cost: 0, calls: 0 },
      error: null,
      eventSeq: 0,
      events: [],
    };
    // carry the project files over so the coder edits an existing project instead of starting from zero
    for (const [rel, content] of Object.entries(run.workspace)) {
      this.writeArtifact(run, `work/${rel}`, content);
    }
    this.save(run);
    return run;
  }

  save(run) {
    run.updatedAt = new Date().toISOString();
    this.cache.set(run.id, run);
    const file = path.join(this.runDir(run.id), "state.json");
    // атомарно: сначала tmp, потом rename — иначе обрыв питания оставит обрезанный JSON
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...run, events: undefined }, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return run;
  }

  load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    if (!/^[\w.-]+$/.test(id)) throw new Error("Некорректный id прогона");
    const file = path.join(this.runDir(id), "state.json");
    if (!fs.existsSync(file)) throw new Error(`Прогон ${id} не найден`);
    const run = JSON.parse(fs.readFileSync(file, "utf8"));
    run.events = this.readEvents(id);
    this.cache.set(id, run);
    return run;
  }

  list() {
    if (!fs.existsSync(this.runsDir)) return [];
    return fs
      .readdirSync(this.runsDir)
      .filter((id) => fs.existsSync(path.join(this.runsDir, id, "state.json")))
      .map((id) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.runsDir, id, "state.json"), "utf8"));
          return { id: s.id, task: s.task, status: s.status, createdAt: s.createdAt, cost: s.usage?.cost ?? 0 };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  event(run, ev) {
    run.eventSeq = (run.eventSeq ?? 0) + 1;
    const entry = { seq: run.eventSeq, at: new Date().toISOString(), ...ev };
    run.events.push(entry);
    if (run.events.length > 4000) run.events.splice(0, run.events.length - 4000);
    fs.appendFileSync(path.join(this.runDir(run.id), "events.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  readEvents(id) {
    const file = path.join(this.runDir(id), "events.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  writeArtifact(run, rel, content) {
    const clean = safeRel(rel);
    const full = path.join(this.runDir(run.id), "artifacts", clean);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    return clean;
  }

  readArtifact(run, rel) {
    const clean = safeRel(rel);
    const full = path.join(this.runDir(run.id), "artifacts", clean);
    if (!fs.existsSync(full)) throw new Error(`Артефакт не найден: ${rel}`);
    return fs.readFileSync(full, "utf8");
  }

  listArtifacts(run) {
    const base = path.join(this.runDir(run.id), "artifacts");
    const out = [];
    const walk = (dir, prefix = "") => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (!SKIP.has(entry.name)) {
          const st = fs.statSync(path.join(dir, entry.name));
          out.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() });
        }
      }
    };
    walk(base);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}
