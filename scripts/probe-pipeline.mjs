/**
 * probe-pipeline.mjs — проверка доработок пайплайна на своём сервере.
 *
 * Что проверяет:
 *   1. прогон в MOCK завершается done, state.json/events.jsonl — валидный JSON;
 *   2. автопроверка (runTestCommand) реально запускается и её вывод попадает тестировщику;
 *   3. autoAcceptVerified: verified-блоки не ждут ручных кликов;
 *   4. бюджет: config maxCostUsd=0.0001 останавливает вызов, run.maxCostUsd работает так же;
 *   5. model у стадии переопределяет модель агента (по событиям call/call_done);
 *   6. fallback виден в call_done и в счётчике block.fallbacks;
 *   7. защита от удаления функций, на которые опираются другие блоки;
 *   8. resumeWatch возвращает сохранённое состояние дежурного;
 *   9. существующий scripts/check-notepad.mjs не сломан.
 *
 * Запуск: node scripts/probe-pipeline.mjs
 * Сервер: 127.0.0.1:7796, MOCK=1, временные RUNS_DIR/PROJECTS_FILE/MAILBOX_FILE/USERS_FILE/STUDIO_DIR.
 * Exit 1 при любом провале; сервер гасится в finally.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../lib/auth.mjs";
import { Engine } from "../lib/engine.mjs";
import * as P from "../lib/prompts.mjs";
import { resumeWatch, saveWatchState, watchStatePath } from "../lib/watch.mjs";

process.env.MOCK = "1";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const PORT = 7796;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = "XvQ2xTvPrS7z";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} · ${name}${detail ? " — " + detail : ""}`);
}

/* --------------------------- временные данные --------------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-pipeline-"));
const runsDir = path.join(tmp, "runs");
const projectsFile = path.join(tmp, "projects.json");
const mailboxFile = path.join(tmp, "mailbox.json");
const usersFile = path.join(tmp, "users.json");
const studioDir = path.join(tmp, "studio");
const serverLogFile = path.join(tmp, "server.log");

fs.mkdirSync(runsDir, { recursive: true });
fs.mkdirSync(studioDir, { recursive: true });
fs.writeFileSync(
  usersFile,
  JSON.stringify(
    {
      users: [
        {
          id: "u-probe-admin",
          login: "admin",
          passHash: hashPassword(ADMIN_PASSWORD),
          role: "admin",
          createdAt: new Date().toISOString(),
        },
      ],
      sessions: [],
    },
    null,
    2
  ),
  "utf8"
);

/* ----------------------------- запуск сервера ----------------------------- */

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  MOCK: "1",
  RUNS_DIR: runsDir,
  PROJECTS_FILE: projectsFile,
  MAILBOX_FILE: mailboxFile,
  USERS_FILE: usersFile,
  STUDIO_DIR: studioDir,
};
delete serverEnv.AUTH_FILE;

