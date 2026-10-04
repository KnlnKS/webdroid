import { wat, inChrome } from "./lib.mjs";
const gc = wat(`(module
 (type $node (struct (field $l (mut (ref null $node))) (field $r (mut (ref null $node))) (field $v (mut i32))))
 (func $mk (param $d i32) (result (ref $node))
   (if (result (ref $node)) (i32.eqz (local.get $d))
     (then (struct.new $node (ref.null $node) (ref.null $node) (i32.const 1)))
     (else (struct.new $node (call $mk (i32.sub (local.get $d) (i32.const 1))) (call $mk (i32.sub (local.get $d) (i32.const 1))) (i32.const 1)))))
 (func $sum (param $n (ref null $node)) (result i32)
   (if (result i32) (ref.is_null (local.get $n)) (then (i32.const 0))
     (else (i32.add (struct.get $node $v (local.get $n)) (i32.add (call $sum (struct.get $node $l (local.get $n))) (call $sum (struct.get $node $r (local.get $n))))))))
 (func (export "run") (param $d i32) (param $reps i32) (result i32) (local $s i32)
   (loop $lp (local.set $s (i32.add (local.get $s) (call $sum (call $mk (local.get $d)))))
     (br_if $lp (local.tee $reps (i32.sub (local.get $reps) (i32.const 1)))))
   (local.get $s)))`);
// linear memory, bump allocator, no GC (upper bound for linear model)
const lin = wat(`(module (memory (export "m") 8192) (global $hp (mut i32) (i32.const 16))
 (func $mk (param $d i32) (result i32) (local $o i32)
   (local.set $o (global.get $hp)) (global.set $hp (i32.add (local.get $o) (i32.const 16)))
   (i32.store offset=12 (local.get $o) (i32.const 1)) (i64.store (local.get $o) (i64.const 0))
   (if (local.get $d) (then
     (i32.store (local.get $o) (call $mk (i32.sub (local.get $d) (i32.const 1))))
     (i32.store offset=4 (local.get $o) (call $mk (i32.sub (local.get $d) (i32.const 1))))))
   (local.get $o))
 (func $sum (param $n i32) (result i32)
   (if (result i32) (i32.eqz (local.get $n)) (then (i32.const 0))
     (else (i32.add (i32.load offset=12 (local.get $n)) (i32.add (call $sum (i32.load (local.get $n))) (call $sum (i32.load offset=4 (local.get $n))))))))
 (func (export "run") (param $d i32) (param $reps i32) (result i32) (local $s i32)
   (loop $lp (global.set $hp (i32.const 16)) (local.set $s (i32.add (local.get $s) (call $sum (call $mk (local.get $d)))))
     (br_if $lp (local.tee $reps (i32.sub (local.get $reps) (i32.const 1)))))
   (local.get $s)))`);
const r = await inChrome(async ({gc, lin}) => {
  const out = {};
  const D = 18, R = 20;
  class N { constructor(l, r) { this.l = l; this.r = r; this.v = 1; } }
  const mk = d => d === 0 ? new N(null, null) : new N(mk(d - 1), mk(d - 1));
  const sum = n => n === null ? 0 : n.v + sum(n.l) + sum(n.r);
  const js = (d, reps) => { let s = 0; while (reps-- > 0) s += sum(mk(d)); return s; };
  const time = (f) => { f(); const t = []; for (let i = 0; i < 5; i++) { const a = performance.now(); f(); t.push(performance.now() - a); } t.sort((a,b)=>a-b); return +t[2].toFixed(1); };
  out.js = time(() => js(D, R));
  const g = (await WebAssembly.instantiate(new Uint8Array(gc))).instance.exports;
  out.wasmgc = time(() => g.run(D, R));
  const l = (await WebAssembly.instantiate(new Uint8Array(lin))).instance.exports;
  out.linear_bump_nogc = time(() => l.run(D, R));
  out.check = [js(4,1), g.run(4,1), l.run(4,1)];
  return out;
}, { gc: [...gc], lin: [...lin] });
console.log(JSON.stringify(r));
