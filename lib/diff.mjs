/** Построчный дифф без зависимостей: LCS с защитой от больших файлов. */

const MAX_LINES = 1500;

export function diffLines(aText = "", bText = "") {
  const a = String(aText).split("\n");
  const b = String(bText).split("\n");
  const n = a.length;
  const m = b.length;

  if (n > MAX_LINES || m > MAX_LINES) {
    return [
      { type: "meta", text: `файл великоват для построчного диффа (${n} → ${m} строк)` },
      { type: "del", text: a.slice(0, 40).join("\n") },
      { type: "meta", text: "…" },
      { type: "add", text: b.slice(0, 40).join("\n") },
    ];
  }

  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] });
  while (j < m) ops.push({ type: "add", text: b[j++] });

  return ops;
}

/** Сжимает длинные куски неизменённого в метку «… N строк». */
export function compactContext(ops, keep = 3) {
  const out = [];
  let run = 0;
  for (const op of ops) {
    if (op.type !== "ctx") {
      if (run > keep * 2) out.push({ type: "meta", text: `… ${run - keep * 2} строк без изменений …` });
      run = 0;
      out.push(op);
    } else {
      run++;
      if (run <= keep) out.push(op);
    }
  }
  if (run > keep) out.push({ type: "meta", text: `… ${run - keep} строк без изменений …` });
  return out;
}

export function diffWorkspaces(before = {}, after = {}) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const files = [];
  let added = 0;
  let removed = 0;

  for (const path of paths) {
    const a = before[path];
    const b = after[path];
    if (a === b) continue;

    if (a === undefined) {
      const lines = String(b ?? "").split("\n").length;
      added += lines;
      files.push({ path, status: "added", added: lines, removed: 0, hunks: [{ type: "add", text: `новый файл, ${lines} строк` }] });
      continue;
    }
    if (b === undefined) {
      const lines = String(a ?? "").split("\n").length;
      removed += lines;
      files.push({ path, status: "deleted", added: 0, removed: lines, hunks: [{ type: "del", text: `файл удалён, было ${lines} строк` }] });
      continue;
    }

    const ops = diffLines(a, b);
    const add = ops.filter((o) => o.type === "add").length;
    const del = ops.filter((o) => o.type === "del").length;
    if (!add && !del) continue;
    added += add;
    removed += del;
    files.push({ path, status: "changed", added: add, removed: del, hunks: ops });
  }

  return { files, summary: { files: files.length, added, removed } };
}
