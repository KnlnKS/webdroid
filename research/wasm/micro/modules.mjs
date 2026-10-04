import { wat, inChrome } from "./lib.mjs";
// shared prelude: rec group with base object type; subclass types per module declared as sub of the canonical base
const prelude = `(rec (type $Obj (sub (struct (field i32) (field (mut i32))))))
 (type $F (func (param (ref null $Obj)) (result i32)))`;
const modA = wat(`(module ${prelude}
 (import "env" "tab" (table 100000 funcref))
 (func (export "isObj") (param anyref) (result i32) (ref.test (ref $Obj) (local.get 0)))
 (func (export "callSlot") (param $o (ref null $Obj)) (param $slot i32) (result i32) (call_indirect (type $F) (local.get $o) (local.get $slot)))
 (func (export "mkBase") (param i32) (result anyref) (struct.new $Obj (local.get 0) (i32.const 0))))`);
const mkSub = (i) => wat(`(module ${prelude}
 (rec (type $Sub${i} (sub $Obj (struct (field i32) (field (mut i32)) (field (mut i32))))))
 (import "env" "tab" (table 100000 funcref))
 (func $m (type $F) (i32.add (struct.get $Obj 1 (local.get 0)) (i32.const ${i})))
 (elem (i32.const ${i}) func $m)
 (func (export "mk") (param i32) (result anyref) (struct.new $Sub${i} (local.get 0) (i32.const 1) (i32.const 2)))
 (func (export "isSub") (param anyref) (result i32) (ref.test (ref $Sub${i}) (local.get 0))))`);
const subs = []; for (let i = 0; i < 1000; i++) subs.push([...mkSub(i)]);
const r = await inChrome(async ({ modA, subs }) => {
  const out = {};
  const tab = new WebAssembly.Table({ element: "anyfunc", initial: 100000 });
  const A = (await WebAssembly.instantiate(new Uint8Array(modA), { env: { tab } })).instance.exports;
  let t = performance.now();
  const insts = [];
  for (const s of subs) { const m = new WebAssembly.Module(new Uint8Array(s)); insts.push(new WebAssembly.Instance(m, { env: { tab } }).exports); }
  out.compile_instantiate_1000_tiny_modules_ms = +(performance.now() - t).toFixed(1);
  const o5 = insts[5].mk(10);
  out.crossModule_base_test = A.isObj(o5);                 // sub object seen as base in module A
  out.sub_not_other_sub = insts[6].isSub(o5);              // distinct sub type
  out.sub_is_sub = insts[5].isSub(o5);
  out.callViaSharedTable = A.callSlot(o5, 5);              // module A calls module-5's function
  out.base_is_not_sub = insts[5].isSub(A.mkBase(1));
  // call cost across modules via shared table
  const o = insts[7].mk(3); let s = 0;
  t = performance.now(); for (let i = 0; i < 1e7; i++) s += A.callSlot(o, 7); out.js_to_wasm_plus_indirect_ns = +((performance.now() - t) * 1e6 / 1e7).toFixed(1);
  return out;
}, { modA: [...modA], subs });
console.log(JSON.stringify(r, null, 1));
