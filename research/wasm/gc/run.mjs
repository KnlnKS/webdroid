import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const bytes = [...readFileSync("gc.wasm")];
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage(); await p.goto("about:blank");
const r = await p.evaluate(async ({ bytes }) => {
  const out = {};
  const run = async (D, R, keepD) => {
    const memory = new WebAssembly.Memory({ initial: 512 });
    const e = (await WebAssembly.instantiate(new Uint8Array(bytes), { env: { memory }, ...{ } })).instance.exports;
    return e;
  };
  const mod = await WebAssembly.compile(new Uint8Array(bytes));
  const imports = WebAssembly.Module.imports(mod); out.imports = imports.map(i => i.module + "." + i.name);
  const mk = async () => { const memory = new WebAssembly.Memory({ initial: 512 }); const inst = await WebAssembly.instantiate(mod, { env: { memory, now: () => performance.now() } }); inst.exports.init(0x10000, 0x200000, 0x1200000); return inst.exports; };
  for (const [name, D, R, keepD] of [["fresh_D18_R20", 18, 20, 0], ["mature_keep20_churn_D18_R20", 18, 20, 20]]) {
    const e = await mk(); if (keepD) e.keep(keepD);
    e.run(D, 2);
    const times = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); e.run(D, R); times.push(performance.now() - t); }
    times.sort((a,b)=>a-b);
    out[name] = { median_ms: +times[2].toFixed(1), gcs: e.stats(0), gc_ms_total: +e.stats(1).toFixed(1), heap_MB: +(e.stats(2)/1048576).toFixed(1) };
  }
  return out;
}, { bytes });
console.log(JSON.stringify(r, null, 1)); await b.close();
