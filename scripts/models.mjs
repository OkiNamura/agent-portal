import { loadEnv } from "../lib/env.mjs";
import { listModels } from "../lib/openrouter.mjs";

loadEnv(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const models = await listModels();
const ds = models.filter((m) => /deepseek/i.test(m.id));
const price = (m) => `in $${(m.promptPrice * 1e6).toFixed(3)}/M · out $${(m.completionPrice * 1e6).toFixed(3)}/M`;
for (const m of ds) console.log(m.id.padEnd(42), m.context?.toString().padStart(8), " ", price(m));
console.log(`\nвсего моделей: ${models.length}, deepseek: ${ds.length}`);
