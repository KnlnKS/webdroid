import { wat, inChrome } from "./lib.mjs";
const w = wat(`(module
 (import "h" "sync" (func $sync (param i32) (result i32)))
 (import "h" "susp" (func $susp (param i32) (result i32)))
 (import "h" "jsback" (func $jsback (param i32) (result i32)))
 (func (export "loopSync") (param $n i32) (result i32) (local $s i32)
   (loop $l (local.set $s (i32.add (local.get $s) (call $sync (local.get $n)))) (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1))))) (local.get $s))
 (func (export "loopSusp") (param $n i32) (result i32) (local $s i32)
   (loop $l (local.set $s (i32.add (local.get $s) (call $susp (local.get $n)))) (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1))))) (local.get $s))
 (func $rec (param $d i32) (result i32)
   (if (result i32) (i32.eqz (local.get $d)) (then (call $susp (i32.const 1)))
     (else (i32.add (i32.const 1) (call $rec (i32.sub (local.get $d) (i32.const 1)))))))
 (func (export "deep") (param $d i32) (result i32) (call $rec (local.get $d)))
 (func $recn (param $d i32) (result i32)
   (if (result i32) (i32.eqz (local.get $d)) (then (i32.const 0))
     (else (i32.add (i32.const 1) (call $recn (i32.sub (local.get $d) (i32.const 1)))))))
 (func (export "deepNoSusp") (param $d i32) (result i32) (call $recn (local.get $d)))
 (func (export "viaJs") (param $n i32) (result i32) (call $jsback (local.get $n)))
)`);
const r = await inChrome(async ({ w }) => {
  const out = {};
  let inst;
  const h = { sync: (x) => x & 1, susp: new WebAssembly.Suspending(async (x) => x & 1),
    jsback: (x) => inst.exports.loopSusp(x) };
  inst = (await WebAssembly.instantiate(new Uint8Array(w), { h })).instance;
  const e = inst.exports;
  const loopSusp = WebAssembly.promising(e.loopSusp), deep = WebAssembly.promising(e.deep), viaJs = WebAssembly.promising(e.viaJs);
  let t = performance.now(); e.loopSync(10_000_000); out.sync_import_ns = (performance.now() - t) / 10;
  t = performance.now(); await loopSusp(1_000_000); out.suspend_resume_ns = (performance.now() - t) * 1000 / 1;   // per call ns
  const h2 = { sync: (x) => x & 1, jsback: x=>x, susp: new WebAssembly.Suspending(async (x) => { await Promise.resolve(); return x & 1; }) };
  const e2 = (await WebAssembly.instantiate(new Uint8Array(w), { h: h2 })).instance.exports;
  const ls2 = WebAssembly.promising(e2.loopSusp);
  t = performance.now(); await ls2(200_000); out.suspend_after_microtask_ns = (performance.now() - t) * 1e6 / 200_000;
  // plain async/await JS loop for comparison
  t = performance.now(); { let s = 0; for (let i = 0; i < 200_000; i++) { s += await (async (x) => { await Promise.resolve(); return x & 1; })(i); } } out.js_await_microtask_ns = (performance.now() - t) * 1e6 / 200_000;
  // deep stacks
  for (const d of [1000, 10000, 50000, 200000]) {
    try { t = performance.now(); const v = await deep(d); out["deep" + d] = [v, +(performance.now() - t).toFixed(2)]; }
    catch (e) { out["deep" + d] = String(e).slice(0, 80); }
  }
  for (const d of [10000, 100000, 1000000]) { try { out["mainstack_deep" + d] = e.deepNoSusp(d); } catch (x) { out["mainstack_deep" + d] = String(x).slice(0, 60); } }
  // JS frame between promising entry and suspend
  try { out.js_frame_between = await viaJs(10); } catch (x) { out.js_frame_between = String(x).slice(0, 100); }
  // many concurrent suspended stacks memory
  const before = performance.memory?.usedJSHeapSize;
  const gate = []; let release;
  const pend = new Promise(r => release = r);
  const inst2 = (await WebAssembly.instantiate(new Uint8Array(w), { h: { sync: x => x, jsback: x => x, susp: new WebAssembly.Suspending(() => pend) } })).instance;
  const d2 = WebAssembly.promising(inst2.exports.deep);
  const N = 2000;
  const ps = []; for (let i = 0; i < N; i++) ps.push(d2(200));
  out.concurrent_stacks_started = N; t = performance.now(); release(1); await Promise.all(ps); out.resume_all_ms = +(performance.now() - t).toFixed(2);
  return out;
}, { w: [...w] });
console.log(JSON.stringify(r, null, 1));
