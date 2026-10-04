import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage();
await p.goto("about:blank");
const r = await p.evaluate(async () => {
  const out = {};
  out.ua = navigator.userAgent;
  const t = (name, bytes) => { try { out[name] = WebAssembly.validate(new Uint8Array(bytes)); } catch (e) { out[name] = "err " + e; } };
  // tiny feature probes (from wasm-feature-detect)
  t("gc", [0,97,115,109,1,0,0,0,1,5,1,95,1,120,0]);
  t("exnref/try_table", [0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,13,3,1,0,0,10,8,1,6,0,31,64,0,11,11]);
  t("tail-call", [0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,6,1,4,0,18,0,11]);
  t("multi-memory", [0,97,115,109,1,0,0,0,5,5,2,0,0,0,0]);
  t("memory64", [0,97,115,109,1,0,0,0,5,3,1,4,1]);
  t("relaxed-simd", [0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,15,1,13,0,65,0,253,15,65,0,253,15,253,128,2,11]);
  out.JSPI = typeof WebAssembly.Suspending + "/" + typeof WebAssembly.promising;
  out.jsStringBuiltins = typeof WebAssembly.compileStreaming;
  out.sab = typeof SharedArrayBuffer; out.coi = self.crossOriginIsolated;
  out.cores = navigator.hardwareConcurrency;
  out.WebAssemblyKeys = Object.getOwnPropertyNames(WebAssembly);
  return out;
});
console.log(JSON.stringify(r, null, 1));
await b.close();
