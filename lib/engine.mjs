import path from "node:path";
import { exec } from "node:child_process";
import { askJson, complete, isMock } from "./llm.mjs";
import * as P from "./prompts.mjs";

const SEVERITY_BAD = new Set(["blocker", "major"]);

/**
 * Deterministic pipeline state machine.
 * Every transition is persisted, so the portal can be closed and reopened mid-run.
 */
export class Engine {
  constructor({ store, config, bus, keys = null }) {
    this.store = store;
    this.config = config;
    this.bus = bus;
    this.keys = keys;
    this.keyUsage = new Map();
    this.active = new Set();
  }

  /** Расход по ключу за сегодня (в памяти; сбрасывается при рестарте сервера). */
  keyUse(keyId, cost) {
    if (!keyId) return;
    const day = new Date().toISOString().slice(0, 10);
    const cur = this.keyUsage.get(keyId);
    if (!cur || cur.day !== day) this.keyUsage.set(keyId, { day, cost: Number(cost) || 0 });
    else cur.cost += Number(cost) || 0;
  }

  keySpend(keyId) {
    const day = new Date().toISOString().slice(0, 10);
    const cur = this.keyUsage.get(keyId);
    return cur && cur.day === day ? cur.cost : 0;
  }

  agents() {
    const list = this.config.agents?.agents ?? this.config.agents;
    return Array.isArray(list) ? list : [];
  }

  agent(id) {
    const a = this.agents().find((x) => x.id === id);
    if (!a) throw new Error(`Агент «${id}» не найден в config/agents.json`);
    return a;
  }

  stages() {
    return this.config.pipeline.stages.filter((s) => s.enabled !== false);
  }

  emit(run, kind, message, extra = {}) {
    const entry = this.store.event(run, { kind, message, ...extra });
    this.bus.emit("event", { runId: run.id, entry });
    return entry;
  }

  /** Любая смена статуса должна доехать до открытых вкладок, иначе UI застревает. */
  state(run) {
    this.bus.emit("state", { runId: run.id, run });
    return run;
  }

  async start(run) {
    if (this.active.has(run.id)) return;
    this.active.add(run.id);
    try {
      await this.tick(run);
    } catch (err) {
      run.status = "failed";
      run.error = String(err?.message || err);
      this.emit(run, "error", `Прогон остановлен: ${run.error}`);
      this.store.save(run);
      this.state(run);
    } finally {
      this.active.delete(run.id);
    }
  }

  async resume(run) {
    if (run.status === "awaiting") return;
    run.cancelled = false;
    run.status = "running";
    run.error = null;
    this.store.save(run);
    this.emit(run, "resume", "Прогон продолжен");
    this.state(run);
    await this.start(run);
  }

  async tick(run) {
    const stages = this.stages();
    while (run.status === "running" || run.status === "awaiting") {
      if (run.cancelled) {
        run.status = "cancelled";
        this.emit(run, "cancel", "Прогон отменён");
        break;
      }
      if (run.status === "awaiting") break;

      if (run.stageIndex >= stages.length) {
        run.status = "done";
        run.awaiting = null;
        this.emit(run, "done", `Готово. Вызовов: ${run.usage.calls}, стоимость: $${run.usage.cost.toFixed(4)}`);
        this.store.save(run);
        this.state(run);
        break;
      }

      const stage = stages[run.stageIndex];
      this.emit(run, "stage_start", `Стадия «${stage.title}»`, { stageId: stage.id });
      run.awaiting = null;
      this.store.save(run);

      await this.executeStage(run, stage);

      if (run.cancelled) {
        run.status = "cancelled";
        run.awaiting = null;
        this.emit(run, "cancel", "Прогон отменён");
        this.store.save(run);
        this.state(run);
        break;
      }

      if (run.status === "awaiting_plan") break;

      this.emit(run, "stage_done", `Стадия «${stage.title}» завершена`, { stageId: stage.id });

      if (stage.gate) {
        run.status = "awaiting";
        run.awaiting = {
          stageId: stage.id,
          title: stage.title,
          question: stage.id === "plan" ? "Проверь декомпозицию" : "Проверь результат стадии",
          artifacts: this.store.listArtifacts(run).map((a) => a.path),
        };
        this.emit(run, "gate", `Нужно подтверждение: «${stage.title}»`, { stageId: stage.id });
        this.store.save(run);
        this.state(run);
        break;
      }

      run.stageIndex += 1;
      this.store.save(run);
    }
  }

