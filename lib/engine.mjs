import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { askJson, complete, isMock } from "./llm.mjs";
import * as P from "./prompts.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SEVERITY_BAD = new Set(["blocker", "major"]);
const SEVERITY_RANK = { minor: 0, major: 1, blocker: 2 };

/** Ключ дефекта: место + первые 40 символов формулировки — так склеиваются дубликаты. */
function defectKey(d) {
  const where = String(d?.where ?? "").trim().toLowerCase();
  const what = String(d?.what ?? "").trim().slice(0, 40).toLowerCase();
  return `${where}::${what}`;
}

function isBlocking(d) {
  return SEVERITY_BAD.has(String(d?.severity ?? "").toLowerCase());
}

/** Ошибка бюджета должна останавливать весь прогон, а не превращаться в «блок не прошёл». */
function isBudgetError(err) {
  return /бюджет прогона исчерпан/.test(String(err?.message || err));
}

/** Один дефект = одна запись: приводит severity к нижнему регистру, склеивает дубликаты, режет до 5. */
function dedupeDefects(list) {
  const out = [];
  const byKey = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== "object") continue;
    const d = { ...raw, severity: String(raw.severity ?? "minor").toLowerCase() };
    const key = defectKey(d);
    const known = byKey.get(key);
    if (known) {
      // одинаковый дефект: оставляем самую тяжёлую severity, но не размножаем запись
      if ((SEVERITY_RANK[d.severity] ?? 0) > (SEVERITY_RANK[known.severity] ?? 0)) known.severity = d.severity;
      if (!known.criterion && d.criterion) known.criterion = d.criterion;
      continue;
    }
    byKey.set(key, d);
    out.push(d);
  }
  return out.slice(0, 5);
}