const server = (() => {
  const fd = fs.openSync(serverLogFile, "a");
  const child = spawn(NODE, ["server.mjs"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", fd, fd], windowsHide: true });
  fs.closeSync(fd);
  return child;
})();

function readServerLog() {
  try {
    return fs.readFileSync(serverLogFile, "utf8");
  } catch {
    return "";
  }
}

async function waitReady(ms = 25_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (server.exitCode != null) throw new Error(`сервер завершился (код ${server.exitCode})\n${readServerLog().slice(-1500)}`);
    try {
      const res = await fetch(`${BASE}/api/login`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return;
    } catch {
      /* ещё поднимается */
    }
    await sleep(150);
  }
  throw new Error(`сервер не ответил за ${ms} мс\n${readServerLog().slice(-1500)}`);
}

async function stopServer() {
  if (server.exitCode != null) return;
  server.kill();
  const started = Date.now();
  while (server.exitCode == null && Date.now() - started < 5000) await sleep(100);
  if (server.exitCode == null) server.kill("SIGKILL");
}

/* ----------------------------- HTTP-хелперы ----------------------------- */

async function request(pathname, { method = "GET", cookie, body, timeout = 30_000 } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, headers: res.headers, text };
}

function cookiesFrom(res) {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function sessionCookie(res) {
  for (const raw of cookiesFrom(res)) {
    const first = raw.split(";")[0];
    if (first.startsWith("portal_session=")) return first;
  }
  return null;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function readEvents(runId) {
  const file = path.join(runsDir, runId, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/* ------------------------ прямые проверки движка ------------------------ */

function baseRun({ usage = { prompt: 0, completion: 0, cost: 0, calls: 0 }, blocks = [] } = {}) {
  return {
    id: `direct-${Math.random().toString(16).slice(2)}`,
    task: "Проверка движка",
    status: "running",
    stageIndex: 0,
    blocks,
    workspace: {},
    usage,
    events: [],
    eventSeq: 0,
  };
}

function makeFakeEngine({ pipeline = {}, agents = null } = {}) {
  const events = [];
  const store = {
    save: () => {},
    event: (run, ev) => {
      run.eventSeq = (run.eventSeq ?? 0) + 1;
      const entry = { seq: run.eventSeq, at: new Date().toISOString(), ...ev };
      (run.events ??= []).push(entry);
      events.push(entry);
      return entry;
    },
    writeArtifact: () => "",
    runDir: () => tmp,
  };
  const bus = { emit: () => {} };
  const config = {
    agents: {
      agents:
        agents ?? [
          { id: "coder", name: "Coder", role: "", model: "probe/base-model", temperature: 0.2, prompt: "" },
          { id: "tester", name: "Tester", role: "", model: "probe/base-model", temperature: 0.1, prompt: "" },
        ],
    },
    pipeline: {
      maxFixRounds: 2,
      maxCostUsd: 0.25,
      stages: [
        { id: "spec", title: "Spec", kind: "spec", agent: "coder" },
        { id: "build", title: "Build", kind: "build", agent: "coder" },
      ],
      ...pipeline,
    },
  };
  return { engine: new Engine({ store, config, bus }), events, store, config };
}

/* --------------------------- поиск ID стадии --------------------------- */

let exception = null;
try {
  await waitReady();
  check("сервер поднялся на 7796", true);

  const login = await request("/api/login", { method: "POST", body: { login: "admin", password: ADMIN_PASSWORD } });
  const cookie = sessionCookie(login);
  check("admin XvQ2xTvPrS7z входит (200 + cookie)", login.status === 200 && Boolean(cookie), `статус ${login.status}`);
  if (!cookie) throw new Error("без cookie админа проверять нечего");

  /* ------------------------ конфиг ------------------------ */
  const stateRes = await request("/api/state", { cookie });
  check("GET /api/state → 200", stateRes.status === 200, `статус ${stateRes.status}`);
  const pipeline = stateRes.data.pipeline ?? {};
  check("config/pipeline.json: maxCostUsd=0.25", Number(pipeline.maxCostUsd) === 0.25, String(pipeline.maxCostUsd));
  check("config/pipeline.json: autoAcceptVerified=true", pipeline.autoAcceptVerified === true, String(pipeline.autoAcceptVerified));
  const stages = (pipeline.stages ?? []).filter((s) => s.enabled !== false);
  const specIndex = stages.findIndex((s) => s.kind === "spec");
  check("в пайплайне есть стадия spec (для бюджетного фикстура)", specIndex >= 0, String(specIndex));

  /* ------------------------ 1. обычный прогон задачи ------------------------ */
  const task = "Проверка пайплайна: страница со счётчиком и кнопкой";
  const projectRes = await request("/api/projects", { method: "POST", cookie, body: { name: "Probe pipeline", task } });
  check("проект создан", projectRes.status === 201 && Boolean(projectRes.data.project?.id), `статус ${projectRes.status}`);
  const projectId = projectRes.data.project.id;

  const runRes = await request("/api/runs", { method: "POST", cookie, body: { task, projectId } });
  check("прогон создан", runRes.status === 201 && Boolean(runRes.data.run?.id), `статус ${runRes.status}`);
  const runId = runRes.data.run.id;

  let run = runRes.data.run;
  let approvals = 0;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (run.status === "awaiting") {
      const index = run.stageIndex;
      const gate = await request(`/api/runs/${runId}/approve`, {
        method: "POST",
        cookie,
        body: { decision: "approve" },
      });
      check(`гейт стадии ${index} принят`, gate.status === 200, `статус ${gate.status}`);
      approvals += 1;
      run = gate.data.run ?? run;
      continue;
    }
    if (["done", "failed", "cancelled"].includes(run.status)) break;
    await sleep(300);
    const next = await request(`/api/runs/${runId}`, { cookie });
    run = next.data.run ?? run;
  }

  check("прогон завершился done без ручных решений по блокам", run.status === "done", `статус ${run.status}, ошибка: ${run.error ?? "—"}`);
  check("гейты плана и макета пройдены", approvals >= 2, `подтверждений: ${approvals}`);
  check("в прогоне 3 блока (из MOCK-плана)", (run.blocks ?? []).length === 3, `блоков: ${run.blocks?.length}`);

  const stateFile = path.join(runsDir, runId, "state.json");
  let persisted = null;
  try {
    persisted = readJsonFile(stateFile);
    check("state.json — валидный JSON", true);
  } catch (err) {
    check("state.json — валидный JSON", false, String(err?.message || err));
  }

  let events = [];
  try {
    events = readEvents(runId);
    check("events.jsonl — валидный построчный JSON", events.length > 0, `строк: ${events.length}`);
  } catch (err) {
    check("events.jsonl — валидный построчный JSON", false, String(err?.message || err));
  }

  /* ------------------- 2. реальный testCommand ------------------- */
  const testCommandEvents = events.filter((e) => e.kind === "test_command");
  check("автопроверка запускалась (событие test_command)", testCommandEvents.length > 0, `событий: ${testCommandEvents.length}`);
  check(
    "для статического HTML выбран check-dom",
    testCommandEvents.some((e) => String(e.command ?? "") === "check-dom"),
    testCommandEvents.map((e) => e.command).join(", ")
  );
  const blockTestOutput = (persisted?.blocks ?? []).map((b) => b.test?.testOutput ?? "").join("\n");
  check(
    "вывод check-dom попал в testOutput тестировщика",
    /check-dom\.mjs/.test(blockTestOutput),
    blockTestOutput.slice(0, 160).replace(/\n/g, " | ")
  );

  // упавшая команда — предупреждение, а не исключение и не провал блока
  {
    const { engine, events: directEvents } = makeFakeEngine({
      pipeline: { testCommand: `"${NODE}" -e "process.exit(3)"` },
    });
    fs.mkdirSync(path.join(tmp, "artifacts", "work"), { recursive: true });
    const run = baseRun();
    let threw = false;
    let output = "";
    try {
      output = await engine.runTestCommand(run, { id: "b1" });
    } catch {
      threw = true;
    }
    check("упавшая автопроверка не бросает исключение", !threw);
    check("упавшая автопроверка даёт warn", directEvents.some((e) => e.kind === "warn" && /Автопроверка/.test(String(e.message))), directEvents.map((e) => e.kind).join(", "));
    check("вывод упавшей автопроверки уходит тестировщику", /\[exit 3\]/.test(output), output.slice(0, 120).replace(/\n/g, " | "));
  }

  /* ------------------- 3. autoAcceptVerified ------------------- */
  if (persisted) {
    const blocks = persisted.blocks ?? [];
    check("все блоки verified", blocks.length > 0 && blocks.every((b) => b.status === "verified"), blocks.map((b) => `${b.id}:${b.status}`).join(" "));
    check(
      "verified-блоки приняты автоматически (autoAccepted/manual.auto)",
      blocks.every((b) => b.autoAccepted === true && b.manual?.decision === "accept" && b.manual?.auto === true),
      blocks.map((b) => `${b.id}:auto=${b.autoAccepted}`).join(" ")
    );
    check(
      "у блоков есть счётчик fallbacks",
      blocks.every((b) => Number.isFinite(Number(b.fallbacks))),
      blocks.map((b) => `${b.id}:${b.fallbacks}`).join(" ")
    );
    check("MOCK не подменял модель (fallbacks=0)", blocks.every((b) => Number(b.fallbacks) === 0));
  }
  check("в событиях есть autoAcceptVerified", events.some((e) => e.kind === "approve" && e.auto === true));

  /* ------------------- 4. бюджет (per-run 0.0001) ------------------- */
  const budgetRunId = "20260101-000000-probe-budget";
  const budgetRunDir = path.join(runsDir, budgetRunId);
  fs.mkdirSync(path.join(budgetRunDir, "artifacts", "work"), { recursive: true });
  const budgetBlock = {
    id: "b1",
    title: "Бюджетный блок",
    goal: "Ничего не потратить",
    acceptance: ["вызов не должен произойти"],
    deps: [],
    status: "planned",
    spec: null,
    design: null,
    files: [],
    test: null,
    fixes: [],
    history: [],
    fallbacks: 0,
  };
  fs.writeFileSync(
    path.join(budgetRunDir, "state.json"),
    JSON.stringify(
      {
        id: budgetRunId,
        task: "Проверка бюджета прогона",
        change: null,
        baseId: null,
        projectId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "interrupted",
        stageIndex: specIndex,
        awaiting: null,
        plan: { title: "Бюджет", blocks: [{ id: "b1", title: budgetBlock.title, goal: budgetBlock.goal, acceptance: budgetBlock.acceptance, deps: [] }] },
        blocks: [budgetBlock],
        approvals: {},
        stageMeta: {},
        workspace: {},
        usage: { prompt: 0, completion: 0, cost: 0.0002, calls: 1 },
        maxCostUsd: 0.0001,
        error: null,
        eventSeq: 0,
      },
      null,
      2
    ),
    "utf8"
  );
  const resumeBudget = await request(`/api/runs/${budgetRunId}/resume`, { method: "POST", cookie });
  check("resume бюджетного фикстура принят (202)", resumeBudget.status === 202, `статус ${resumeBudget.status}`);
  let budgetSnapshot = resumeBudget.data.run;
  let budgetStatus = budgetSnapshot?.status ?? "running";
  const budgetDeadline = Date.now() + 10_000;
  while (Date.now() < budgetDeadline) {
    const poll = await request(`/api/runs/${budgetRunId}`, { cookie });
    budgetSnapshot = poll.data.run;
    budgetStatus = budgetSnapshot?.status;
    if (["failed", "done", "cancelled"].includes(budgetStatus)) break;
    await sleep(150);
  }
  check("бюджет остановил прогон (failed)", budgetStatus === "failed", `статус ${budgetStatus}`);
  check(
    "ошибка про бюджет прогона с суммой из maxCostUsd",
    /бюджет прогона исчерпан \(\$0\.0002 из \$0\.0001\)/.test(String(budgetSnapshot?.error ?? "")),
    String(budgetSnapshot?.error ?? "")
  );

  /* ------------------- 4b. бюджет из config maxCostUsd=0.0001 ------------------- */
  {
    const { engine } = makeFakeEngine({ pipeline: { maxCostUsd: 0.0001 } });
    const run = baseRun({ usage: { prompt: 0, completion: 0, cost: 0.0002, calls: 1 } });
    let message = "";
    try {
      await engine.call(run, engine.agent("coder"), { kind: "spec", stageId: "spec", system: "", user: "", json: false });
    } catch (err) {
      message = String(err?.message || err);
    }
    check(
      "config maxCostUsd=0.0001 тоже останавливает вызов",
      /бюджет прогона исчерпан \(\$0\.0002 из \$0\.0001\)/.test(message),
      message
    );
  }

  /* ------------------- 5. model у стадии ------------------- */
  {
    const { engine, events: directEvents } = makeFakeEngine({
      pipeline: {
        stages: [
          { id: "spec", title: "Spec", kind: "spec", agent: "coder", model: "probe/stage-model" },
          { id: "build", title: "Build", kind: "build", agent: "coder" },
        ],
      },
    });
    const run = baseRun();
    await engine.call(run, engine.agent("coder"), { kind: "spec", stageId: "spec", system: "", user: "", json: false });
    const call = directEvents.find((e) => e.kind === "call");
    const done = directEvents.find((e) => e.kind === "call_done");
    check("call использует model стадии", call?.model === "probe/stage-model", call?.model);
    check("call помечает stageModel/stageId", call?.stageModel === true && call?.stageId === "spec", JSON.stringify({ stageModel: call?.stageModel, stageId: call?.stageId }));
    check("call_done сообщает fallback=false и originalModel=null", done?.fallback === false && done?.originalModel === null, JSON.stringify({ fallback: done?.fallback, originalModel: done?.originalModel }));
  }

  /* ------------------- 6. fallback виден в call_done и block.fallbacks ------------------- */
  {
    const { engine, events: directEvents } = makeFakeEngine();
    const fallbackResult = {
      text: '{"ok":true}',
      data: { ok: true },
      model: "google/gemini-2.5-flash-lite (fallback)",
      fallback: true,
      originalModel: "probe/base-model",
      usage: { prompt: 10, completion: 5, cost: 0.01 },
      finishReason: "stop",
    };
    engine.llm = { askJson: async () => fallbackResult, complete: async () => fallbackResult, isMock: () => true };
    const block = { id: "b1", fallbacks: 0 };
    const run = baseRun();
    await engine.call(run, engine.agent("coder"), { kind: "build", stageId: "build", system: "", user: "", json: true, meta: { block } });
    const done = directEvents.find((e) => e.kind === "call_done");
    check("call_done: fallback=true", done?.fallback === true, JSON.stringify(done?.fallback));
    check("call_done: originalModel — исходная модель", done?.originalModel === "probe/base-model", done?.originalModel);
    check("block.fallbacks увеличился", block.fallbacks === 1, String(block.fallbacks));

    const promptText = P.testPrompt({
      task: "t",
      block: { id: "b1", title: "B" },
      spec: "",
      files: [],
      testOutput: "",
      fallbacks: 1,
    }).user;
    check(
      "тестировщик получает пометку про резервную модель",
      /резервной моделью/.test(promptText) && /проверь внимательнее/.test(promptText)
    );
  }

  /* ------------------- 7. защита от удаления функций чужого блока ------------------- */
  {
    const { engine, events: directEvents } = makeFakeEngine();
    const shared = "function undo() {\n  return 1;\n}\nfunction keep() {\n  return 2;\n}\n";
    const run = baseRun();
    run.workspace = { "app.js": shared };
    const b1 = { id: "b1", title: "Правка", files: [] };
    const b2 = {
      id: "b2",
      title: "Undo",
      goal: "",
      spec: "Кнопка Undo вызывает undo() и возвращает текст",
      design: null,
      files: [{ path: "app.js", content: shared }],
      status: "verified",
    };
    run.blocks = [b1, b2];
    engine.applyFiles(run, b1, [{ path: "app.js", content: "function other() {\n  return 3;\n}\n" }], "тест");
    const warn = directEvents.find((e) => e.kind === "warn" && e.file === "app.js");
    check("удаление undo() из общего файла даёт warn", Boolean(warn) && warn.functions?.includes("undo"), JSON.stringify(warn?.functions ?? []));
    check("warn попал в integrityWarnings блока", (b1.integrityWarnings ?? []).some((w) => w.includes("undo")));
    const marked = engine.markDependentsForRecheck(run, b1, [{ path: "app.js" }]);
    check("verified-блок b2 поставлен в очередь повторной проверки", marked.includes("b2") && b2.needsRecheck === true, marked.join(", "));
  }

  /* ------------------- 8. resumeWatch ------------------- */
  {
    const watchRuns = path.join(tmp, "watch-runs");
    const lastRunAt = "2026-10-26T12:34:56.000Z";
    saveWatchState({ running: true, everyMin: 7, lastRunAt }, { runsDir: watchRuns });
    check("watch.state.json создан в каталоге запусков", fs.existsSync(watchStatePath({ runsDir: watchRuns })), watchStatePath({ runsDir: watchRuns }));
    const resumed = resumeWatch({ runsDir: watchRuns });
    check(
      "resumeWatch вернул running/everyMin/lastRunAt",
      resumed.running === true && resumed.everyMin === 7 && resumed.lastRunAt === lastRunAt,
      JSON.stringify(resumed)
    );
    saveWatchState({ running: "yes", everyMin: 9999, lastRunAt: 42 }, { runsDir: watchRuns });
    const normalized = resumeWatch({ runsDir: watchRuns });
    check(
      "битые значения нормализуются",
      normalized.running === false && normalized.everyMin === 1440 && normalized.lastRunAt === null,
      JSON.stringify(normalized)
    );
    const empty = resumeWatch({ runsDir: path.join(tmp, "no-watch-state") });
    check("без файла resumeWatch отдаёт дефолты", empty.running === false && empty.everyMin === 10 && empty.lastRunAt === null, JSON.stringify(empty));
  }

  /* ------------------- 9. check-notepad не сломан ------------------- */
  {
    const logFile = path.join(tmp, "check-notepad.log");
    const fd = fs.openSync(logFile, "a");
    const child = spawn(NODE, [path.join("scripts", "check-notepad.mjs")], {
      cwd: ROOT,
      env: { ...process.env, MOCK: "1" },
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    fs.closeSync(fd);
    const code = await new Promise((resolve) => {
      child.on("exit", (value) => resolve(value ?? 1));
      child.on("error", () => resolve(1));
    });
    const log = fs.readFileSync(logFile, "utf8");
    check("scripts/check-notepad.mjs → exit 0", code === 0, `код ${code}`);
    check("check-notepad: нет провалов", /Summary:\s*\d+ passed,\s*0 failed/.test(log), log.trim().split(/\r?\n/).slice(-2).join(" | "));
  }
} catch (err) {
  exception = err;
  failed = Math.max(failed, 1);
  console.error("FAIL · исключение:", err?.stack || err);
  const log = readServerLog();
  if (log) console.error("--- хвост лога сервера ---\n" + log.slice(-2000));
} finally {
  await stopServer();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* временный каталог мог остаться — на результат не влияет */
  }
}

if (exception) console.error(`\nисключение: ${exception.message}`);
console.log(failed ? `\nпровалов: ${failed}` : "\nвсе проверки прошли");
process.exitCode = failed ? 1 : 0;
