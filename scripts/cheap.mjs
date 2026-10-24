import { loadEnv } from "../lib/env.mjs";
import { listModels } from "../lib/openrouter.mjs";

loadEnv(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const models = await listModels();
const want = [/qwen/i, /gemini-2\.5-flash/i, /gpt-4\.1-mini|gpt-5-mini|gpt-4o-mini/i, /claude-3\.5-haiku|claude-haiku/i, /llama-3\.3/i, /mistral-small/i, /deepseek-v3\.2/i, /glm/i];
const rows = models
  .filter((m) => want.some((re) => re.test(m.id)) && !m.id.includes(":"))
  .map((m) => ({
    id: m.id,
    inp: m.promptPrice * 1e6,
    out: m.completionPrice * 1e6,
    ctx: m.context,
  }))
  .sort((a, b) => a.inp + a.out * 3 - (b.inp + b.out * 3));

for (const r of rows.slice(0, 40)) {
  console.log(r.id.padEnd(44), `in $${r.inp.toFixed(3)}`.padStart(12), `out $${r.out.toFixed(3)}`.padStart(13), String(r.ctx ?? "").padStart(9));
}
console.log("\nвсего кандидатов:", rows.length);
