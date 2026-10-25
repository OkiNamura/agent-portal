#!/usr/bin/env node
/**
 * Static + headless checks for output/notepad.
 *
 * - static: ids, duplicate ids, file references, JS syntax, execCommand,
 *   DOMContentLoaded boot, unknown this.* methods and NotepadPure exports;
 * - pure helpers: countStats / parseLineNumber / lineStartIndex / findMatches /
 *   replaceAllMatches executed through the global NotepadPure object;
 * - DOM shim: boots the real scripts and walks the main user scenarios
 *   (typing, undo/redo, find, replace, replace all, go to line, view, files).
 *
 * No external packages. Exit code 1 on any failure.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIR = path.join(ROOT, "output", "notepad");

let passed = 0;
let failed = 0;

function pass(name) {
  passed += 1;
  console.log(`PASS  ${name}`);
}

function fail(name, detail = "") {
  failed += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function check(condition, name, detail = "") {
  if (condition) pass(name);
  else fail(name, detail);
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function scenario(name, fn) {
  try {
    fn();
    pass(name);
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error));
  }
}

function read(name) {
  return fs.readFileSync(path.join(DIR, name), "utf8");
}

/* ------------------------------------------------------------------ */
/* 1. Static checks                                                    */
/* ------------------------------------------------------------------ */

section("static structure");

const REQUIRED_FILES = [
  "index.html",
  "base.css",
  "search.css",
  "view.css",
  "theme.css",
  "core.js",
  "status.js",
  "search.js",
  "view.js",
];

for (const name of REQUIRED_FILES) {
  check(fs.existsSync(path.join(DIR, name)), `file exists: ${name}`);
}

const html = read("index.html");
const baseCss = read("base.css");
const searchCss = read("search.css");
const viewCss = read("view.css");
const themeCss = read("theme.css");

const scriptRefs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
const styleRefs = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);

check(
  JSON.stringify(scriptRefs) ===
    JSON.stringify(["core.js", "status.js", "search.js", "view.js"]),
  "scripts loaded in dependency order",
  scriptRefs.join(", ")
);

for (const ref of [...scriptRefs, ...styleRefs]) {
  const external = /^(?:https?:)?\/\//.test(ref);
  check(!external && fs.existsSync(path.join(DIR, ref)), `reference resolves: ${ref}`);
}

const idList = [...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
const idSet = new Set(idList);
const duplicateIds = idList.filter((id, index) => idList.indexOf(id) !== index);
check(duplicateIds.length === 0, "no duplicate ids", [...new Set(duplicateIds)].join(", "));
check(idSet.has("editor") && idSet.has("fileInput"), "editor and file input exist");
check(/<input\b[^>]*id="fileInput"[^>]*accept="\.txt[^"]*"/.test(html),
  "file input accepts .txt");

const jsNames = scriptRefs.filter((ref) => ref.endsWith(".js"));
const jsSources = new Map(jsNames.map((name) => [name, read(name)]));
const allJs = [...jsSources.entries()].map(([name, src]) => `/* ${name} */\n${src}`).join("\n");

