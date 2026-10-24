/** Offline stand-in for OpenRouter: lets the whole pipeline run with no key and no spend. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAN = {
  title: "ЗАГЛУШКА: демо-портал на одном экране (твоя задача не анализировалась)",
  blocks: [
    {
      id: "b1",
      title: "Каркас страницы",
      goal: "Один экран: заголовок, поле ввода, кнопка, область результата",
      acceptance: ["Страница открывается локально", "Кнопка реагирует на клик"],
      deps: [],
    },
    {
      id: "b2",
      title: "Логика счётчика",
      goal: "Кнопка увеличивает число, значение видно на экране",
      acceptance: ["Каждый клик даёт +1", "Значение не сбрасывается при повторном клике"],
      deps: ["b1"],
    },
    {
      id: "b3",
      title: "Внешний вид",
      goal: "Тёмная тема, читаемые отступы, кнопка с состоянием наведения",
      acceptance: ["Контраст текста читается", "Есть hover-состояние кнопки"],
      deps: ["b1"],
    },
  ],
};

function spec(meta) {
  const b = meta.block ?? { id: "b1", title: "Блок", goal: "—" };
  return `# ${b.title}

## Цель
${b.goal}

## Что входит
- Минимальная реализация ровно под цель блока.
- Самодостаточные файлы, без внешних зависимостей.

## Чего НЕ входит
- Серверная часть, сохранение между перезагрузками, авторизация.

## Критерии приёмки
${(b.acceptance ?? ["Блок работает по описанию"]).map((a) => `- [ ] ${a}`).join("\n")}

## Зависимости
${(b.deps ?? []).length ? (b.deps ?? []).join(", ") : "нет"}
`;
}

function code(meta) {
  const id = meta.block?.id ?? "b1";
  const stamp = meta.round ? `/* правка: круг ${meta.round} */` : "";
  return JSON.stringify(
    {
      files: [
        {
          path: `src/${id}/index.html`,
          content: `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>${meta.block?.title ?? "Блок"}</title>
<link rel="stylesheet" href="style.css"></head>
<body>
  <main class="card">
    <h1>${meta.block?.title ?? "Блок"}</h1>
    <p class="hint">${meta.block?.goal ?? ""}</p>
    <button id="go" type="button">Нажать</button>
    <output id="out">0</output>
  </main>
  <script src="app.js"></script>
</body>
</html>`,
        },
        {
          path: `src/${id}/style.css`,
          content: `${stamp}
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #0f1216; color: #e8ecf1; font: 16px/1.5 system-ui, sans-serif; }
.card { padding: 32px; border-radius: 16px; background: #171c23;
  border: 1px solid #26303c; display: grid; gap: 12px; min-width: 320px; }
button { padding: 10px 16px; border-radius: 10px; border: 0; cursor: pointer;
  background: #3b82f6; color: #fff; font-size: 15px; }
button:hover { background: #2f6fda; }
output { font-size: 32px; font-weight: 700; }`,
        },
        {
          path: `src/${id}/app.js`,
          content: `${stamp}
const out = document.getElementById("out");
let n = 0;
document.getElementById("go").addEventListener("click", () => {
  n += 1;
  out.textContent = String(n);
});`,
        },
      ],
      notes: `Блок ${id}: каркас + логика счётчика. Тестовый прогон — открыть index.html.`,
    },
    null,
    2
  );
}

function test(meta) {
  const round = meta.round ?? 1;
  if (round === 1) {
    return JSON.stringify({
      verdict: "fail",
      defects: [
        { severity: "major", where: "src/b1/app.js:3", what: "Счётчик не сбрасывается, но и не ограничен — при 1000+ кликов число уезжает по ширине" },
        { severity: "minor", where: "src/b1/style.css:6", what: "Нет focus-стиля для кнопки — клавиатурная навигация невидима" },
      ],
      summary: "Логика работает, но есть 1 существенный и 1 мелкий дефект.",
    });
  }
  return JSON.stringify({
    verdict: "pass",
    defects: [{ severity: "minor", where: "src/b1/style.css:6", what: "Focus-стиль добавлен, проверено" }],
    summary: "Критерии приёмки выполнены, блок можно принимать.",
  });
}

function report(meta) {
  return `# Сводка по прогону

## Сделано
${(meta.blocks ?? []).map((b) => `- ${b.id}: ${b.title} — код и тесты пройдены`).join("\n") || "- блоки не выполнялись"}

## Не сделано
- Нет сохранения состояния между перезагрузками (в спеку не входило).

## Риски
- Проверено только в MOCK-режиме: реальные модели могут дать другой формат.

## Что проверить руками
1. Открыть \`src/b1/index.html\` в браузере.
2. Нажать кнопку 5 раз — счётчик должен показывать 5.
3. Пройти по кнопке табом — должен быть виден фокус.

## Следующий шаг
Подключить реальный ключ OpenRouter и прогнать тот же каскад на живой модели.`;
}

export async function mockChat({ kind, meta = {} }) {
  await sleep(250);
  let text;
  switch (kind) {
    case "plan":
      text = JSON.stringify(PLAN, null, 2);
      break;
    case "spec":
      text = spec(meta);
      break;
    case "design":
      text = `# Дизайн\n\n- Тёмная тема, один акцентный цвет.\n- Отступы кратны 8.\n- Кнопка: 3 состояния (обычное, hover, focus).\n`;
      break;
    case "code":
    case "build":
    case "fix":
      text = code(meta);
      break;
    case "test":
      text = test(meta);
      break;
    case "mockup":
      text = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Макет</title>
<style>
 body{margin:0;background:#0f1216;color:#e8ecf1;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
 .app{width:420px;background:#171c23;border:1px solid #26303c;border-radius:18px;padding:28px;display:grid;gap:16px}
 h1{font-size:20px;margin:0} .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
 input{background:#0d1117;border:1px solid #2b3542;border-radius:10px;padding:10px 12px;color:inherit;font-size:18px}
 .ops{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
 button{border:0;border-radius:10px;padding:10px;background:#1e2733;color:inherit;font-size:16px;cursor:pointer}
 button.eq{background:#3b82f6;color:#fff;font-weight:700;grid-column:span 4}
 .out{font-size:34px;font-weight:700;text-align:right;padding:8px 4px;border-bottom:1px solid #26303c}
 .hist{font-size:13px;color:#8b98a9}
</style></head><body>
<div class="app">
  <h1>Калькулятор</h1>
  <div class="out">1 024</div>
  <div class="row"><input value="512"><input value="2"></div>
  <div class="ops"><button>+</button><button>−</button><button>×</button><button>÷</button>
  <button class="eq">=</button></div>
  <div class="hist">512 × 2 = 1 024<br>128 + 32 = 160</div>
</div>
</body></html>`;
      break;
    case "report":
      text = report(meta);
      break;
    default:
      text = `MOCK: стадия «${kind}» выполнена.`;
  }
  return {
    text,
    model: `mock/${kind}`,
    usage: { prompt: 0, completion: 0, cost: 0 },
  };
}
