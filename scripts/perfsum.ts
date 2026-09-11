// Roll up the per-step perf counters an e2e run already writes, so two runs can be compared
// on cost as well as on pixels.  bun scripts/perfsum.ts [dir=tests/e2e/actual] [baseline.json]
import { readdirSync, existsSync } from "node:fs";

const LAYOUT_KEYS = ["invalidates", "layoutRequests", "layoutRequestsAll", "onMeasures", "layoutMismatch", "insetsPasses", "wraps", "wrapHits", "measureCacheHits", "exactSkips", "viewsDrawn", "viewsRejected"] as const;
const KEYS = ["bootMs", "compileMs", "classesCompiled", "layoutMs", "layoutPasses", "drawMs", "draws", "frameMs", "frames", "inputMs", "measureText", "nativeInstr", "nativeMs", "nativeHostCalls", "jitRegions", "jitMs", ...LAYOUT_KEYS] as const;

async function rollup(dir: string) {
  const out: Record<string, Record<string, number>> = {};
  for (const flow of readdirSync(dir)) {
    const f = `${dir}/${flow}/run.json`;
    if (!existsSync(f)) continue;
    const raw = await Bun.file(f).json();
    const steps: any[] = Array.isArray(raw) ? raw : raw.steps ?? [];
    const t: Record<string, number> = { ms: 0 };
    for (const s of steps) {
      const p = s.perf ?? {};
      t.ms += s.ms ?? 0;
      for (const k of KEYS) {
        // boot and the compile counters are cumulative gauges; the rest are per-step deltas
        if (k === "bootMs" || k === "classesCompiled" || k === "compileMs") t[k] = Math.max(t[k] ?? 0, p[k] ?? 0);
        else t[k] = (t[k] ?? 0) + (p[k] ?? 0);
      }
    }
    out[flow] = t;
  }
  return out;
}

const dir = process.argv[2] ?? "tests/e2e/actual";
const now = await rollup(dir);
const base = process.argv[3] ? await Bun.file(process.argv[3]).json() : null;

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
if (!base) console.log(`\n(pass a baseline json as arg 2 to see deltas; write one with: bun scripts/perfsum.ts ${dir} > /dev/null)`);
await Bun.write(`${dir}/../perf-rollup.json`, JSON.stringify(now, null, 1));