const usedIds = new Set();
for (const src of jsSources.values()) {
  for (const match of src.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
    usedIds.add(match[1]);
  }
  for (const match of src.matchAll(/querySelector\(\s*["']#([\w-]+)["']\s*\)/g)) {
    usedIds.add(match[1]);
  }
}
const missingFromHtml = [...usedIds].filter((id) => !idSet.has(id));
check(missingFromHtml.length === 0,
  "every getElementById id exists in HTML", missingFromHtml.join(", "));

for (const [name, src] of jsSources) {
  try {
    new Function(src); // compile only, do not run
    pass(`JavaScript parses: ${name}`);
  } catch (error) {
    fail(`JavaScript parses: ${name}`, error.message);
  }
}

check(!/document\s*\.\s*execCommand/.test(allJs),
  "no deprecated document.execCommand");
check(!/\son[a-z]+\s*=\s*["']/i.test(html),
  "no inline event handler attributes");
check(/beforeunload/.test(jsSources.get("core.js") || ""),
  "beforeunload warning is implemented");
check(/new Blob/.test(jsSources.get("core.js") || "") &&
  /\.download\s*=/.test(jsSources.get("core.js") || ""),
  "save uses Blob + download");
check(/new FileReader/.test(jsSources.get("core.js") || "") &&
  /readAsText/.test(jsSources.get("core.js") || ""),
  "open uses FileReader.readAsText");
check(/typeof confirm/.test(jsSources.get("core.js") || ""),
  "unsaved changes are confirmed");
check(/DOMContentLoaded/.test(allJs),
  "DOMContentLoaded boot is used");

for (const name of jsNames) {
  check(/DOMContentLoaded/.test(jsSources.get(name) || ""),
    `boot is deferred until DOM is ready: ${name}`);
}

const prototypeMethods = new Set(
  [...allJs.matchAll(/\.prototype\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1])
);
for (const match of allJs.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
  prototypeMethods.add(match[1]);
}
const thisCalls = new Set(
  [...allJs.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
);
const unknownThisCalls = [...thisCalls].filter((name) => !prototypeMethods.has(name));
check(unknownThisCalls.length === 0,
  "no this.* calls to missing methods", unknownThisCalls.join(", "));

check(/body\.dark-theme/.test(themeCss), "dark theme class is styled");
const darkThemeBlock = themeCss.slice(themeCss.indexOf("body.dark-theme"));
check(
  darkThemeBlock.includes("--panel-bg") &&
    darkThemeBlock.includes("--panel-header-bg") &&
    darkThemeBlock.includes("--input-bg"),
  "dark theme defines panel and input tokens"
);
check(/\.panel\s*\{[^}]*background:\s*var\(--panel-bg\)/s.test(searchCss),
  "find/replace panels use the themed background");
check(/\.panel-content\s+input\[type="text"\]\s*\{[^}]*background:\s*var\(--input-bg\)/s.test(searchCss),
  "panel inputs use themed input colors");
check(/\.status\.is-error/.test(searchCss), "search errors have a distinct style");
check(/#editor\.wrap/.test(baseCss), "word-wrap class is styled");
check(/#editor\s*\{[^}]*white-space:\s*pre/s.test(baseCss),
  "editor defaults to no-wrap");

const themeVariables = new Set(
  [...themeCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1])
);
const cssFiles = [
  ["base.css", baseCss],
  ["search.css", searchCss],
  ["view.css", viewCss],
  ["theme.css", themeCss],
];
for (const [name, css] of cssFiles) {
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  check(open === close, `balanced braces: ${name}`, `${open} { vs ${close} }`);
  const usedVars = [...new Set(
    [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1])
  )];
  const unknown = usedVars.filter((variable) => !themeVariables.has(variable));
  check(unknown.length === 0,
    `all CSS variables are defined: ${name}`, unknown.join(", "));
}

/* ------------------------------------------------------------------ */
/* 2. Pure helpers (execute core.js with a no-op DOM)                  */
/* ------------------------------------------------------------------ */

section("pure helpers");

const pureDocument = {
  readyState: "loading",
  addEventListener() {},
};
const pureSandbox = {
  console,
  document: pureDocument,
  setTimeout() {},
};
vm.createContext(pureSandbox);
vm.runInContext(jsSources.get("core.js"), pureSandbox, { filename: "core.js" });
const pure = pureSandbox.NotepadPure;

check(Boolean(pure), "core.js exposes globalThis.NotepadPure");
check(Boolean(pureSandbox.NotepadApp), "core.js exposes globalThis.NotepadApp");

if (pure) {
  for (const key of ["countStats", "parseLineNumber", "lineStartIndex", "findMatches",
    "replaceAllMatches", "formatStats", "countLines"]) {
    check(typeof pure[key] === "function", `helper exported: ${key}`);
  }

  const plain = (value) => JSON.parse(JSON.stringify(value));
  scenario("countStats: empty document", () => {
    assert.deepEqual(plain(pure.countStats("")), { lines: 1, words: 0, characters: 0 });
  });
  scenario("countStats: lines, words, characters", () => {
    assert.deepEqual(plain(pure.countStats("a b\nc")), { lines: 2, words: 3, characters: 5 });
  });
  scenario("countStats: trailing newline is an extra line", () => {
    assert.deepEqual(plain(pure.countStats("one\n")), { lines: 2, words: 1, characters: 4 });
  });
  scenario("countStats: whitespace only", () => {
    assert.deepEqual(plain(pure.countStats("   \n\t")), { lines: 2, words: 0, characters: 5 });
  });
  scenario("countStats: unicode words", () => {
    assert.deepEqual(plain(pure.countStats("привет мир")), { lines: 1, words: 2, characters: 10 });
  });
  scenario("countLines", () => {
    assert.equal(pure.countLines("a\nb\n"), 3);
    assert.equal(pure.countLines(""), 1);
  });
  scenario("lineStartIndex", () => {
    assert.equal(pure.lineStartIndex("aa\nbb\ncc", 1), 0);
    assert.equal(pure.lineStartIndex("aa\nbb\ncc", 2), 3);
    assert.equal(pure.lineStartIndex("aa\nbb\ncc", 3), 6);
    assert.equal(pure.lineStartIndex("aa\nbb\ncc", 0), -1);
    assert.equal(pure.lineStartIndex("aa\nbb\ncc", 4), -1);
  });
  scenario("parseLineNumber: valid numbers", () => {
    assert.deepEqual(plain(pure.parseLineNumber("3", 10)), { ok: true, line: 3 });
    assert.deepEqual(plain(pure.parseLineNumber(" 3 ", 10)), { ok: true, line: 3 });
    assert.deepEqual(plain(pure.parseLineNumber("10", 10)), { ok: true, line: 10 });
  });
  scenario("parseLineNumber: empty / non-numeric / decimal / trailing junk", () => {
    for (const value of ["", "  ", "abc", "3abc", "3.5", "1e3", "-1", "+2"]) {
      const result = pure.parseLineNumber(value, 10);
      assert.equal(result.ok, false, `expected invalid: ${JSON.stringify(value)}`);
      assert.equal(typeof result.message, "string");
      assert.ok(result.message.length > 0);
    }
    assert.match(pure.parseLineNumber("abc", 10).message, /whole number/);
    assert.match(pure.parseLineNumber("3.5", 10).message, /whole number/);
  });
  scenario("parseLineNumber: zero, negative and out of range", () => {
    assert.match(pure.parseLineNumber("0", 10).message, /at least 1/);
    assert.match(pure.parseLineNumber("11", 10).message, /out of range \(1-10\)/);
    assert.match(pure.parseLineNumber("", 10).message, /Enter a line number/);
    assert.match(pure.parseLineNumber("999999999999999999999", 10).message, /too large/);
  });
  scenario("findMatches: case-insensitive, non-overlapping", () => {
    const matches = pure.findMatches("alpha beta alpha gamma ALPHA", "alpha");
    assert.equal(matches.length, 3);
    assert.deepEqual(plain(matches.map((m) => m.start)), [0, 11, 23]);
    assert.equal(pure.findMatches("aaaa", "aa").length, 2);
    assert.equal(pure.findMatches("abc", "").length, 0);
    assert.equal(pure.findMatches("abc", "zzz").length, 0);
  });
  scenario("findMatches: case-sensitive mode", () => {
    assert.equal(pure.findMatches("alpha ALPHA", "alpha", true).length, 1);
  });
  scenario("replaceAllMatches", () => {
    const text = "foo bar foo";
    const matches = pure.findMatches(text, "foo");
    assert.equal(pure.replaceAllMatches(text, matches, "X"), "X bar X");
    assert.equal(pure.replaceAllMatches(text, matches, ""), " bar ");
  });
  scenario("formatStats", () => {
    assert.equal(
      pure.formatStats({ lines: 2, words: 3, characters: 5 }),
      "Lines: 2 | Words: 3 | Characters: 5"
    );
  });
}

const usedPure = new Set(
  [...allJs.matchAll(/NotepadPure\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
);
if (pure) {
  const missingPure = [...usedPure].filter((name) => typeof pure[name] !== "function");
  check(missingPure.length === 0,
    "all NotepadPure.* calls resolve", missingPure.join(", "));
}

/* ------------------------------------------------------------------ */
/* 3. DOM shim                                                         */
/* ------------------------------------------------------------------ */

function createSandbox() {
  const state = {
    downloads: [],
    alerts: [],
    confirms: [],
    confirmResult: true,
    missingIds: new Set(),
    winListeners: new Map(),
    timers: [],
  };

  const URLShim = {
    _blobs: new Map(),
    _counter: 0,
    createObjectURL(blob) {
      const id = `blob:mock/${this._counter += 1}`;
      this._blobs.set(id, blob);
      return id;
    },
    revokeObjectURL(id) {
      this._blobs.delete(id);
    },
  };

  class BlobShim {
    constructor(parts, options) {
      this.parts = parts || [];
      this.type = (options && options.type) || "";
    }
  }

  class ClassList {
    constructor() {
      this.items = new Set();
    }
    add(...names) {
      for (const name of names) this.items.add(name);
    }
    remove(...names) {
      for (const name of names) this.items.delete(name);
    }
    contains(name) {
      return this.items.has(name);
    }
    toggle(name, force) {
      const enabled = force === undefined ? !this.items.has(name) : Boolean(force);
      if (enabled) this.items.add(name);
      else this.items.delete(name);
      return enabled;
    }
    get value() {
      return [...this.items].join(" ");
    }
  }

  function dispatch(element, type, props = {}) {
    const event = {
      type,
      target: element,
      currentTarget: element,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      key: "",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      returnValue: undefined,
      ...props,
    };
    const handlers = (element.listeners.get(type) || []).slice();
    for (const handler of handlers) handler(event);
    return event;
  }

  class Element {
    constructor(tag, rawAttrs = "", attrs = {}) {
      this.tagName = tag.toUpperCase();
      this.id = attrs.id || "";
      this.attributes = { ...attrs };
      this.rawAttributes = rawAttrs;
      this.listeners = new Map();
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this.classList = new ClassList();
      this.value = attrs.value !== undefined ? attrs.value : "";
      this.type = attrs.type || (this.tagName === "TEXTAREA" ? "textarea" : "text");
      this.checked = /\bchecked\b/.test(rawAttrs);
      this.disabled = /\bdisabled\b/.test(rawAttrs);
      this.textContent = "";
      this.title = attrs.title || "";
      this.files = null;
      this.href = "";
      this.download = "";
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.scrollTop = 0;
      this.clientHeight = 400;
      this.scrollHeight = 400;
      this.clickCount = 0;
      if (attrs.style && /display:\s*none/i.test(attrs.style)) this.style.display = "none";
      if (/\bhidden\b/.test(rawAttrs)) this.style.display = "none";
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }

    removeEventListener(type, handler) {
      const list = this.listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    }

    dispatchEvent(event) {
      return dispatch(this, event.type || "event", event);
    }

    click() {
      if (this.disabled) return;
      this.clickCount += 1;
      if (this.tagName === "A" && this.href) {
        const blob = URLShim._blobs.get(this.href);
        state.downloads.push({
          href: this.href,
          download: this.download,
          text: blob ? blob.parts.join("") : null,
        });
      }
      dispatch(this, "click");
    }

    focus() {
      dom.activeElement = this;
    }

    blur() {
      if (dom.activeElement === this) dom.activeElement = dom.body;
    }

    select() {
      this.setSelectionRange(0, String(this.value).length);
    }

    setSelectionRange(start, end) {
      const max = String(this.value).length;
      const from = Math.max(0, Math.min(max, Number(start) || 0));
      const to = Math.max(0, Math.min(max, Number(end) || 0));
      this.selectionStart = Math.min(from, to);
      this.selectionEnd = Math.max(from, to);
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "wrap") this.wrap = String(value);
    }

    getAttribute(name) {
      return this.attributes[name] !== undefined ? this.attributes[name] : null;
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    }
  }

  const elements = new Map();
  const specs = [];
  for (const match of html.matchAll(/<([A-Za-z][\w-]*)([^>]*)>/g)) {
    const rawAttrs = match[2];
    const attrs = {};
    for (const attr of rawAttrs.matchAll(/([:\w-]+)\s*=\s*"([^"]*)"/g)) {
      attrs[attr[1]] = attr[2];
    }
    if (attrs.id) specs.push({ tag: match[1], rawAttrs, attrs });
  }
  for (const spec of specs) {
    elements.set(spec.attrs.id, new Element(spec.tag, spec.rawAttrs, spec.attrs));
  }

  const dom = {
    readyState: "loading",
    title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "",
    body: new Element("body"),
    documentElement: new Element("html"),
    activeElement: null,
    listeners: new Map(),
    getElementById(id) {
      const element = elements.get(id);
      if (!element) state.missingIds.add(id);
      return element || null;
    },
    querySelector(selector) {
      if (selector.startsWith("#")) return this.getElementById(selector.slice(1));
      return null;
    },
    createElement(tag) {
      return new Element(tag);
    },
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this.listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    },
  };
  dom.activeElement = dom.body;

  class FileReaderShim {
    readAsText(file) {
      if (file && file.__error) {
        if (this.onerror) this.onerror({ target: this });
        return;
      }
      this.result = file && file.__text !== undefined ? file.__text : "";
      if (this.onload) this.onload({ target: this });
    }
  }

  const sandbox = {
    console,
    document: dom,
    Blob: BlobShim,
    URL: URLShim,
    FileReader: FileReaderShim,
    confirm(message) {
      state.confirms.push(message);
      return state.confirmResult;
    },
    alert(message) {
      state.alerts.push(message);
    },
    setTimeout(handler) {
      state.timers.push(handler);
      return state.timers.length;
    },
    clearTimeout() {},
    getComputedStyle() {
      return { lineHeight: "24px" };
    },
    addEventListener(type, handler) {
      if (!state.winListeners.has(type)) state.winListeners.set(type, []);
      state.winListeners.get(type).push(handler);
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  for (const name of jsNames) {
    vm.runInContext(jsSources.get(name), context, { filename: name });
  }

  dom.readyState = "interactive";
  for (const handler of (dom.listeners.get("DOMContentLoaded") || []).slice()) {
    handler({ type: "DOMContentLoaded", target: dom });
  }
  dom.readyState = "complete";

  const app = context.NotepadApp;

  function element(id) {
    const found = elements.get(id);
    if (!found) throw new Error(`missing test element #${id}`);
    return found;
  }

  function click(id) {
    element(id).click();
  }

  function typeInEditor(text, cursor = text.length) {
    const editor = element("editor");
    editor.value = text;
    editor.setSelectionRange(cursor, cursor);
    dispatch(editor, "input", { target: editor });
    return editor;
  }

  function typeInto(id, value) {
    const input = element(id);
    input.value = value;
    dispatch(input, "input", { target: input });
    return input;
  }

  function documentKey(key, options = {}) {
    const event = {
      type: "keydown",
      target: options.target || dom.activeElement || dom.body,
      currentTarget: dom,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      ...options,
    };
    for (const handler of (dom.listeners.get("keydown") || []).slice()) {
      handler(event);
    }
    return event;
  }

  function fireBeforeUnload() {
    const event = {
      type: "beforeunload",
      target: sandbox,
      defaultPrevented: false,
      returnValue: undefined,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    const results = [];
    for (const handler of (state.winListeners.get("beforeunload") || []).slice()) {
      results.push(handler(event));
    }
    return { event, results };
  }

  return {
    app,
    context,
    dom,
    elements,
    element,
    click,
    typeInEditor,
    typeInto,
    documentKey,
    fireBeforeUnload,
    state,
  };
}

section("DOM shim scenarios");

const harness = createSandbox();
const {
  app,
  dom,
  element,
  click,
  typeInEditor,
  typeInto,
  documentKey,
  fireBeforeUnload,
  state,
} = harness;

check(Boolean(app), "NotepadApp exists after DOMContentLoaded");
check(Boolean(app && app.core && app.status && app.search && app.view),
  "core, status, search and view controllers are created");

if (!app || !app.core || !app.status || !app.search || !app.view) {
  console.log("\nCannot continue DOM scenarios without booted controllers.");
  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

check(state.missingIds.size === 0,
  "every runtime getElementById found its element", [...state.missingIds].join(", "));
check(element("searchPanel").style.display === "none" &&
  element("replacePanel").style.display === "none" &&
  element("gotoPanel").style.display === "none",
  "all panels start hidden");
check(dom.title === "Untitled.txt - Notepad", "initial window title", dom.title);
check(element("fileName").textContent === "Untitled.txt",
  "initial file name is shown");
check(element("stats").textContent === "Lines: 1 | Words: 0 | Characters: 0",
  "initial status bar", element("stats").textContent);
check(element("undoBtn").disabled === true && element("redoBtn").disabled === true,
  "undo/redo disabled on an empty document");

scenario("typing updates counters, dirty flag and title", () => {
  app.core.resetDocument("", "Untitled.txt");
  typeInEditor("hello world\nsecond line");
  assert.equal(element("stats").textContent,
    "Lines: 2 | Words: 4 | Characters: 23");
  assert.equal(app.core.isDirty(), true);
  assert.equal(dom.title, "*Untitled.txt - Notepad");
  assert.equal(element("undoBtn").disabled, false);
});

scenario("custom undo/redo history restores text and selection", () => {
  app.core.resetDocument("", "Untitled.txt");
  typeInEditor("abc", 3);
  app.core.breakHistoryGroup();
  typeInEditor("abcd", 4);
  assert.equal(app.core.undo(), true);
  assert.equal(element("editor").value, "abc");
  assert.equal(app.core.undo(), true);
  assert.equal(element("editor").value, "");
  assert.equal(app.core.redo(), true);
  assert.equal(element("editor").value, "abc");
  assert.equal(app.core.redo(), true);
  assert.equal(element("editor").value, "abcd");
  assert.equal(element("redoBtn").disabled, true);
});

scenario("typing history is grouped per word, not per whole document", () => {
  app.core.resetDocument("", "history.txt");
  const editor = element("editor");
  const insert = (data, inputType = "insertText") => {
    editor.value += data;
    editor.setSelectionRange(editor.value.length, editor.value.length);
    editor.dispatchEvent({ type: "input", inputType, data });
  };
  insert("a");
  insert("b");
  insert(" ");
  insert("c");
  app.core.undo();
  assert.equal(editor.value, "ab ");
  app.core.undo();
  assert.equal(editor.value, "ab");
  app.core.undo();
  assert.equal(editor.value, "");
});

scenario("Ctrl+Z / Ctrl+Y shortcuts use the custom history", () => {
  app.core.resetDocument("", "keys.txt");
  typeInEditor("abc", 3);
  app.core.breakHistoryGroup();
  typeInEditor("abcd", 4);
  documentKey("z", { ctrlKey: true });
  assert.equal(element("editor").value, "abc");
  documentKey("y", { ctrlKey: true });
  assert.equal(element("editor").value, "abcd");
  documentKey("z", { ctrlKey: true });
  assert.equal(element("editor").value, "abc");
  documentKey("z", { ctrlKey: true, shiftKey: true });
  assert.equal(element("editor").value, "abcd");
});

scenario("Undo, Redo, New and Open toolbar buttons are wired", () => {
  app.core.resetDocument("", "buttons.txt");
  typeInEditor("abc", 3);
  click("undoBtn");
  assert.equal(element("editor").value, "");
  click("redoBtn");
  assert.equal(element("editor").value, "abc");
  const before = element("fileInput").clickCount;
  click("openBtn");
  assert.equal(element("fileInput").clickCount, before + 1);
  state.confirmResult = true;
  click("newBtn");
  assert.equal(element("editor").value, "");
  assert.equal(dom.title, "Untitled.txt - Notepad");
});

scenario("undo after a replacement is one step", () => {
  app.core.resetDocument("foo foo", "undo.txt");
  app.core.replaceRange(0, 3, "bar", 3);
  assert.equal(element("editor").value, "bar foo");
  app.core.undo();
  assert.equal(element("editor").value, "foo foo");
  app.core.redo();
  assert.equal(element("editor").value, "bar foo");
});

scenario("Ctrl+F live find: counter, next/prev, wrap", () => {
  app.core.resetDocument("alpha beta alpha gamma ALPHA", "find.txt");
  documentKey("f", { ctrlKey: true });
  assert.equal(element("searchPanel").style.display, "block");
  typeInto("searchInput", "alpha");
  assert.equal(element("searchStatus").textContent, "1 of 3");
  assert.deepEqual(
    [element("editor").selectionStart, element("editor").selectionEnd],
    [0, 5]
  );
  click("searchNextBtn");
  assert.equal(element("searchStatus").textContent, "2 of 3");
  assert.deepEqual(
    [element("editor").selectionStart, element("editor").selectionEnd],
    [11, 16]
  );
  click("searchNextBtn");
  assert.equal(element("searchStatus").textContent, "3 of 3");
  click("searchNextBtn");
  assert.equal(element("searchStatus").textContent, "1 of 3");
  click("searchPrevBtn");
  assert.equal(element("searchStatus").textContent, "3 of 3");
});

scenario("find with no matches shows a message and clears the selection", () => {
  app.core.resetDocument("alpha beta alpha", "find.txt");
  documentKey("f", { ctrlKey: true });
  typeInto("searchInput", "alpha");
  assert.notEqual(element("editor").selectionStart, element("editor").selectionEnd);
  typeInto("searchInput", "zzz");
  assert.match(element("searchStatus").textContent, /No matches for "zzz"/);
  assert.equal(element("editor").selectionStart, element("editor").selectionEnd);
  click("searchNextBtn");
  assert.match(element("searchStatus").textContent, /No matches for "zzz"/);
  assert.equal(element("editor").selectionStart, element("editor").selectionEnd);
});

scenario("Ctrl+F prefills the selected word and is case-insensitive", () => {
  app.core.resetDocument("alpha beta ALPHA", "find.txt");
  app.core.setSelection(0, 5);
  documentKey("f", { ctrlKey: true });
  assert.equal(element("searchInput").value, "alpha");
  assert.equal(element("searchStatus").textContent, "1 of 2");
  typeInto("searchInput", "ALPHA");
  assert.equal(element("searchStatus").textContent, "1 of 2");
});

scenario("search scrolls to a match far down the document", () => {
  const lines = [];
  for (let i = 1; i <= 60; i += 1) lines.push(`line ${i}`);
  app.core.resetDocument(lines.join("\n"), "long.txt");
  element("editor").scrollTop = 0;
  documentKey("f", { ctrlKey: true });
  typeInto("searchInput", "line 50");
  assert.ok(element("editor").scrollTop > 0,
    `scrollTop was ${element("editor").scrollTop}`);
});

scenario("Escape closes the active panel", () => {
  documentKey("f", { ctrlKey: true });
  assert.equal(element("searchPanel").style.display, "block");
  documentKey("Escape");
  assert.equal(element("searchPanel").style.display, "none");
});

scenario("Ctrl+H replaced one occurrence and moves to the next", () => {
  app.core.resetDocument("foo bar foo baz foo", "replace.txt");
  documentKey("h", { ctrlKey: true });
  typeInto("replaceFindInput", "foo");
  assert.equal(element("replaceStatus").textContent, "1 of 3");
  assert.deepEqual(
    [element("editor").selectionStart, element("editor").selectionEnd],
    [0, 3]
  );
  typeInto("replaceWithInput", "X");
  click("replaceBtn");
  assert.equal(element("editor").value, "X bar foo baz foo");
  assert.match(element("replaceStatus").textContent, /Replaced 1 occurrence/);
  assert.deepEqual(
    [element("editor").selectionStart, element("editor").selectionEnd],
    [6, 9]
  );
  click("replaceBtn");
  assert.equal(element("editor").value, "X bar X baz foo");
  assert.deepEqual(
    [element("editor").selectionStart, element("editor").selectionEnd],
    [12, 15]
  );
  click("replaceBtn");
  assert.equal(element("editor").value, "X bar X baz X");
  assert.match(element("replaceStatus").textContent, /No matches left/);
});

scenario("replace one is undoable", () => {
  app.core.undo();
  assert.equal(element("editor").value, "X bar X baz foo");
  app.core.redo();
  assert.equal(element("editor").value, "X bar X baz X");
});

scenario("Replace All replaces every occurrence in one undo step", () => {
  app.core.resetDocument("a a a", "all.txt");
  documentKey("h", { ctrlKey: true });
  typeInto("replaceFindInput", "a");
  typeInto("replaceWithInput", "bb");
  click("replaceAllBtn");
  assert.equal(element("editor").value, "bb bb bb");
  assert.match(element("replaceStatus").textContent, /Replaced 3 occurrences/);
  assert.equal(app.core.isDirty(), true);
  app.core.undo();
  assert.equal(element("editor").value, "a a a");
  app.core.redo();
  assert.equal(element("editor").value, "bb bb bb");
});

scenario("Replace All with a replacement containing the needle terminates", () => {
  app.core.resetDocument("a", "edge.txt");
  documentKey("h", { ctrlKey: true });
  typeInto("replaceFindInput", "a");
  typeInto("replaceWithInput", "aa");
  click("replaceAllBtn");
  assert.equal(element("editor").value, "aa");
  assert.match(element("replaceStatus").textContent, /Replaced 1 occurrence/);
});

scenario("replace with no matches reports it and changes nothing", () => {
  app.core.resetDocument("foo", "replace.txt");
  documentKey("h", { ctrlKey: true });
  typeInto("replaceFindInput", "zzz");
  assert.match(element("replaceStatus").textContent, /No matches for "zzz"/);
  typeInto("replaceWithInput", "bar");
  click("replaceBtn");
  assert.equal(element("editor").value, "foo");
  assert.match(element("replaceStatus").textContent, /No matches for "zzz"/);
});

scenario("Go to Line puts the caret at the start of the line", () => {
  app.core.resetDocument("one\ntwo\nthree\nfour", "goto.txt");
  documentKey("g", { ctrlKey: true });
  assert.equal(element("gotoPanel").style.display, "block");
  element("gotoInput").value = "3";
  click("gotoGoBtn");
  assert.equal(element("gotoPanel").style.display, "none");
  assert.deepEqual(
    [element("editor").selectionStart, element("editor").selectionEnd],
    [8, 8]
  );
});

scenario("Go to Line scrolls to a distant line", () => {
  const lines = [];
  for (let i = 1; i <= 80; i += 1) lines.push(`line ${i}`);
  app.core.resetDocument(lines.join("\n"), "long.txt");
  element("editor").scrollTop = 0;
  click("gotoLineBtn");
  element("gotoInput").value = "60";
  click("gotoGoBtn");
  assert.ok(element("editor").scrollTop > 0,
    `scrollTop was ${element("editor").scrollTop}`);
  assert.equal(element("editor").selectionStart, lines.slice(0, 59).join("\n").length + 1);
});

scenario("Go to Line validation: 0, text, 3abc, out of range, empty", () => {
  app.core.resetDocument("one\ntwo\nthree\nfour", "goto.txt");
  click("gotoLineBtn");
  element("gotoInput").value = "2";
  click("gotoGoBtn");
  const before = [element("editor").selectionStart, element("editor").selectionEnd];
  assert.deepEqual(before, [4, 4]);

  const cases = [
    ["0", /at least 1/],
    ["abc", /whole number/],
    ["3abc", /whole number/],
    ["5", /out of range \(1-4\)/],
    ["", /Enter a line number/],
  ];

  for (const [value, pattern] of cases) {
    click("gotoLineBtn");
    element("gotoInput").value = value;
    click("gotoGoBtn");
    assert.equal(element("gotoPanel").style.display, "block",
      `panel should stay open for ${JSON.stringify(value)}`);
    assert.match(element("gotoStatus").textContent, pattern,
      `message for ${JSON.stringify(value)}: ${element("gotoStatus").textContent}`);
    assert.deepEqual(
      [element("editor").selectionStart, element("editor").selectionEnd],
      before,
      `selection must not move for ${JSON.stringify(value)}`
    );
  }

  click("gotoLineBtn");
  element("gotoInput").value = " 4 ";
  click("gotoGoBtn");
  assert.deepEqual(
    [element("editor").selectionStart, element("editor").selectionEnd],
    [14, 14]
  );
});

scenario("font size buttons step and clamp", () => {
  app.view.applyFontSize(16);
  click("fontIncreaseBtn");
  assert.equal(element("editor").style.fontSize, "17px");
  click("fontDecreaseBtn");
  assert.equal(element("editor").style.fontSize, "16px");
  for (let i = 0; i < 12; i += 1) click("fontDecreaseBtn");
  assert.equal(element("editor").style.fontSize, "10px");
  assert.equal(element("fontDecreaseBtn").disabled, true);
  for (let i = 0; i < 20; i += 1) click("fontIncreaseBtn");
  assert.equal(element("editor").style.fontSize, "24px");
  assert.equal(element("fontIncreaseBtn").disabled, true);
  app.view.applyFontSize(16);
});

scenario("word wrap toggles the wrap class", () => {
  const toggle = element("wordWrapToggle");
  toggle.checked = true;
  toggle.dispatchEvent({ type: "change", target: toggle });
  assert.equal(element("editor").classList.contains("wrap"), true);
  assert.equal(element("editor").getAttribute("wrap"), "soft");
  assert.equal(element("editor").style.whiteSpace, "pre-wrap");
  assert.equal(element("editor").style.overflowX, "hidden");
  toggle.checked = false;
  toggle.dispatchEvent({ type: "change", target: toggle });
  assert.equal(element("editor").classList.contains("wrap"), false);
  assert.equal(element("editor").getAttribute("wrap"), "off");
  assert.equal(element("editor").style.whiteSpace, "pre");
  assert.equal(element("editor").style.overflowX, "auto");
});

scenario("dark theme toggles body class and button label", () => {
  click("themeToggleBtn");
  assert.equal(dom.body.classList.contains("dark-theme"), true);
  assert.equal(element("themeToggleBtn").textContent, "Light theme");
  assert.equal(element("themeToggleBtn").getAttribute("aria-pressed"), "true");
  click("themeToggleBtn");
  assert.equal(dom.body.classList.contains("dark-theme"), false);
  assert.equal(element("themeToggleBtn").textContent, "Dark theme");
});

scenario("dirty flag, star in title and beforeunload warning", () => {
  app.core.resetDocument("abc", "notes.txt");
  assert.equal(dom.title, "notes.txt - Notepad");
  typeInEditor("abcd", 4);
  assert.equal(app.core.isDirty(), true);
  assert.equal(dom.title, "*notes.txt - Notepad");
  const unload = fireBeforeUnload();
  assert.equal(unload.event.defaultPrevented, true);
  assert.match(String(unload.event.returnValue), /unsaved changes/);
  assert.match(String(unload.results[0]), /unsaved changes/);
});

scenario("Ctrl+N asks before discarding unsaved edits", () => {
  state.confirmResult = false;
  state.confirms.length = 0;
  documentKey("n", { ctrlKey: true });
  assert.equal(element("editor").value, "abcd");
  assert.match(dom.title, /^\*notes\.txt/);
  assert.equal(state.confirms.length, 1);
  assert.match(state.confirms[0], /notes\.txt/);
});

scenario("Ctrl+N starts a clean Untitled document after confirmation", () => {
  state.confirmResult = true;
  documentKey("n", { ctrlKey: true });
  assert.equal(element("editor").value, "");
  assert.equal(dom.title, "Untitled.txt - Notepad");
  assert.equal(element("fileName").textContent, "Untitled.txt");
  assert.equal(app.core.isDirty(), false);
  assert.equal(element("stats").textContent, "Lines: 1 | Words: 0 | Characters: 0");
  const unload = fireBeforeUnload();
  assert.equal(unload.event.defaultPrevented, false);
});

scenario("Ctrl+O opens the file picker", () => {
  const before = element("fileInput").clickCount;
  documentKey("o", { ctrlKey: true });
  assert.equal(element("fileInput").clickCount, before + 1);
});

scenario("opening a .txt file loads text, name and clean state", () => {
  const input = element("fileInput");
  input.files = [{ name: "poem.txt", __text: "roses\nviolets" }];
  input.dispatchEvent({ type: "change", target: input });
  assert.equal(element("editor").value, "roses\nviolets");
  assert.equal(dom.title, "poem.txt - Notepad");
  assert.equal(element("fileName").textContent, "poem.txt");
  assert.equal(app.core.isDirty(), false);
  assert.deepEqual(
    [element("editor").selectionStart, element("editor").selectionEnd],
    [0, 0]
  );
  assert.equal(element("stats").textContent,
    "Lines: 2 | Words: 2 | Characters: 13");
  assert.equal(input.value, "");
});

scenario("opening another file asks when there are unsaved changes", () => {
  typeInEditor("changed", 7);
  const input = element("fileInput");
  input.files = [{ name: "other.txt", __text: "other" }];
  state.confirmResult = false;
  state.confirms.length = 0;
  input.dispatchEvent({ type: "change", target: input });
  assert.equal(element("editor").value, "changed");
  assert.match(dom.title, /^\*poem\.txt/);
  assert.equal(state.confirms.length, 1);
  assert.match(state.confirms[0], /other\.txt/);

  state.confirmResult = true;
  input.files = [{ name: "other.txt", __text: "other" }];
  input.dispatchEvent({ type: "change", target: input });
  assert.equal(element("editor").value, "other");
  assert.equal(dom.title, "other.txt - Notepad");
  assert.equal(app.core.isDirty(), false);
});

scenario("Save downloads the current text under the current name", () => {
  typeInEditor("saved text", 10);
  state.downloads.length = 0;
  click("saveBtn");
  assert.equal(state.downloads.length, 1);
  assert.equal(state.downloads[0].download, "other.txt");
  assert.equal(state.downloads[0].text, "saved text");
  assert.equal(dom.title, "other.txt - Notepad");
  assert.equal(app.core.isDirty(), false);
  assert.equal(fireBeforeUnload().event.defaultPrevented, false);
});

scenario("Ctrl+S saves too", () => {
  typeInEditor("again", 5);
  state.downloads.length = 0;
  documentKey("s", { ctrlKey: true });
  assert.equal(state.downloads.length, 1);
  assert.equal(state.downloads[0].text, "again");
  assert.equal(dom.title, "other.txt - Notepad");
});

scenario("title and status stay in sync after undo/redo", () => {
  app.core.resetDocument("", "sync.txt");
  typeInEditor("one two", 7);
  assert.match(element("stats").textContent, /Words: 2/);
  app.core.undo();
  assert.equal(element("stats").textContent, "Lines: 1 | Words: 0 | Characters: 0");
  assert.equal(dom.title, "sync.txt - Notepad");
  app.core.redo();
  assert.match(element("stats").textContent, /Words: 2/);
  assert.equal(dom.title, "*sync.txt - Notepad");
});

check(state.missingIds.size === 0,
  "no getElementById misses during all scenarios", [...state.missingIds].join(", "));

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