  /** Fire-and-forget continuation: never blocks an HTTP response. */
  kick(run) {
    if (this.active.has(run.id)) {
      setTimeout(() => this.kick(run), 300);
      return;
    }
    this.start(run).catch((err) => {
      run.status = "failed";
      run.error = String(err?.message || err);
      this.emit(run, "error", `Прогон остановлен: ${run.error}`);
      this.store.save(run);
    });
  }

  approve(run, { decision, comment = "" }) {
    if (run.status !== "awaiting" || !run.awaiting) throw new Error("Прогон не ждёт подтверждения");
    const pending = run.awaiting;
    if (decision === "approve") {
      run.approvals[pending.stageId] = { at: new Date().toISOString(), comment };
      run.stageIndex += 1;
      run.awaiting = null;
      run.status = "running";
      this.emit(run, "approve", `Стадия «${pending.title}» принята${comment ? `: ${comment}` : ""}`);
      this.store.save(run);
      this.state(run);
      this.kick(run);
      return run;
    }
    if (decision === "reject") {
      if (!comment.trim()) throw new Error("Для отклонения нужен комментарий — что поправить");
      run.stageMeta = run.stageMeta ?? {};
      run.stageMeta[pending.stageId] = { feedback: comment };
      run.awaiting = null;
      run.status = "running";
      this.emit(run, "reject", `Стадия «${pending.title}» возвращена на доработку`, { comment });
      this.store.save(run);
      this.state(run);
      this.kick(run);
      return run;
    }
    throw new Error(`Неизвестное решение: ${decision}`);
  }

  cancel(run) {
    run.cancelled = true;
    run.awaiting = null;
    if (run.status !== "running") run.status = "cancelled";
    this.store.save(run);
    this.state(run);
    return run;
  }

  feedbackFor(run, stageId) {
    return run.stageMeta?.[stageId]?.feedback ?? "";
  }

  async call(run, agent, { kind, system, user, json, meta }) {
    const started = Date.now();
    const key = this.keys?.resolve(agent.id) ?? null;
    if (key?.limitDaily) {
      const spent = this.keySpend(key.id);
      if (spent >= key.limitDaily) {
        throw new Error(`Дневной лимит ключа «${key.label}» исчерпан: $${spent.toFixed(2)} из $${key.limitDaily}`);
      }
    }
    this.emit(run, "call", `→ ${agent.name} (${agent.model}) · ${kind}`, { agent: agent.id, model: agent.model, callKind: kind, keyId: key?.id ?? null });
    let res;
    try {
      res = json
        ? await askJson({ agent, kind, system, user, meta, apiKey: key?.key })
        : await complete({ agent, kind, system, user, meta, apiKey: key?.key });
    } catch (err) {
      this.emit(run, "call_failed", `✖ ${agent.name} (${kind}): ${String(err?.message || err).slice(0, 160)}`, {
        agent: agent.id,
        model: agent.model,
        callKind: kind,
        keyId: key?.id ?? null,
        ms: Date.now() - started,
      });
      this.store.save(run);
      throw err;
    }
    this.keyUse(key?.id, res.usage.cost);
    run.usage.calls += 1;
    run.usage.prompt += res.usage.prompt;
    run.usage.completion += res.usage.completion;
    run.usage.cost += res.usage.cost;
    const ms = Date.now() - started;
    this.emit(run, "call_done", `← ${agent.name}: ${(res.text.length / 1000).toFixed(1)}k симв. за ${(ms / 1000).toFixed(1)}с`, {
      agent: agent.id,
      model: res.model,
      usage: res.usage,
      callKind: kind,
      keyId: key?.id ?? null,
      ms,
    });
    this.store.save(run);
    return res;
  }

  async executeStage(run, stage) {
    const feedback = this.feedbackFor(run, stage.id);
    switch (stage.kind) {
      case "plan":
        return this.doPlan(run, stage, feedback);
      case "spec":
        return this.perBlock(run, stage, feedback, (b) => this.doSpec(run, stage, b, feedback));
      case "design":
        return this.perBlock(run, stage, feedback, (b) => this.doDesign(run, stage, b, feedback));
      case "mockup":
        return this.doMockup(run, stage, feedback);
      case "build":
        return this.perBlock(run, stage, feedback, (b) => this.doBuild(run, stage, b, feedback));
      case "verify":
        return this.perBlock(run, stage, feedback, (b) => this.doVerify(run, stage, b));
      case "report":
        return this.doReport(run, stage, feedback);
      default:
        throw new Error(`Неизвестный тип стадии: ${stage.kind}`);
    }
  }

