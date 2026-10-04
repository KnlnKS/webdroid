import { wat, inChrome } from "./lib.mjs";
// js-string builtins need imports of module "wasm:js-string" and compile option builtins:["js-string"]
const w = wat(`(module
 (type $o (struct (field (mut i32))))
 (type $b (array (mut i8)))
 (type $c (array (mut i16)))
 (import "wasm:js-string" "length" (func $len (param externref) (result i32)))
 (import "wasm:js-string" "charCodeAt" (func $cc (param externref i32) (result i32)))
 (import "wasm:js-string" "equals" (func $eq (param externref externref) (result i32)))
 (import "wasm:js-string" "fromCharCodeArray" (func $fca (param (ref null $c) i32 i32) (result (ref extern))))
 (import "wasm:js-string" "intoCharCodeArray" (func $ica (param externref (ref null $c) i32) (result i32)))
 (import "env" "mem" (memory 1))
 (func (export "mkobj") (result externref) (extern.convert_any (struct.new $o (i32.const 5))))
 (func (export "get") (param externref) (result i32) (struct.get $o 0 (ref.cast (ref $o) (any.convert_extern (local.get 0)))))
 (func (export "hash") (param $s externref) (result i32) (local $h i32) (local $i i32) (local $n i32)
   (local.set $n (call $len (local.get $s)))
   (loop $l (if (i32.lt_u (local.get $i) (local.get $n)) (then
     (local.set $h (i32.add (i32.mul (local.get $h) (i32.const 31)) (call $cc (local.get $s) (local.get $i))))
     (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))) (local.get $h))
 (func (export "newBytes") (param i32) (result externref) (extern.convert_any (array.new_default $b (local.get 0))))
 (func (export "setb") (param externref i32 i32) (array.set $b (ref.cast (ref $b) (any.convert_extern (local.get 0))) (local.get 1) (local.get 2)))
 (func (export "toJs") (param $n i32) (result externref) (local $a (ref $c))
   (local.set $a (array.new_default $c (local.get $n))) (call $fca (local.get $a) (i32.const 0) (local.get $n)))
 ;; copy GC byte array out into linear memory at 0
 (func (export "copyOut") (param externref) (param $n i32) (local $i i32) (local $a (ref $b))
   (local.set $a (ref.cast (ref $b) (any.convert_extern (local.get 0))))
   (loop $l (i32.store8 (local.get $i) (array.get_u $b (local.get $a) (local.get $i)))
     (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n)))))
 (func (export "copyIn") (param externref) (param $n i32) (local $i i32) (local $a (ref $b))
   (local.set $a (ref.cast (ref $b) (any.convert_extern (local.get 0))))
   (loop $l (array.set $b (local.get $a) (local.get $i) (i32.load8_u (local.get $i)))
     (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))))`);
const r = await inChrome(async ({ w }) => {
  const out = {};
  const mem = new WebAssembly.Memory({ initial: 64 });
  const inst = await WebAssembly.instantiate(new Uint8Array(w), { env: { mem } }, { builtins: ["js-string"] });
  const e = inst.instance.exports;
  const o = e.mkobj(); out.typeof_gc_ref_in_js = typeof o; out.get = e.get(o);
  try { out.frozen = Object.isFrozen(o); out.proto = Object.getPrototypeOf(o); } catch (x) { out.protoErr = String(x); }
  try { const wr = new WeakRef(o); out.weakref_ok = wr.deref() === o; } catch (x) { out.weakref = String(x).slice(0, 80); }
  try { const wm = new WeakMap(); wm.set(o, 1); out.weakmap_ok = wm.get(o) === 1; } catch (x) { out.weakmap = String(x).slice(0, 80); }
  try { const fr = new FinalizationRegistry(() => {}); fr.register(o, 1); out.finreg_ok = true; } catch (x) { out.finreg = String(x).slice(0, 80); }
  try { o.foo = 1; out.expando = o.foo; } catch (x) { out.expando = String(x).slice(0, 60); }
  // finalization actually fires?
  let fired = 0; const fr2 = new FinalizationRegistry(() => fired++);
  (() => { for (let i = 0; i < 1000; i++) fr2.register(e.mkobj(), i); })();
  await new Promise(r => setTimeout(r, 100)); if (typeof gc === "function") gc(); const a = new Array(1e6).fill(0).map((_, i) => ({ i })); await new Promise(r => setTimeout(r, 500)); out.finalizers_fired_of_1000 = fired;
  // strings
  const s = "hello world, this is a typical java string of ~48 chars".repeat(1);
  const t = (f, n) => { const a = performance.now(); f(n); return +((performance.now() - a) * 1e6 / n).toFixed(1); };
  out.hash_wasm_loop_via_builtins_ns_per_str = t((n) => { let x = 0; for (let i = 0; i < n; i++) x += e.hash(s); return x; }, 1e6);
  out.hash_js_ns_per_str = t((n) => { let x = 0; for (let i = 0; i < n; i++) { let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0; x += h; } return x; }, 1e6);
  // byte array interop
  for (const n of [64, 4096, 262144]) {
    const arr = e.newBytes(n); const view = new Uint8Array(mem.buffer, 0, n);
    out["copyOut_ns_per_byte_" + n] = +(t((k) => { for (let i = 0; i < k; i++) e.copyOut(arr, n); }, 2000) / n).toFixed(3);
    out["copyIn_ns_per_byte_" + n] = +(t((k) => { for (let i = 0; i < k; i++) e.copyIn(arr, n); }, 2000) / n).toFixed(3);
  }
  out.jsToWasmCall_ns = t((k) => { for (let i = 0; i < k; i++) e.get(o); }, 1e7);
  out.toJsString_4k_chars_ns = t((k) => { for (let i = 0; i < k; i++) e.toJs(4096); }, 20000);
  return out;
}, { w: [...w] });
console.log(JSON.stringify(r, null, 1));