/** Ограниченный параллелизм: не больше `limit` промисов одновременно. */
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const size = Math.max(1, Math.min(Number(limit) || 1, queue.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length) {
        const item = queue.shift();
        await fn(item);
      }
    })
  );
}

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
    this.repoRoot = REPO_ROOT;
    // точка подмены LLM для проверок (по умолчанию — реальные askJson/complete)
    this.llm = { askJson, complete, isMock };
    // >0 — идёт параллельная стадия: store.save откладываем до её конца
    this.saveDefer = 0;
  }

  /** store.save не должен вызываться конкурентно: во время параллельных стадий копим и пишем один раз. */
  saveRun(run) {
    if (this.saveDefer > 0) return run;
    return this.store.save(run);
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
    if (typeof this.spendProvider === "function") return this.spendProvider(keyId);
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
      // даже при падении оставляем след: что успели, где встали, что делать дальше
      try {
        const lines = [
          "# Прогон остановлен",
          "",
          `**Причина:** ${run.error}`,
          "",
          "## Что успели",
          ...(run.blocks ?? []).map((b) => `- ${b.id} «${b.title}»: ${b.status}${b.test?.verdict ? ` (тест: ${b.test.verdict})` : ""}`),
          "",
          "## Что делать",
          "- Нажми «Продолжить с текущей стадии» — прогон пойдёт с места остановки.",
          "- Если падает на таймауте: смени модель агента на более быструю или переключи пресет «Быстрее».",
          "",
          `Стоимость на момент остановки: $${(run.usage?.cost ?? 0).toFixed(4)}`,
        ];
        this.store.writeArtifact(run, "failure.md", lines.join("\n"));
      } catch {
        /* не критично */
      }
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

  /** Необязательное поле `model` у стадии переопределяет модель агента для этой стадии. */
  stageModel(stageId) {
    if (!stageId) return "";
    const stage = (this.config.pipeline?.stages ?? []).find((s) => s.id === stageId);
    return String(stage?.model ?? "").trim();
  }

  effectiveAgent(agent, stageId) {
    const model = this.stageModel(stageId);
    return model && model !== agent.model ? { ...agent, model } : agent;
  }

  /** Лимит бюджета: у прогона может быть свой (проверки/эксперименты), иначе из конфига. */
  budgetLimit(run) {
    const raw = Number(run?.maxCostUsd ?? this.config.pipeline?.maxCostUsd ?? 0.25);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /** Оценка следующего вызова — средняя стоимость прошлых вызовов этого прогона. */
  estimateCallCost(run) {
    const calls = Number(run?.usage?.calls ?? 0);
    const cost = Number(run?.usage?.cost ?? 0);
    if (calls > 0) return cost / calls;
    const preset = Number(this.config.pipeline?.estimateCostUsd);
    return Number.isFinite(preset) && preset >= 0 ? preset : 0.002;
  }

  /** Не начинаем вызов, если бюджет прогона уже не выдержит ещё один. */
  assertBudget(run) {
    const limit = this.budgetLimit(run);
    if (!limit) return;
    const spent = Number(run?.usage?.cost ?? 0);
    const estimate = this.estimateCallCost(run);
    if (spent + estimate > limit + 1e-12) {
      throw new Error(
        `бюджет прогона исчерпан ($${spent.toFixed(4)} из $${limit.toFixed(4)}): следующий вызов ~$${estimate.toFixed(4)}. ` +
          `Увеличь maxCostUsd в config/pipeline.json или запусти новый прогон.`
      );
    }
  }

  async call(run, agent, { kind, system, user, json, meta, maxTokens = null, stageId = null }) {
    // модель стадии (если задана) важнее модели агента
    const effective = this.effectiveAgent(agent, stageId);
    this.assertBudget(run);
    const started = Date.now();
    const key = this.keys?.resolve(effective.id) ?? null;
    if (key?.limitDaily) {
      const spent = this.keySpend(key.id);
      if (spent >= key.limitDaily) {
        throw new Error(`Дневной лимит ключа «${key.label}» исчерпан: $${spent.toFixed(2)} из $${key.limitDaily}`);
      }
    }
    this.emit(run, "call", `→ ${effective.name} (${effective.model}) · ${kind}`, {
      agent: effective.id,
      model: effective.model,
      baseModel: agent.model,
      stageId: stageId ?? null,
      stageModel: effective.model !== agent.model,
      callKind: kind,
      keyId: key?.id ?? null,
      // длина собранного промта: видно, сколько стоил отбор файлов и где экономия
      promptChars: String(system ?? "").length + String(user ?? "").length,
    });
    let res;
    try {
      res = json
        ? await this.llm.askJson({ agent: effective, kind, system, user, meta, apiKey: key?.key, maxTokens })
        : await this.llm.complete({ agent: effective, kind, system, user, meta, apiKey: key?.key, maxTokens });
    } catch (err) {
      this.emit(run, "call_failed", `✖ ${effective.name} (${kind}): ${String(err?.message || err).slice(0, 160)}`, {
        agent: effective.id,
        model: effective.model,
        callKind: kind,
        keyId: key?.id ?? null,
        ms: Date.now() - started,
      });
      this.saveRun(run);
      throw err;
    }
    this.keyUse(key?.id, res.usage.cost);
    run.usage.calls += 1;
    run.usage.prompt += res.usage.prompt;
    run.usage.completion += res.usage.completion;
    run.usage.cost += res.usage.cost;

    // Подмена модели: провайдер/таймаут → резервная модель. Это должно быть видно
    // и в событиях (fallback/originalModel), и в состоянии блока (fallbacks).
    const fallback = Boolean(res.fallback) || /\(fallback\)/.test(String(res.model ?? ""));
    if (fallback) {
      res.fallback = true;
      res.originalModel = res.originalModel ?? effective.model;
      if (meta?.block) meta.block.fallbacks = Number(meta.block.fallbacks ?? 0) + 1;
      run.fallbacks = Number(run.fallbacks ?? 0) + 1;
    }
    const ms = Date.now() - started;
    this.emit(run, "call_done", `← ${effective.name}: ${(res.text.length / 1000).toFixed(1)}k симв. за ${(ms / 1000).toFixed(1)}с`, {
      agent: effective.id,
      model: res.model,
      fallback,
      originalModel: fallback ? res.originalModel : null,
      usage: res.usage,
      callKind: kind,
      stageId: stageId ?? null,
      keyId: key?.id ?? null,
      ms,
      finishReason: res.finishReason ?? null,
    });
    this.saveRun(run);
    return res;
  }

  async executeStage(run, stage) {
    const feedback = this.feedbackFor(run, stage.id);
    switch (stage.kind) {
      case "plan":
        return this.doPlan(run, stage, feedback);
      case "spec":
        // спеки независимы друг от друга: пишем параллельно (не больше 3), сохраняемся один раз в конце
        return this.perBlock(run, stage, feedback, (b) => this.doSpec(run, stage, b, feedback), { parallel: 3 });
      case "design":
        return this.perBlock(run, stage, feedback, (b) => this.doDesign(run, stage, b, feedback));
      case "mockup":
        return this.doMockup(run, stage, feedback);
      case "build":
        return this.perBlock(run, stage, feedback, (b) => this.doBuild(run, stage, b, feedback));
      case "verify":
        await this.perBlock(run, stage, feedback, (b) => this.doVerify(run, stage, b));
        // autoAcceptVerified: весь блок-гейт без лишних кликов — verified считается принятым
        this.autoAcceptVerifiedBlocks(run);
        return;
      case "report":
        return this.doReport(run, stage, feedback);
      default:
        throw new Error(`Неизвестный тип стадии: ${stage.kind}`);
    }
  }

  async perBlock(run, stage, feedback, fn, { parallel = 0 } = {}) {
    if (!run.blocks?.length) throw new Error("Нет блоков: сначала нужна стадия плана");
    const todo = [];
    for (const block of run.blocks) {
      if (!feedback && this.alreadyDone(stage, block)) {
        this.emit(run, "skip", `Блок ${block.id}: стадия «${stage.title}» уже сделана — пропускаю`);
        continue;
      }
      todo.push(block);
    }
    if (!parallel || todo.length < 2) {
      for (const block of todo) {
        if (run.cancelled) return;
        if (!feedback && !block.needsRecheck && this.alreadyDone(stage, block)) {
          this.emit(run, "skip", `Блок ${block.id}: стадия «${stage.title}» уже сделана — пропускаю`);
          continue;
        }
        await fn(block);
        this.store.save(run);
      }
      return;
    }

    // Параллельный режим: блоки друг от друга не зависят, но пишут в один run.
    // Поэтому store.save внутри не зовём (saveDefer), а сохраняем один раз после всех.
    this.saveDefer += 1;
    try {
      await mapLimit(todo, parallel, async (block) => {
        if (run.cancelled) return;
        if (!feedback && !block.needsRecheck && this.alreadyDone(stage, block)) {
          this.emit(run, "skip", `Блок ${block.id}: стадия «${stage.title}» уже сделана — пропускаю`);
          return;
        }
        try {
          await fn(block);
        } catch (err) {
          // бюджет исчерпан — останавливаем весь прогон, а не помечаем один блок
          if (isBudgetError(err)) throw err;
          // падение одного блока не должно ронять остальные и весь прогон
          const message = String(err?.message || err);
          block.status = "failed";
          block.error = message;
          this.emit(run, "error", `Блок ${block.id}: стадия «${stage.title}» не выполнена — ${message.slice(0, 140)}`);
        }
      });
    } finally {
      this.saveDefer -= 1;
    }
    if (run.cancelled) return;
    this.store.save(run);
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
      stageId: stage.id,
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
      fallbacks: 0,
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
      fallbacks: 0,
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
      stageId: stage.id,
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
      stageId: stage.id,
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
      stageId: stage.id,
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
      stageId: stage.id,
      system: agent.prompt,
      json: true,
      // полный файл Notepad-приложения не влезает в дефолтные 8000 токенов
      maxTokens: 32000,
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
    await this.verifyBlock(run, stage, block, { recheck: false });
    // Правки в общем файле могли затронуть уже проверенные блоки — перепроверяем их
    // сразу, до перехода к следующему блоку. Не больше одного повторного круга на блок.
    await this.recheckDependents(run, stage);
  }

  async verifyBlock(run, stage, block, { recheck = false } = {}) {
    const tester = this.agent(stage.agent);
    const coder = this.agent(findCoderId(this.config));
    const maxRounds = Number(this.config.pipeline.maxFixRounds ?? 2);
    // Ключи уже показанных дефектов: повторы между кругами не раздувают список и не гоняют одно и то же.
    const seen = new Set();
    let round = 0;

    while (round <= maxRounds) {
      const autoOutput = await this.runTestCommand(run, block);
      // детерминированная проверка на пустые тела функций: не даёт ИИ-тестировщику
      // «не заметить» заглушку и не зависит от того, как модель прочитала код
      const stubOutput = this.stubReport(run);
      // предупреждения о пропавших функциях — первыми, чтобы не потерялись при обрезке промпта
      const integrityOutput = this.integrityReport(block);
      const testOutput = [integrityOutput, autoOutput, stubOutput].filter(Boolean).join("\n\n");
      const { data } = await this.call(run, tester, {
        kind: "test",
        stageId: stage.id,
        system: tester.prompt,
        json: true,
        user: P.testPrompt({
          task: run.task,
          block,
          spec: block.spec ?? "",
          files: this.workspaceFiles(run),
          testOutput,
          fallbacks: Number(block.fallbacks ?? 0),
        }).user,
        meta: { block, round: round + 1 },
      });

      const verdict = data?.verdict === "pass" ? "pass" : "fail";
      const defects = dedupeDefects(data?.defects);
      const criteria = Array.isArray(data?.criteria) ? data.criteria : [];
      const fresh = defects.filter((d) => !seen.has(defectKey(d)));
      const repeats = defects.length - fresh.length;
      for (const d of defects) seen.add(defectKey(d));
      block.test = { verdict, defects, criteria, summary: data?.summary ?? "", round: round + 1, testOutput };
      if (repeats > 0) block.test.repeats = repeats;
      this.store.writeArtifact(run, `blocks/${block.id}/test-${round + 1}.md`, this.testMarkdown(block, round + 1));
      this.emit(
        run,
        "verdict",
        `${tester.name}: блок ${block.id} — ${verdict}${defects.length ? `, дефектов ${defects.length}` : ""}${repeats ? ` (повторов: ${repeats})` : ""}`,
        {
          agent: tester.id,
          block: block.id,
          verdict,
          defects: defects.length,
          round: round + 1,
        }
      );

      const blocking = defects.filter(isBlocking);
      if (verdict === "pass" && !blocking.length) {
        // тестировщик доволен — зовём безопасника: он может вернуть блок в доработку
        const sec = await this.securityCheck(run, block, round, stage);
        block.security = sec;
        const secBad = (sec.findings ?? []).filter(isBlocking);
        if (!secBad.length) {
          this.autoAcceptVerified(run, block, { reason: recheck ? "повторная проверка пройдена" : "тест и безопасность пройдены" });
          break;
        }
        defects.push(...secBad);
        block.test = { ...block.test, verdict: "fail", defects, summary: `${block.test.summary} · безопасник: ${sec.summary}` };
        this.store.writeArtifact(run, `blocks/${block.id}/test-${round + 1}.md`, this.testMarkdown(block, round + 1));
      }

      const stillBlocking = defects.filter(isBlocking);

      // Остались только minor-замечания — блок принимается с пометкой, а не уходит в failed.
      // Условие: лимит кругов исчерпан ИЛИ тестировщик повторяет те же замечания (новых нет).
      if (!stillBlocking.length && (round >= maxRounds || !fresh.length)) {
        const reason =
          round >= maxRounds
            ? "лимит кругов правок исчерпан"
            : defects.length
              ? "тестировщик повторяет те же minor-замечания"
              : "вердикт fail без нарушенных критериев";
        this.acceptWithRemarks(run, block, reason);
        this.store.writeArtifact(run, `blocks/${block.id}/test-${round + 1}.md`, this.testMarkdown(block, round + 1));
        this.emit(run, "verdict", `Блок ${block.id} принят с замечаниями (${reason})`, {
          agent: tester.id,
          block: block.id,
          verdict: "pass",
          defects: defects.length,
          round: round + 1,
          remarks: true,
        });
        break;
      }

      if (round >= maxRounds) {
        block.status = "failed";
        break;
      }
      round += 1;
      const fix = await this.call(run, coder, {
        kind: "fix",
        stageId: stage.id,
        system: coder.prompt,
        json: true,
        maxTokens: 32000,
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
      // фикс мог тронуть общий файл — уже принятые блоки надо перепроверить
      if (!recheck) this.markDependentsForRecheck(run, block, fix.data?.files);
      this.store.writeArtifact(run, `blocks/${block.id}/fix-${round}.md`, this.fixMarkdown(block, round));
      this.store.writeArtifact(run, `blocks/${block.id}/code.md`, this.filesMarkdown(block));
    }
  }

  /** autoAcceptVerified: verified-блок считается принятым без ручного клика. */
  autoAcceptEnabled() {
    return this.config.pipeline?.autoAcceptVerified !== false;
  }

  autoAcceptVerified(run, block, { reason = "verified" } = {}) {
    block.status = "verified";
    if (!this.autoAcceptEnabled() || block.autoAccepted) return;
    // уже принят человеком — не переписываем ручное решение на «авто»
    if (block.manual?.decision === "accept" && block.manual.auto !== true) return;
    const at = new Date().toISOString();
    block.autoAccepted = true;
    block.acceptedAt = at;
    // manual.decision=accept нужен серверу/гейту: блок уже принят, ждать клика нечего.
    block.manual = { ...(block.manual ?? {}), decision: "accept", at, by: "engine", auto: true, comment: `авто: ${reason}` };
    this.emit(run, "approve", `Блок ${block.id} принят автоматически (autoAcceptVerified): ${reason}`, {
      block: block.id,
      auto: true,
    });
  }

  /** Принять все verified-блоки, которые ещё не помечены автоматически (после resume/рестарта). */
  autoAcceptVerifiedBlocks(run) {
    if (!this.autoAcceptEnabled()) return 0;
    let accepted = 0;
    for (const b of run.blocks ?? []) {
      if (b.status !== "verified" || b.autoAccepted) continue;
      this.autoAcceptVerified(run, b, { reason: "стадия проверки завершена" });
      accepted += 1;
    }
    return accepted;
  }

  /** Пометить уже принятые блоки, чьи файлы затронул фикс текущего блока. */
  markDependentsForRecheck(run, changedBy, files) {
    const paths = new Set(
      (Array.isArray(files) ? files : [])
        .map((f) => String(f?.path ?? "").replace(/\\/g, "/"))
        .filter(Boolean)
    );
    if (!paths.size) return [];
    const marked = [];
    for (const other of run.blocks ?? []) {
      if (other.id === changedBy.id) continue;
      if (other.status !== "verified") continue;
      // не больше одного повторного круга на блок
      if (other.needsRecheck || Number(other.rechecks ?? 0) >= 1) continue;
      const shared = (other.files ?? []).some((f) => paths.has(String(f.path ?? "").replace(/\\/g, "/")));
      if (!shared) continue;
      other.needsRecheck = true;
      marked.push(other.id);
      this.emit(run, "warn", `Файл изменён блоком ${changedBy.id}, а блок ${other.id} уже был verified — ставлю его в очередь повторной проверки`, {
        block: other.id,
        changedBy: changedBy.id,
        files: [...paths],
      });
    }
    return marked;
  }

  /** Проверить помеченные блоки сразу, без бесконечных циклов: один повторный круг на блок. */
  async recheckDependents(run, stage) {
    if (run.cancelled) return;
    const pending = (run.blocks ?? []).filter((b) => b.needsRecheck);
    for (const block of pending) {
      if (run.cancelled) return;
      block.needsRecheck = false;
      if (Number(block.rechecks ?? 0) >= 1) {
        this.emit(run, "warn", `Блок ${block.id}: повторная проверка уже была — второй круг не запускаю`, { block: block.id });
        continue;
      }
      block.rechecks = Number(block.rechecks ?? 0) + 1;
      this.emit(run, "warn", `Повторная проверка блока ${block.id} после правок в общем файле (круг ${block.rechecks} из 1)`, {
        block: block.id,
        recheck: true,
      });
      try {
        await this.verifyBlock(run, stage, block, { recheck: true });
        this.autoAcceptVerified(run, block, { reason: "повторная проверка после правок" });
      } catch (err) {
        const message = String(err?.message || err);
        // бюджет исчерпан — это остановка всего прогона, а не «блок не прошёл»
        if (isBudgetError(err)) throw err;
        block.status = "failed";
        block.error = message;
        this.emit(run, "error", `Повторная проверка блока ${block.id} не удалась: ${message.slice(0, 140)}`, { block: block.id });
      }
      this.store.save(run);
    }
  }

  /** Блок без блокирующих дефектов принимается, даже если остались minor-замечания. */
  acceptWithRemarks(run, block, reason) {
    block.status = "verified";
    block.test = {
      ...(block.test ?? {}),
      // вердикт блока — pass: критерии выполнены, остались только minor;
      // сырой вердикт тестировщика сохраняем отдельно, чтобы не терять историю
      testerVerdict: block.test?.verdict ?? null,
      verdict: "pass",
      acceptedWithRemarks: true,
      summary: `${block.test?.summary ? `${block.test.summary} · ` : ""}принят с замечаниями (${reason})`,
    };
    this.autoAcceptVerified(run, block, { reason: `принят с замечаниями: ${reason}` });
  }

  /** Проверка на бэкдоры и опасный код. Может вернуть блок в доработку. */
  async securityCheck(run, block, round, stage = null) {
    let agent;
    try {
      agent = this.agent("security");
    } catch {
      return { verdict: "skipped", findings: [], summary: "агент безопасности не настроен" };
    }
    try {
      const { data } = await this.call(run, agent, {
        kind: "security",
        stageId: stage?.id ?? null,
        system: agent.prompt,
        json: true,
        user: P.securityPrompt({ task: run.task, block, spec: block.spec ?? "", files: this.workspaceFiles(run) }).user,
        meta: { block, round },
      });
      const findings = Array.isArray(data?.findings) ? data.findings : [];
      const bad = findings.filter((f) => SEVERITY_BAD.has(String(f.severity)));
      const verdict = data?.verdict === "pass" && !bad.length ? "pass" : "fail";
      const summary = String(data?.summary ?? "");
      const md = [
        `# Безопасность блока ${block.id} — круг ${round + 1}`,
        "",
        `**Вердикт:** ${verdict}`,
        "",
        `**Резюме:** ${summary || "—"}`,
        "",
        "## Находки",
        ...(findings.length ? findings.map((f) => `- [${f.severity}] \`${f.where}\` — ${f.what}`) : ["- нет"]),
      ].join("\n");
      this.store.writeArtifact(run, `blocks/${block.id}/security-${round + 1}.md`, md);
      this.emit(run, "verdict", `${agent.name}: блок ${block.id} — ${verdict}${findings.length ? `, находок ${findings.length}` : ""}`, {
        agent: agent.id,
        block: block.id,
        verdict,
        defects: findings.length,
        round: round + 1,
        security: true,
      });
      return { verdict, findings, summary };
    } catch (err) {
      if (isBudgetError(err)) throw err;
      this.emit(run, "error", `Безопасник не смог проверить блок ${block.id}: ${String(err?.message || err).slice(0, 120)}`);
      return { verdict: "skipped", findings: [], summary: String(err?.message || err) };
    }
  }

  async doReport(run, stage, feedback) {
    const agent = this.agent(stage.agent);
    const { text } = await this.call(run, agent, {
      kind: "report",
      stageId: stage.id,
      system: agent.prompt,
      user: P.reportPrompt({ task: run.task, plan: run.plan, blocks: run.blocks, usage: run.usage }).user +
        (feedback ? `\n\nЗамечания заказчика к предыдущей сводке:\n${feedback}` : ""),
      meta: { blocks: run.blocks },
    });
    this.store.writeArtifact(run, "summary.md", text);
    run.summary = text;
  }

  /**
   * Записать файлы инженера в общий проект.
   * Защита от «затирания»: пустой content не затирает реализацию, а если модель
   * вернула stub-тело для функции, которая раньше была реализована, тело
   * восстанавливается из предыдущей версии.
   */
  applyFiles(run, block, files, notes) {
    if (!Array.isArray(files) || !files.length) {
      throw new Error(`Модель не вернула ни одного файла (${notes ?? "без пояснений"})`);
    }
    const skipped = [];
    const restoredAll = [];
    let written = 0;
    for (const f of files) {
      const rel = String(f?.path ?? "");
      let content = String(f?.content ?? "");
      if (!rel) continue;
      if (!content.trim()) {
        skipped.push(rel);
        continue;
      }
      const known = block.files.find((x) => x.path === rel);
      const prev = known?.content ?? run.workspace?.[rel] ?? "";
      if (prev && prev !== content) {
        const { content: merged, restored } = restoreStubBodies(prev, content);
        if (restored.length) {
          content = merged;
          restoredAll.push(`${rel}: ${restored.map((n) => `${n}()`).join(", ")}`);
        }
        // Изоляция блоков: нельзя молча вырезать функцию, на которую уже опираются
        // другие блоки. Это предупреждение (warn), а не автоматический провал: тестировщик
        // получит его в testOutput и перепроверит критерии.
        const missing = removedFunctionsMentionedElsewhere(run, block, prev, content);
        if (missing.length) {
          const label = missing
            .map((m) => `${m.name}()${m.blocks.length ? ` — ${m.blocks.join(", ")}` : ""}`)
            .join("; ");
          const message = `Файл ${rel}: новая версия удалила функции, которые были раньше и упоминаются в других блоках: ${label}. Возможна потеря готового функционала — тестировщик обязан перепроверить.`;
          const warnings = block.integrityWarnings ?? [];
          if (!warnings.includes(message)) warnings.push(message);
          block.integrityWarnings = warnings.slice(-10);
          this.emit(run, "warn", message, {
            block: block.id,
            file: rel,
            functions: missing.map((m) => m.name),
            referencedBy: [...new Set(missing.flatMap((m) => m.blocks))],
          });
        }
      }
      const stubs = stubFunctions(content);
      if (stubs.length) {
        this.emit(run, "stub", `Заглушки в ${rel}: ${stubs.map((n) => `${n}()`).join(", ")} — пустое тело`, {
          block: block.id,
          file: rel,
          functions: stubs,
        });
      }
      this.store.writeArtifact(run, `work/${rel}`, content);
      run.workspace = run.workspace ?? {};
      run.workspace[rel] = content;
      if (known) known.content = content;
      else block.files.push({ path: rel, content });
      written += 1;
    }
    if (restoredAll.length) {
      this.emit(run, "stub", `Восстановлены тела функций из предыдущей версии: ${restoredAll.join("; ")}`, { block: block.id });
    }
    if (skipped.length) {
      this.emit(run, "stub", `Пустые файлы пропущены (не затирают проект): ${skipped.join(", ")}`, { block: block.id });
    }
    if (!written) {
      throw new Error(`Модель вернула только пустые файлы: ${skipped.join(", ") || "нет путей"} (${notes ?? "без пояснений"})`);
    }
  }

  /** Детерминированный отчёт о функциях с пустым/комментарным телом — идёт тестировщику как автопроверка. */
  stubReport(run) {
    const lines = [];
    for (const { path: file, content } of this.workspaceFiles(run)) {
      const stubs = stubFunctions(content);
      if (stubs.length) {
        lines.push(`- ${file}: ${stubs.map((n) => `${n}()`).join(", ")} — тело пустое или содержит только комментарий/TODO`);
      }
    }
    if (!lines.length) return "";
    return [
      "СТАТИЧЕСКАЯ ПРОВЕРКА (детерминированная, не ИИ): найдены функции без реализации.",
      "Это дефекты: каждая функция обязана иметь рабочее тело, комментарий вместо кода = провал.",
      ...lines,
    ].join("\n");
  }

  /** Предупреждения о пропавших функциях — тестировщик видит их в testOutput. */
  integrityReport(block) {
    const warnings = block?.integrityWarnings ?? [];
    if (!warnings.length) return "";
    return [
      "ПРОВЕРКА ЦЕЛОСТНОСТИ (детерминированная, не ИИ): после правок из файлов исчезли функции, которые были раньше и упоминаются в других блоках.",
      "Это предупреждение, а не приговор: проверь, не потерян ли уже работавший функционал (например, undo/redo, экспорт, поиск), и заведи дефект только если нарушен критерий приёмки.",
      ...warnings.map((w) => `- ${w}`),
    ].join("\n");
  }

  workspaceDir(run) {
    return path.join(this.store.runDir(run.id), "artifacts", "work");
  }

  /**
   * Чем проверять проект. Приоритет:
   *   1) testCommand из config/pipeline.json;
   *   2) npm test, если в артефактах есть package.json со scripts.test;
   *   3) node --test, если в артефактах есть *.test.js / *.spec.js;
   *   4) статический HTML без package.json — node <repo>/scripts/check-dom.mjs <workspace>;
   *   5) output/notepad в артефактах — node <repo>/scripts/check-notepad.mjs.
   * Все команды выполняются в каталоге артефактов (artifacts/work).
   */
  testCommandCandidates(run) {
    const work = this.workspaceDir(run);
    const configured = String(this.config.pipeline?.testCommand ?? "").trim();
    if (configured) return [{ command: configured, cwd: work, label: "команда из config/pipeline.json" }];

    const out = [];
    const pkgPath = path.join(work, "package.json");
    let pkg = null;
    if (fs.existsSync(pkgPath)) {
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, ""));
      } catch {
        pkg = null;
      }
    }
    if (pkg?.scripts?.test) out.push({ command: "npm test", cwd: work, label: "npm test" });
    if (hasTestFiles(work)) out.push({ command: `${quoteCmdArg(process.execPath)} --test`, cwd: work, label: "node --test" });

    const hasHtml = this.workspaceFiles(run).some((f) => /\.html?$/i.test(String(f.path ?? "")));
    if (!out.length && !pkg && hasHtml) {
      const script = path.join(this.repoRoot, "scripts", "check-dom.mjs");
      if (fs.existsSync(script)) {
        out.push({ command: `${quoteCmdArg(process.execPath)} ${quoteCmdArg(script)} ${quoteCmdArg(work)}`, cwd: work, label: "check-dom" });
      }
    }

    if (fs.existsSync(path.join(work, "output", "notepad"))) {
      const script = path.join(this.repoRoot, "scripts", "check-notepad.mjs");
      if (fs.existsSync(script)) {
        out.push({ command: `${quoteCmdArg(process.execPath)} ${quoteCmdArg(script)} ${quoteCmdArg(work)}`, cwd: work, label: "check-notepad" });
      }
    }
    return out;
  }

  /** Вывод автопроверок идёт тестировщику. Падение команды — warn, а не провал блока. */
  async runTestCommand(run, block = null) {
    const candidates = this.testCommandCandidates(run);
    if (!candidates.length) return "";
    const chunks = [];
    for (const candidate of candidates) {
      this.emit(run, "test_command", `Автопроверка: ${candidate.label} (в каталоге артефактов)`, {
        block: block?.id ?? null,
        command: candidate.label,
      });
      let result;
      try {
        result = await runShell(candidate.command, candidate.cwd);
      } catch (err) {
        result = {
          text: `$ ${candidate.command}\n[не удалось запустить: ${String(err?.message || err)}]`,
          failed: true,
          code: "error",
        };
      }
      chunks.push(result.text);
      if (result.failed) {
        this.emit(run, "warn", `Автопроверка «${candidate.label}» не прошла (exit ${result.code}) — это предупреждение, блок не валится`, {
          block: block?.id ?? null,
          command: candidate.label,
          exit: result.code,
        });
      }
    }
    return chunks.join("\n\n");
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
        ? t.defects.map((d) => `- [${d.severity}] \`${d.where}\` — ${d.what}${d.criterion ? ` (критерий: ${d.criterion})` : ""}`)
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

// ---------- Автопроверки: запуск команд ----------

function quoteCmdArg(value) {
  const text = String(value ?? "");
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/**
 * Запуск команды в каталоге артефактов. Ошибки не бросаем: падение проверки — это warn.
 * Вывод пишем в файл через stdio, а не в pipe: в песочнице DSH пайпы (spawn/exec pipe)
 * могут падать с EPERM, а файловые дескрипторы работают.
 */
function runShell(command, cwd) {
  return new Promise((resolve) => {
    let dir = null;
    let logFile = null;
    let timer = null;
    let settled = false;
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let body = "";
      try {
        if (logFile) body = fs.readFileSync(logFile, "utf8");
      } catch {
        body = "";
      }
      try {
        if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      } catch {
        /* лог мог остаться — не критично */
      }
      const tail = body.length > 200_000 ? body.slice(-200_000) : body;
      const out = `$ ${command}\n${tail}${error ? `\n[не удалось запустить: ${String(error?.message || error)}]` : ""}`;
      const failed = Boolean(error) || Number(code) !== 0;
      resolve({ text: failed ? `${out}\n[exit ${code ?? "error"}]` : out, failed, code: code ?? "error" });
    };
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-check-"));
      logFile = path.join(dir, "output.log");
      const fd = fs.openSync(logFile, "a");
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
      });
      fs.closeSync(fd);
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* уже завершился */
        }
        finish("timeout", new Error("таймаут 120 с"));
      }, 120_000);
      child.on("error", (err) => finish("error", err));
      child.on("exit", (code) => finish(code));
    } catch (err) {
      finish("error", err);
    }
  });
}