  async perBlock(run, stage, feedback, fn) {
    if (!run.blocks?.length) throw new Error("Нет блоков: сначала нужна стадия плана");
    for (const block of run.blocks) {
      if (run.cancelled) return;
      if (!feedback && this.alreadyDone(stage, block)) {
        this.emit(run, "skip", `Блок ${block.id}: стадия «${stage.title}» уже сделана — пропускаю`);
        continue;
      }
      await fn(block);
      this.store.save(run);
    }
  }

  /** После падения/рестарта не платим за блок, который эту стадию уже прошёл. */
  alreadyDone(stage, block) {
    switch (stage.kind) {
      case "spec":
        return Boolean(block.spec);
      case "design":
        return Boolean(block.design);
      case "build":
        return (block.files?.length ?? 0) > 0 && ["built", "verified"].includes(block.status);
      case "verify":
        return block.status === "verified";
      default:
        return false;
    }
  }

  async doPlan(run, stage, feedback) {
    const agent = this.agent(stage.agent);
    if (agent.kind === "external") {
      run.status = "awaiting_plan";
      run.awaiting = {
        stageId: stage.id,
        title: stage.title,
        question: "План пишет оркестратор в чате — вставь его сюда",
        manual: true,
      };
      this.emit(run, "plan_needed", "Ждём план от оркестратора (DeepSeek Harness)");
      this.store.save(run);
      return;
    }
    const { data, text } = await this.call(run, agent, {
      kind: "plan",
      system: agent.prompt,
      json: true,
      user: P.planPrompt({
        task: run.task,
        feedback,
        change: run.change,
        projectFiles: this.workspaceFiles(run),
      }).user,
    });
    const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
    if (!blocks.length) throw new Error("Оркестратор не вернул ни одного блока");
    run.plan = {
      title: String(data.title ?? "План"),
      blocks: blocks.map((b, i) => ({
        id: String(b.id ?? `b${i + 1}`).replace(/[^\w-]/g, "").slice(0, 24) || `b${i + 1}`,
        title: String(b.title ?? `Блок ${i + 1}`),
        goal: String(b.goal ?? ""),
        acceptance: Array.isArray(b.acceptance) ? b.acceptance.map(String) : [],
        deps: Array.isArray(b.deps) ? b.deps.map(String) : [],
      })),
    };
    run.blocks = run.plan.blocks.map((b) => ({
      ...b,
      status: "planned",
      spec: null,
      design: null,
      files: [],
      test: null,
      fixes: [],
      history: [],
    }));
    this.store.writeArtifact(run, "plan.md", P.renderPlan(run.plan) + `\n\n---\n_сырой ответ модели:_\n\n${text}`);
  }

  /** План, написанный оркестратором в чате (агент kind=external). */
  applyManualPlan(run, payload) {
    if (run.status !== "awaiting_plan") throw new Error("Прогон не ждёт план");
    const blocks = Array.isArray(payload?.blocks) ? payload.blocks : [];
    if (!blocks.length) throw new Error("В плане нет блоков");
    const stage = this.stages()[run.stageIndex];
    run.plan = {
      title: String(payload.title ?? "План"),
      blocks: blocks.map((b, i) => ({
        id: String(b.id ?? `b${i + 1}`).replace(/[^\w-]/g, "").slice(0, 24) || `b${i + 1}`,
        title: String(b.title ?? `Блок ${i + 1}`),
        goal: String(b.goal ?? ""),
        acceptance: Array.isArray(b.acceptance) ? b.acceptance.map(String) : [],
        deps: Array.isArray(b.deps) ? b.deps.map(String) : [],
      })),
    };
    run.blocks = run.plan.blocks.map((b) => ({
      ...b,
      status: "planned",
      spec: null,
      design: null,
      files: [],
      test: null,
      fixes: [],
      history: [],
    }));
    this.store.writeArtifact(run, "plan.md", P.renderPlan(run.plan));
    run.awaiting = null;
    run.status = "running";
    run.stageIndex += 1;
    this.emit(run, "approve", `План принят от оркестратора: «${run.plan.title}»`);
    this.store.save(run);
    this.state(run);
    this.kick(run);
    return run;
  }

