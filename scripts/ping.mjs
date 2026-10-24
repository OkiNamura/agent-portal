import { loadEnv } from "../lib/env.mjs";
import { chat } from "../lib/openrouter.mjs";

loadEnv(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const model = process.argv[2] ?? "deepseek/deepseek-v3.2";
const t0 = Date.now();
const res = await chat({
  model,
  system: "Отвечай строго JSON.",
  user: 'Верни JSON вида {"ok":true,"model":"<твоё название>"}',
  temperature: 0,
  maxTokens: 100,
});
console.log("модель:", res.model);
console.log("ответ :", res.text.trim().slice(0, 200));
console.log("usage :", res.usage);
console.log("время :", ((Date.now() - t0) / 1000).toFixed(1) + "с");
