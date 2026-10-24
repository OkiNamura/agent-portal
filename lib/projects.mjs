import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const short = () => crypto.randomBytes(3).toString("hex");

/** Проект = задача + все её версии (прогоны). */
export class Projects {
  constructor(root) {
    this.file = process.env.PROJECTS_FILE ? path.resolve(process.env.PROJECTS_FILE) : path.join(root, "projects.json");
    this.items = [];
    if (fs.existsSync(this.file)) {
      try {
        this.items = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, "")).projects ?? [];
      } catch {
        this.items = [];
      }
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ projects: this.items }, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.items;
  }

  get(id) {
    return this.items.find((p) => p.id === id) ?? null;
  }

  create({ name, task }) {
    const project = {
      id: `p-${Date.now().toString(36)}-${short()}`,
      name: (name || task || "Проект").slice(0, 120),
      task: task ?? "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runIds: [],
    };
    this.items.unshift(project);
    this.save();
    return project;
  }

  attach(projectId, runId) {
    const p = this.get(projectId);
    if (!p) throw new Error(`Проект ${projectId} не найден`);
    if (!p.runIds.includes(runId)) p.runIds.push(runId);
    p.updatedAt = new Date().toISOString();
    this.save();
    return p;
  }

  byRun(runId) {
    return this.items.find((p) => p.runIds.includes(runId)) ?? null;
  }

  /** Приводит старые прогоны в порядок: группирует по тексту задачи. */
  migrate(runs) {
    let changed = false;
    for (const run of runs) {
      if (run.projectId) continue;
      let project = this.items.find((p) => p.task === run.task) ?? null;
      if (!project) {
        project = this.create({ name: run.task.slice(0, 80), task: run.task });
      }
      project.runIds.push(run.id);
      run.projectId = project.id;
      changed = true;
    }
    this.save();
    return changed;
  }
}
