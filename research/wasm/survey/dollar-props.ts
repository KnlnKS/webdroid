// Histogram of `$`-prefixed property names used by host TS (the VM's hidden per-object slots)
import { readdirSync, statSync, readFileSync } from "fs"; import { join } from "path";
const walk = (d: string, o: string[] = []) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, o) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) && o.push(p); } return o; };
const root = join(import.meta.dirname, "../../../src"); const h: Record<string, number> = {}; const hc: Record<string, number> = {};
for (const f of walk(root)) { const t = readFileSync(f, "utf8"); const out = f.includes("/jvm/") && !f.includes("/jvm/natives/") ? hc : h;
  for (const m of t.matchAll(/\.(\$[A-Za-z_]\w*)/g)) { const k = m[1]; (f.includes("/jvm/") && !f.includes("/jvm/natives/") ? hc : h)[k] = (f.includes("/jvm/") && !f.includes("/jvm/natives/") ? hc : h)[k] ?? 0, (f.includes("/jvm/") && !f.includes("/jvm/natives/") ? hc : h)[k]++; } }
const top = (x: Record<string, number>) => Object.entries(x).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}:${v}`).join(" ");
console.log("host glue (everything except src/jvm/*.ts core):", top(h), "total", Object.values(h).reduce((a, b) => a + b, 0));
console.log("jvm core (src/jvm/*.ts):", top(hc), "total", Object.values(hc).reduce((a, b) => a + b, 0));
