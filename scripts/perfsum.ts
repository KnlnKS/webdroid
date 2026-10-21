// Roll up the per-step perf counters an e2e run already writes, so two runs can be compared
// on cost as well as on pixels.  pnpm ts scripts/perfsum.ts [dir=tests/e2e/actual] [baseline.json]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cli } from "./args.ts";

const KEYS = ["bootMs", "wasmCompileMs", "wasmClasses", "drawMs", "draws", "frameMs", "frames", "presentLagMs", "inputMs", "measureText", "nativeInstr", "nativeMs", "nativeHostCalls", "jitRegions", "jitMs"] as const;

function rollup(dir: string) {
  const out: Record<string, Record<string, number>> = {};
  for (const flow of readdirSync(dir)) {
    const f = `${dir}/${flow}/run.json`;
    if (!existsSync(f)) continue;
    const raw = JSON.parse(readFileSync(f, "utf8"));
    const steps: any[] = Array.isArray(raw) ? raw : raw.steps ?? [];
    const t: Record<string, number> = { ms: 0 };
    for (const s of steps) {
      const p = s.perf ?? {};
      t.ms += s.ms ?? 0;
      for (const k of KEYS) {
        // perfReset preserves only bootMs; compilation counters are per-step deltas too.
        if (k === "bootMs") t[k] = Math.max(t[k] ?? 0, p[k] ?? 0);
        else t[k] = (t[k] ?? 0) + (p[k] ?? 0);
      }
    }
    out[flow] = t;
  }
  return out;
}

const { positionals: [dir = "tests/e2e/actual", baseline] } = cli("pnpm ts scripts/perfsum.ts [dir] [baseline.json]", {});
const now = rollup(dir);
const base = baseline ? JSON.parse(readFileSync(baseline, "utf8")) : null;

const cols = ["ms", ...KEYS];
console.log("flow".padEnd(18) + cols.map((c) => c.padStart(13)).join(""));
for (const [flow, t] of Object.entries(now)) {
  let line = flow.padEnd(18);
  for (const c of cols) {
    const v = t[c] ?? 0;
    const b = base?.[flow]?.[c];
    const d = b === undefined || b === 0 ? "" : `${v > b ? "+" : ""}${(((v - b) / b) * 100).toFixed(0)}%`;
    line += (d ? `${v.toFixed(0)}${d}` : v.toFixed(0)).padStart(13);
  }
  console.log(line);
}
if (!base) console.log(`\n(pass a baseline json as arg 2 to see deltas; write one with: pnpm ts scripts/perfsum.ts ${dir} > /dev/null)`);
writeFileSync(`${dir}/../perf-rollup.json`, JSON.stringify(now, null, 1));