/** Есть ли в каталоге артефактов тестовые файлы для `node --test`. */
function hasTestFiles(dir, depth = 0) {
  if (depth > 3 || !fs.existsSync(dir)) return false;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasTestFiles(full, depth + 1)) return true;
    } else if (/\.(?:test|spec)\.[cm]?js$/i.test(entry.name)) {
      return true;
    }
  }
  return false;
}

// ---------- Защита от удаления функций, на которые опираются другие блоки ----------

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Имена функций в файле: обычные объявления, prototype-методы, const/let-функции. */
function functionNames(text) {
  const src = String(text ?? "");
  const names = new Set(scanFunctions(src).map((fn) => fn.name));
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\.prototype\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/g)) {
    names.add(m[2]);
  }
  for (const m of src.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g
  )) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Функции, которые были в предыдущей версии файла, исчезли в новой
 * и при этом упоминаются в других блоках (спека/цель/дизайн/их файлы).
 */
function removedFunctionsMentionedElsewhere(run, block, prev, next) {
  const before = functionNames(prev);
  const after = functionNames(next);
  const removed = [...before].filter((name) => !after.has(name));
  if (!removed.length) return [];
  const haystacks = (run.blocks ?? [])
    .filter((other) => other.id !== block.id)
    .map((other) => ({
      id: other.id,
      text: [other.title, other.goal, other.spec, other.design, ...(other.files ?? []).map((f) => f.content)]
        .filter(Boolean)
        .join("\n"),
    }))
    .filter((item) => item.text.trim());
  if (!haystacks.length) return [];
  const out = [];
  for (const name of removed) {
    const re = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}([^\\w$]|$)`);
    const blocks = haystacks.filter((item) => re.test(item.text)).map((item) => item.id);
    if (blocks.length) out.push({ name, blocks });
  }
  return out;
}

// ---------- Статический анализ заглушек (без ИИ) ----------

function skipString(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === quote) return j + 1;
    j += 1;
  }
  return text.length;
}

/** Индекс '{', открывающей тело функции; `from` — сразу после '('. */
function findBodyOpen(text, from) {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i) - 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) return -1;
      i += 1;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth > 0) continue;
      // после ')' ищем '{', пропуская пробелы и комментарии
      for (let j = i + 1; j < text.length; j++) {
        const d = text[j];
        if (d === '"' || d === "'" || d === "`") {
          j = skipString(text, j) - 1;
          continue;
        }
        if (d === "/" && text[j + 1] === "/") {
          j = text.indexOf("\n", j);
          if (j < 0) return -1;
          continue;
        }
        if (d === "/" && text[j + 1] === "*") {
          j = text.indexOf("*/", j + 2);
          if (j < 0) return -1;
          j += 1;
          continue;
        }
        if (d === "{") return j;
        if (d === ";" || d === "=") return -1;
      }
      return -1;
    }
  }
  return -1;
}

