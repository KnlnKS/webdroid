import { wat, inChrome } from "./lib.mjs";
// long math + virtual dispatch (4 receiver classes) + instanceof
const w = wat(`(module
 (rec (type $vt (struct (field (ref $f)) ))
 (type $f (func (param (ref null $o) i32) (result i32)))
 (type $o (sub (struct (field (ref $vt)) (field $x (mut i32)))))
 (type $arr (array (mut (ref null $o)))))
 (func $fa (type $f) (i32.add (local.get 1) (struct.get $o 1 (local.get 0))))
 (func $fb (type $f) (i32.xor (local.get 1) (struct.get $o 1 (local.get 0))))
 (func $fc (type $f) (i32.sub (local.get 1) (i32.const 3)))
 (func $fd (type $f) (i32.mul (local.get 1) (i32.const 3)))
 (global $va (ref $vt) (struct.new $vt (ref.func $fa)))
 (global $vb (ref $vt) (struct.new $vt (ref.func $fb)))
 (global $vc (ref $vt) (struct.new $vt (ref.func $fc)))
 (global $vd (ref $vt) (struct.new $vt (ref.func $fd)))
 (elem declare func $fa $fb $fc $fd)
 (table $tab 4 funcref) (elem (table $tab) (i32.const 0) func $fa $fb $fc $fd)
 (func (export "xor") (param $n i32) (result i64) (local $s i64) (local $i i32)
   (local.set $s (i64.const 88172645463325252))
   (loop $l (local.set $s (i64.xor (local.get $s) (i64.shl (local.get $s) (i64.const 13))))
     (local.set $s (i64.xor (local.get $s) (i64.shr_u (local.get $s) (i64.const 7))))
     (local.set $s (i64.xor (local.get $s) (i64.shl (local.get $s) (i64.const 17))))
     (br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
   (local.get $s))
 (func (export "mkarr") (result (ref $arr)) (local $i i32) (local $a (ref $arr))
   (local.set $a (array.new_default $arr (i32.const 1024)))
   (loop $l
     (array.set $arr (local.get $a) (local.get $i) (struct.new $o (select (result (ref $vt)) (global.get $va) (global.get $vb) (i32.and (local.get $i) (i32.const 1))) (local.get $i)))
     (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (i32.const 1024))))
   (local.get $a))
 (func (export "virt_callref") (param $a (ref $arr)) (param $n i32) (result i32) (local $s i32) (local $i i32) (local $o (ref null $o))
   (loop $l
     (local.set $o (array.get $arr (local.get $a) (i32.and (local.get $i) (i32.const 1023))))
     (local.set $s (call_ref $f (local.get $o) (local.get $s) (struct.get $vt 0 (struct.get $o 0 (local.get $o)))))
     (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
   (local.get $s))
)`);
const r = await inChrome(async ({ w }) => {
  const out = {}; const time = (f) => { f(); const t = []; for (let i = 0; i < 5; i++) { const a = performance.now(); f(); t.push(performance.now() - a); } t.sort((a,b)=>a-b); return +t[2].toFixed(1); };
  const e = (await WebAssembly.instantiate(new Uint8Array(w))).instance.exports;
  const N = 30_000_000;
  out.xor_wasm_i64 = time(() => e.xor(N));
  const jsx = (n) => { let s = 88172645463325252n; do { s = BigInt.asIntN(64, s ^ BigInt.asIntN(64, s << 13n)); s = BigInt.asIntN(64, s ^ (BigInt.asUintN(64, s) >> 7n)); s = BigInt.asIntN(64, s ^ BigInt.asIntN(64, s << 17n)); } while (--n); return s; };
  out.xor_js_bigint = time(() => jsx(N/10)) * 10;
  out.xor_agree = jsx(1000) === e.xor(1000);
  // js virtual: 2 classes
  class A { constructor(x){this.x=x;} f(v){return (v+this.x)|0;} } class B { constructor(x){this.x=x;} f(v){return v^this.x;} }
  const arr = Array.from({length:1024},(_, i)=> i&1 ? new B(i) : new A(i));
  const jv = (n) => { let s=0; for (let i=0;i<n;i++) s = arr[i&1023].f(s); return s; };
  const wa = e.mkarr();
  out.virt_js_2cls = time(() => jv(50_000_000));
  out.virt_wasm_callref_2cls = time(() => e.virt_callref(wa, 50_000_000));
  out.virt_agree = jv(5000) === e.virt_callref(wa, 5000);
  return out;
}, { w: [...w] });
console.log(JSON.stringify(r));