  async doMockup(run, stage, feedback) {
    const agent = this.agent(stage.agent);
    const specs = (run.blocks ?? []).map((b) => ({ id: b.id, title: b.title, text: b.spec ?? "" }));
    const { text } = await this.call(run, agent, {
      kind: "mockup",
      system: agent.prompt,
      user:
        P.mockupPrompt({ task: run.task, plan: run.plan, specs }).user +
        (feedback ? `\n\nЗамечания заказчика к макету (учти обязательно):\n${feedback}` : ""),
      meta: { blocks: run.blocks },
    });
    const html = stripFences(text);
    if (!/<(html|body|div)/i.test(html)) throw new Error("Ответ макетчика не похож на HTML");
    this.store.writeArtifact(run, "mockup.html", html);
    run.mockup = { at: new Date().toISOString(), chars: html.length };
  }

  async doSpec(run, stage, block, feedback) {
    const agent = this.agent(stage.agent);
    const { text } = await this.call(run, agent, {
      kind: "spec",
      system: agent.prompt,
      user: P.specPrompt({ task: run.task, plan: run.plan, block, feedback }).user,
      meta: { block },
    });
    block.spec = text;
    block.status = "specced";
    this.store.writeArtifact(run, `blocks/${block.id}/spec.md`, text);
  }

  async doDesign(run, stage, block, feedback) {    const agent = this.agent(stage.agent);
    const { text } = await this.call(run, agent, {
      kind: "design",
      system: agent.prompt,
      user: P.designPrompt({ task: run.task, block, spec: block.spec ?? "", feedback }).user,
      meta: { block },
    });
    block.design = text;
    this.store.writeArtifact(run, `blocks/${block.id}/design.md`, text);
  }

  /** Whole project as [{path, content}] — blocks are written into one shared project. */
  workspaceFiles(run) {
    const ws = run.workspace ?? {};
    if (Object.keys(ws).length) {
      return Object.entries(ws).map(([path, content]) => ({ path, content }));
    }
    const merged = new Map();
    for (const b of run.blocks ?? []) for (const f of b.files ?? []) merged.set(f.path, f.content);
    return [...merged].map(([path, content]) => ({ path, content }));
  }

  async doBuild(run, stage, block, feedback) {
    if (!block.spec) throw new Error(`У блока ${block.id} нет спеки`);
    const agent = this.agent(stage.agent);
    const { data } = await this.call(run, agent, {
      kind: "build",
      system: agent.prompt,
      json: true,
      user: P.codePrompt({
        task: run.task,
        block,
        spec: block.spec,
        design: block.design,
        projectFiles: this.workspaceFiles(run),
        feedback,
      }).user,
      meta: { block },
    });
    this.applyFiles(run, block, data?.files, data?.notes);
    block.status = "built";
    block.history.push({ at: new Date().toISOString(), action: "build", notes: data?.notes ?? "" });
    this.store.writeArtifact(run, `blocks/${block.id}/code.md`, this.filesMarkdown(block));
  }

  async doVerify(run, stage, block) {
    const tester = this.agent(stage.agent);
    const coder = this.agent(findCoderId(this.config));
    const maxRounds = Number(this.config.pipeline.maxFixRounds ?? 2);
    let round = 0;

    while (round <= maxRounds) {
      const testOutput = await this.runTestCommand(run);
      const { data } = await this.call(run, tester, {
        kind: "test",
        system: tester.prompt,
        json: true,
        user: P.testPrompt({
          task: run.task,
          block,
          spec: block.spec ?? "",
          files: this.workspaceFiles(run),
          testOutput,
        }).user,
        meta: { block, round: round + 1 },
      });

      const verdict = data?.verdict === "pass" ? "pass" : "fail";
      const defects = Array.isArray(data?.defects) ? data.defects : [];
      const criteria = Array.isArray(data?.criteria) ? data.criteria : [];
      block.test = { verdict, defects, criteria, summary: data?.summary ?? "", round: round + 1, testOutput };
      this.store.writeArtifact(run, `blocks/${block.id}/test-${round + 1}.md`, this.testMarkdown(block, round + 1));
      this.emit(run, "verdict", `${tester.name}: блок ${block.id} — ${verdict}${defects.length ? `, дефектов ${defects.length}` : ""}`, {
        agent: tester.id,
        block: block.id,
        verdict,
        defects: defects.length,
        round: round + 1,
      });

      const blocking = defects.filter((d) => SEVERITY_BAD.has(String(d.severity)));
      if (verdict === "pass" && !blocking.length) {
        block.status = "verified";
        break;
      }
      if (round >= maxRounds) {
        block.status = "failed";
        break;
      }
      round += 1;
      const fix = await this.call(run, coder, {
        kind: "fix",
        system: coder.prompt,
        json: true,
        user: P.fixPrompt({
          task: run.task,
          block,
          spec: block.spec ?? "",
          files: block.files,
          projectFiles: this.workspaceFiles(run),
          defects,
          round,
        }).user,
        meta: { block, round },
      });
      this.applyFiles(run, block, fix.data?.files, fix.data?.notes);
      block.fixes.push({ round, notes: fix.data?.notes ?? "", defects });
      this.store.writeArtifact(run, `blocks/${block.id}/fix-${round}.md`, this.fixMarkdown(block, round));
      this.store.writeArtifact(run, `blocks/${block.id}/code.md`, this.filesMarkdown(block));
    }
  }