function matchBrace(text, open) {
  let depth = 1;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i) - 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) return -1;
      i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Все `function name(...) { ... }` в тексте: {name, open, close}. Строки и комментарии пропускаются. */
function scanFunctions(text) {
  const src = String(text ?? "");
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 2;
      continue;
    }
    if (src.startsWith("function", i) && !/[\w$]/.test(src[i - 1] ?? "")) {
      const m = /^\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(i + 8, i + 208));
      if (m) {
        const name = m[1];
        const parenAt = i + 8 + (m[0].length - 1);
        const open = findBodyOpen(src, parenAt + 1);
        if (open >= 0) {
          const close = matchBrace(src, open);
          if (close > open) {
            out.push({ name, open, close });
            i = close + 1;
            continue;
          }
        }
      }
    }
    i += 1;
  }
  return out;
}

/** Тело — заглушка, если в нём нет кода: пусто, только комментарии, TODO или «not implemented». */
function isStubBody(body) {
  const cleaned = String(body ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim();
  if (!cleaned) return true;
  if (/^(?:todo|fixme|implement|заглушк)/i.test(cleaned)) return true;
  if (/^return\s*(?:undefined|null|false)?\s*;?$/.test(cleaned)) return true;
  if (/^throw\s+new\s+Error\s*\(\s*["'`][^"'`]*(?:not implemented|todo|заглушк)/i.test(cleaned)) return true;
  return false;
}

function stubFunctions(text) {
  const src = String(text ?? "");
  return scanFunctions(src)
    .filter((fn) => isStubBody(src.slice(fn.open + 1, fn.close)))
    .map((fn) => fn.name);
}

/** Вернуть stub-функциям их прежние рабочие тела, если в предыдущей версии они были реализованы. */
function restoreStubBodies(prev, next) {
  const prevFns = new Map(scanFunctions(prev).map((fn) => [fn.name, fn]));
  const replacements = [];
  const restored = [];
  for (const fn of scanFunctions(next)) {
    if (!isStubBody(next.slice(fn.open + 1, fn.close))) continue;
    const old = prevFns.get(fn.name);
    if (!old) continue;
    const oldBody = prev.slice(old.open + 1, old.close);
    if (isStubBody(oldBody)) continue;
    replacements.push({ from: fn.open + 1, to: fn.close, body: oldBody });
    restored.push(fn.name);
  }
  if (!replacements.length) return { content: next, restored };
  let out = next;
  for (const r of replacements.sort((a, b) => b.from - a.from)) {
    out = out.slice(0, r.from) + r.body + out.slice(r.to);
  }
  return { content: out, restored };
}

/** Модели любят обернуть HTML в ```html — снимаем. */
function stripFences(text) {
  const t = String(text ?? "").trim();
  const m = t.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (m && /<(!doctype|html|body|div)/i.test(m[1])) return m[1].trim();
  return t.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/, "").trim();
}

export { isMock };
