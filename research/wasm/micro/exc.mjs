import { wat, inChrome } from "./lib.mjs";
const w = wat(`(module
 (import "h" "capture" (func $cap))
 (tag $ex (param i32))
 (func $thrower (param $d i32) (result i32)
   (if (result i32) (i32.eqz (local.get $d)) (then (throw $ex (i32.const 7)))
     (else (i32.add (i32.const 1) (call $thrower (i32.sub (local.get $d) (i32.const 1)))))))
 (func (export "tc") (param $n i32) (param $depth i32) (result i32) (local $s i32)
   (loop $l
     (block $c (result i32) (try_table (result i32) (catch $ex 0) (call $thrower (local.get $depth)))
       (br 0)) ;; unreachable path placeholder
     (local.set $s (i32.add (local.get $s)))
     (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
   (local.get $s))
 (func $capr (param $d i32) (result i32)
   (if (result i32) (i32.eqz (local.get $d)) (then (call $cap) (i32.const 0))
     (else (i32.add (i32.const 1) (call $capr (i32.sub (local.get $d) (i32.const 1)))))))
 (func (export "cap") (param $n i32) (param $depth i32) (local $s i32)
   (loop $l (drop (call $capr (local.get $depth))) (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1))))))
)`);
const r = await inChrome(async ({ w }) => {
  const out = {}; let mode = 0;
  const h = { capture: () => { if (mode === 0) { const e = new Error(); void e.stack; } else if (mode === 1) { const e = new Error(); } else { Error.stackTraceLimit = 0; } } };
  const e = (await WebAssembly.instantiate(new Uint8Array(w), { h })).instance.exports;
  for (const d of [5, 50]) {
    let t = performance.now(); e.tc(100000, d); out["wasm_throw_catch_ns_depth" + d] = +((performance.now() - t) * 1e6 / 100000).toFixed(0);
  }
  const jthrow = (d) => d === 0 ? (() => { throw 7; })() : 1 + jthrow(d - 1);
  for (const d of [5, 50]) { let t = performance.now(); let s = 0; for (let i = 0; i < 100000; i++) try { jthrow(d); } catch (x) { s += x; } out["js_throw_catch_ns_depth" + d] = +((performance.now() - t) * 1e6 / 100000).toFixed(0); }
  Error.stackTraceLimit = 200;
  for (const d of [5, 50, 150]) {
    for (const m of [0, 1]) { mode = m; let t = performance.now(); e.cap(20000, d); out[`capture_${m ? "Error_nostackread" : "Error+stack_string"}_ns_depth${d}`] = +((performance.now() - t) * 1e6 / 20000).toFixed(0); }
  }
  // structured capture via prepareStackTrace
  Error.prepareStackTrace = (e, sites) => sites.length;
  mode = 0; let t = performance.now(); e.cap(20000, 50); out.capture_structured_depth50_ns = +((performance.now() - t) * 1e6 / 20000).toFixed(0);
  Error.prepareStackTrace = (e, sites) => sites.map(s => [s.getFunctionName(), s.isWasm?.(), s.getPosition?.(), s.getWasmFunctionIndex?.()]).slice(0,3);
  let st; h.capture = () => { st = new Error().stack; }; e.cap(1, 3); out.sample_sites = st;
  return out;
}, { w: [...w] });
console.log(JSON.stringify(r, null, 1));