  async doReport(run, stage, feedback) {
    const agent = this.agent(stage.agent);
    const { text } = await this.call(run, agent, {
      kind: "report",
      system: agent.prompt,
      user: P.reportPrompt({ task: run.task, plan: run.plan, blocks: run.blocks, usage: run.usage }).user +
        (feedback ? `\n\nЗамечания заказчика к предыдущей сводке:\n${feedback}` : ""),
      meta: { blocks: run.blocks },
    });
    this.store.writeArtifact(run, "summary.md", text);
    run.summary = text;
  }

  applyFiles(run, block, files, notes) {
    if (!Array.isArray(files) || !files.length) {
      throw new Error(`Модель не вернула ни одного файла (${notes ?? "без пояснений"})`);
    }
    for (const f of files) {
      const rel = String(f?.path ?? "");
      const content = String(f?.content ?? "");
      if (!rel) continue;
      const clean = this.store.writeArtifact(run, `work/${rel}`, content);
      run.workspace = run.workspace ?? {};
      run.workspace[rel] = content;
      const known = block.files.find((x) => x.path === rel);
      if (known) known.content = content;
      else block.files.push({ path: rel, content });
      void clean;
    }
  }

  workspaceDir(run) {
    return path.join(this.store.runDir(run.id), "artifacts", "work");
  }

  runTestCommand(run) {
    const cmd = String(this.config.pipeline.testCommand ?? "").trim();
    if (!cmd) return Promise.resolve("");
    return new Promise((resolve) => {
      exec(cmd, { cwd: this.workspaceDir(run), timeout: 60_000, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
        const out = `$ ${cmd}\n${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
        resolve(err ? `${out}\n[exit ${err.code ?? "error"}]` : out);
      });
    });
  }

  filesMarkdown(block) {
    const parts = [`# Код блока ${block.id} — ${block.title}`, ""];
    for (const f of block.files) parts.push(`## ${f.path}`, "", "```", f.content, "```", "");
    return parts.join("\n");
  }

  testMarkdown(block, round) {
    const t = block.test ?? {};
    const lines = [
      `# Проверка блока ${block.id} — круг ${round}`,
      "",
      `**Вердикт:** ${t.verdict ?? "—"}`,
      "",
      `**Резюме:** ${t.summary ?? "—"}`,
      "",
      "## Критерии приёмки",
      ...(t.criteria?.length
        ? t.criteria.map((c) => `- ${c.met ? "✅" : "❌"} ${c.text} — ${c.evidence ?? "—"}`)
        : ["- не проверялись"]),
      "",
      "## Дефекты",
      ...(t.defects?.length
        ? t.defects.map((d) => `- [${d.severity}] \`${d.where}\` — ${d.what}`)
        : ["- нет"]),
    ];
    if (t.testOutput) lines.push("", "## Автопроверка", "```", t.testOutput, "```");
    return lines.join("\n");
  }

  fixMarkdown(block, round) {
    const fix = block.fixes.find((f) => f.round === round);
    return [
      `# Правки блока ${block.id} — круг ${round}`,
      "",
      `**Что исправлено:** ${fix?.notes ?? "—"}`,
      "",
      "## По каким дефектам",
      ...(fix?.defects?.map((d) => `- [${d.severity}] \`${d.where}\` — ${d.what}`) ?? ["- —"]),
      "",
      `Файлов после правок: ${block.files.length}`,
    ].join("\n");
  }
}

function findCoderId(config) {
  const s = config.pipeline.stages.find((x) => x.kind === "build");
  return s?.agent ?? "coder";
}

/** Модели любят обернуть HTML в ```html — снимаем. */
function stripFences(text) {
  const t = String(text ?? "").trim();
  const m = t.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (m && /<(!doctype|html|body|div)/i.test(m[1])) return m[1].trim();
  return t.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/, "").trim();
}

export { isMock };
