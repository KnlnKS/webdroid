import { wat, inChrome } from "./lib.mjs";
const w = wat(`(module
 (type $o (struct (field (mut (ref null $o))) (field (mut i32)) (field (mut i32)) (field (mut (ref null $o)))))
 (type $o2 (struct (field (mut i32)) (field (mut i32))))
 (global $sink (mut (ref null $o)) (ref.null $o))
 (global $sink2 (mut (ref null $o2)) (ref.null $o2))
 (func (export "flat") (param $n i32) (local $i i32)
   (loop $l (global.set $sink (struct.new $o (ref.null $o) (local.get $i) (i32.const 0) (ref.null $o)))
     (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n)))))
 (func (export "flat_prim") (param $n i32) (local $i i32)
   (loop $l (global.set $sink2 (struct.new $o2 (local.get $i) (i32.const 0)))
     (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n)))))
 (func (export "chain") (param $n i32) (local $i i32) (local $t (ref null $o))
   (loop $l (local.set $t (struct.new $o (local.get $t) (local.get $i) (i32.const 0) (ref.null $o)))
     (if (i32.eqz (i32.and (local.get $i) (i32.const 255))) (then (global.set $sink (local.get $t)) (local.set $t (ref.null $o))))
     (br_if $l (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))))`);
const r = await inChrome(async ({ w }) => {
  const e = (await WebAssembly.instantiate(new Uint8Array(w))).instance.exports;
  class O { constructor(p, i) { this.p = p; this.i = i; this.c = 0; this.d = null; } }
  class O2 { constructor(i) { this.i = i; this.c = 0; } }
  let sink = null, sink2 = null;
  const tm = (f) => { f(); const a = []; for (let k = 0; k < 5; k++) { const t = performance.now(); f(); a.push(performance.now() - t); } a.sort((x,y)=>x-y); return +a[2].toFixed(0); };
  const N = 50_000_000;
  return {
    wasm_flat: tm(() => e.flat(N)), js_flat: tm(() => { for (let i = 0; i < N; i++) sink = new O(null, i); }),
    wasm_flat_prim: tm(() => e.flat_prim(N)), js_flat_prim: tm(() => { for (let i = 0; i < N; i++) sink2 = new O2(i); }),
    wasm_chain: tm(() => e.chain(N)), js_chain: tm(() => { let t = null; for (let i = 0; i < N; i++) { t = new O(t, i); if ((i & 255) === 0) { sink = t; t = null; } } }),
  };
}, { w: [...w] });
console.log(JSON.stringify(r));
