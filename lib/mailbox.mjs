import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Почтовый ящик: события, алерты и переписка в угловом чате. */
export class Mailbox {
  constructor(root) {
    this.file = process.env.MAILBOX_FILE ? path.resolve(process.env.MAILBOX_FILE) : path.join(root, "mailbox.json");
    this.items = [];
    if (fs.existsSync(this.file)) {
      try {
        this.items = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, "")).items ?? [];
      } catch {
        this.items = [];
      }
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  add({ from, text, kind = "note", runId = null, projectId = null, level = "info" }) {
    const item = {
      id: crypto.randomBytes(4).toString("hex"),
      at: new Date().toISOString(),
      from,
      text,
      kind,
      level,
      runId,
      projectId,
      read: false,
    };
    this.items.push(item);
    if (this.items.length > 400) this.items.splice(0, this.items.length - 400);
    this.save();
    return item;
  }

  list(limit = 80) {
    return this.items.slice(-limit);
  }

  markRead(ids) {
    const set = new Set(ids ?? []);
    for (const i of this.items) if (set.has(i.id) || set.size === 0) i.read = true;
    this.save();
  }

  unread() {
    return this.items.filter((i) => !i.read).length;
  }
}
