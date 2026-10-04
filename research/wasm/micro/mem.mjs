import { wat } from "./lib.mjs";
import { chromium } from "playwright";
const w = wat(`(module
 (type $o (struct (field (mut (ref null $o))) (field (mut i32)) (field (mut i32)) (field (mut (ref null $o)))))
 (type $arr (array (mut (ref null $o))))
 (type $bytes (array (mut i8)))
 (global $keep (mut (ref null $arr)) (ref.null $arr))
 (func (export "alloc") (param $n i32) (local $i i32) (local $a (ref $arr))
   (local.set $a (array.new_default $arr (local.get $n)))
   (loop $l (array.set $arr (local.get $a) (local.get $i) (struct.new $o (ref.null $o) (local.get $i) (i32.const 0) (ref.null $o)))
     (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
   (global.set $keep (local.get $a)))
 (func (export "churn") (param $n i32) (local $i i32) (local $t (ref null $o))
   (loop $l (local.set $t (struct.new $o (local.get $t) (local.get $i) (i32.const 0) (ref.null $o)))
     (if (i32.eqz (i32.and (local.get $i) (i32.const 255))) (then (local.set $t (ref.null $o))))
     (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n)))))
 (func (export "rel") (global.set $keep (ref.null $arr))))`);
const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--js-flags=--expose-gc"] });
const p = await b.newPage(); await p.goto("about:blank");
const c = await p.context().newCDPSession(p);
const heap = async () => { await c.send("HeapProfiler.collectGarbage"); return (await c.send("Runtime.getHeapUsage")).usedSize; };
const out = await p.evaluate(async (wb) => {
  const e = (await WebAssembly.instantiate(new Uint8Array(wb))).instance.exports;
  window.e = e; window.keepJS = null;
  return 1;
}, [...w]);
let h0 = await heap();
await p.evaluate(() => e.alloc(2_000_000)); let h1 = await heap();
const res = { wasmgc_bytes_per_obj: +((h1 - h0) / 2e6 - 4).toFixed(1) }; // minus array slot 4B
await p.evaluate(() => e.rel()); 
h0 = await heap();
await p.evaluate(() => { class O { constructor(i) { this.a = null; this.b = i; this.c = 0; this.d = null; } } const a = new Array(2_000_000); for (let i = 0; i < a.length; i++) a[i] = new O(i); window.keepJS = a; });
h1 = await heap(); res.js_bytes_per_obj = +((h1 - h0) / 2e6 - 4).toFixed(1);
await p.evaluate(() => { window.keepJS = null; });
// GC pause during churn with big live heap: ticker in page measures max gap
const pause = await p.evaluate(async () => {
  e.alloc(3_000_000);
  let max = 0, last = performance.now(); const t0 = last;
  const res = {};
  const measure = (name, f) => { let m = 0; let l = performance.now(); const s = performance.now(); const sched = () => {}; f(); return performance.now() - s; };
  class O { constructor(p, i) { this.p = p; this.i = i; this.c = 0; this.d = null; } }
  const keep = new Array(3_000_000); for (let i = 0; i < keep.length; i++) keep[i] = new O(null, i); window.k = keep;
  res.js_churn_ms = measure("j", () => { let t = null; for (let i = 0; i < 100_000_000; i++) { t = new O(t, i); if ((i & 255) === 0) t = null; } });
  res.wasm_churn_ms = measure("w", () => e.churn(100_000_000));
  res.js_churn2_ms = measure("j", () => { let t = null; for (let i = 0; i < 100_000_000; i++) { t = new O(t, i); if ((i & 255) === 0) t = null; } });
  res.wasm_churn2_ms = measure("w", () => e.churn(100_000_000));
  return res;
});
console.log(JSON.stringify({ ...res, ...pause }));
await b.close();
